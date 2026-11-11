import type { GetMessage, Message, Options } from 'amqplib';
import { H } from '../messaging/consumer-runner';

/**
 * Operating on dead letters: look at them, and put them back on their original queue once the cause is fixed.
 * Works on any dead-letter queue that follows our header convention (chat-service, and the store backend, which writes the same headers).
 * Replaying is deliberate and manual: nothing here ever runs on a timer, and a message that fails again is dead-lettered again.
 */
export interface DlqChannel {
  get(queue: string, options?: { noAck?: boolean }): Promise<GetMessage | false>;
  ack(msg: Message): void;
  nack(msg: Message, allUpTo?: boolean, requeue?: boolean): void;
  publish(exchange: string, routingKey: string, content: Buffer, options?: Options.Publish): boolean;
  waitForConfirms(): Promise<void>;
}

export interface DeadLetter {
  position: number;
  originalQueue?: string;
  originalRoutingKey?: string;
  failureKind?: string;
  errorClass?: string;
  error?: string;
  retryCount: number;
  replayCount: number;
  firstFailedAt?: string;
  failedAt?: string;
  messageId?: string;
  bytes: number;
  preview: string;
}

const REPLAY = { replayCount: 'x-replay-count', replayedAt: 'x-replayed-at', replayedFrom: 'x-replayed-from' } as const;

const text = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));
const headersOf = (msg: Message) => (msg.properties.headers ?? {}) as Record<string, unknown>;

export function summarize(msg: Message, position: number): DeadLetter {
  const h = headersOf(msg);
  const body = msg.content.toString('utf8');
  return {
    position,
    originalQueue: text(h[H.originalQueue]),
    originalRoutingKey: text(h[H.originalRoutingKey]),
    failureKind: text(h[H.failureKind]),
    errorClass: text(h[H.errorClass]),
    error: text(h[H.error]),
    retryCount: Number(h[H.retryCount] ?? 0) || 0,
    replayCount: Number(h[REPLAY.replayCount] ?? 0) || 0,
    firstFailedAt: text(h[H.firstFailedAt]),
    failedAt: text(h[H.failedAt]),
    messageId: text(msg.properties.messageId),
    bytes: msg.content.length,
    preview: body.length > 120 ? body.slice(0, 117) + '...' : body,
  };
}

/** Looks at up to `limit` dead letters. They are put back exactly where they were: listing changes nothing. */
export async function listDeadLetters(ch: DlqChannel, queue: string, opts: { limit?: number } = {}): Promise<DeadLetter[]> {
  const limit = opts.limit ?? 50;
  const held: Message[] = [];
  const found: DeadLetter[] = [];
  try {
    while (held.length < limit) {
      const msg = await ch.get(queue, { noAck: false });
      if (!msg) break;
      held.push(msg);
      found.push(summarize(msg, held.length));
    }
  } finally {
    if (held.length) ch.nack(held[held.length - 1], true, true);
  }
  return found;
}

export interface ReplayOptions {
  /** At most this many messages are replayed. */
  limit: number;
  /** Only messages whose body, error, or message id contains this text. */
  match?: string;
  /** Send them to this queue instead of the one named in their x-original-queue header (needed for old-format dead letters). */
  to?: string;
  /** Show what would happen without moving anything. */
  dryRun: boolean;
  now?: () => Date;
}

export interface ReplayResult {
  replayed: number;
  wouldReplay: number;
  skipped: { position: number; reason: string }[];
  stoppedBecause?: string;
}

const NOT_CARRIED_OVER = new Set<string>([H.retryCount, H.failureKind, H.errorClass, H.error, H.errorStack, H.firstFailedAt, H.failedAt]);
const isBrokerHeader = (k: string) => k.startsWith('x-death') || k.startsWith('x-first-death') || k.startsWith('x-last-death');

/**
 * Puts dead letters back on their original queue, oldest first, each with a fresh retry budget (the failure headers are dropped, the original
 * routing key is kept, and x-replay-count / x-replayed-at / x-replayed-from record that a person did this). A copy is confirmed by the broker
 * before the dead letter is removed, so a failure part-way leaves the rest in the dead-letter queue. Messages that are not replayed are given
 * back untouched.
 */
export async function replayDeadLetters(ch: DlqChannel, dlq: string, opts: ReplayOptions): Promise<ReplayResult> {
  const result: ReplayResult = { replayed: 0, wouldReplay: 0, skipped: [] };
  const held: Message[] = [];
  let position = 0;
  try {
    while (result.replayed + result.wouldReplay < opts.limit) {
      const msg = await ch.get(dlq, { noAck: false });
      if (!msg) break;
      position++;
      const headers = headersOf(msg);
      const target = opts.to ?? text(headers[H.originalQueue]);
      const reason = !target
        ? 'no x-original-queue header (an old-format dead letter): pass --to <queue>'
        : opts.match && !matches(msg, opts.match) ? 'does not match' : undefined;
      if (reason || opts.dryRun) {
        held.push(msg);
        if (reason) result.skipped.push({ position, reason }); else result.wouldReplay++;
        continue;
      }
      try {
        const kept = Object.fromEntries(Object.entries(headers).filter(([k]) => !NOT_CARRIED_OVER.has(k) && !isBrokerHeader(k)));
        ch.publish('', target!, msg.content, {
          persistent: true,
          contentType: msg.properties.contentType,
          messageId: msg.properties.messageId,
          headers: {
            ...kept,
            [REPLAY.replayCount]: (Number(headers[REPLAY.replayCount] ?? 0) || 0) + 1,
            [REPLAY.replayedAt]: (opts.now?.() ?? new Date()).toISOString(),
            [REPLAY.replayedFrom]: dlq,
          },
        });
        await ch.waitForConfirms();
        ch.ack(msg);
        result.replayed++;
      } catch (err) {
        held.push(msg);
        result.stoppedBecause = `could not put a message back on ${target}: ${(err as Error).message}. It is still in ${dlq}.`;
        break;
      }
    }
  } finally {
    if (held.length) ch.nack(held[held.length - 1], true, true);
  }
  return result;
}

function matches(msg: Message, needle: string): boolean {
  const h = headersOf(msg);
  return [msg.content.toString('utf8'), text(h[H.error]), msg.properties.messageId].some((v) => v !== undefined && String(v).includes(needle));
}
