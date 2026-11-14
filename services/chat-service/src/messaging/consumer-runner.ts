import type { ConsumeMessage, Options } from 'amqplib';
import { correlationOf, createCorrelatedLogger, currentCorrelationId, runWithCorrelation } from '../observability/correlation';
import { classifyError, delayForRetry, describeError, type RetryPolicy } from './retry-policy';
import { assertTopology, DEAD_LETTER_EXCHANGE, type ConsumerSpec, type QueueNames, retryQueueFor, type TopologyChannel } from './topology';

/** The part of an amqplib ConfirmChannel the runner uses. A real ConfirmChannel satisfies it; so does the fake in mock-services/amqp. */
export interface RunnerChannel extends TopologyChannel {
  consume(queue: string, onMessage: (msg: ConsumeMessage | null) => void): Promise<unknown>;
  ack(msg: ConsumeMessage): void;
  nack(msg: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void;
  publish(exchange: string, routingKey: string, content: Buffer, options?: Options.Publish): boolean;
  waitForConfirms(): Promise<void>;
}

export type Handler = (routingKey: string, payload: unknown) => Promise<void>;

export interface Logger {
  info(message: string): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface RunnerOptions {
  policy: RetryPolicy;
  log?: Logger;
  now?: () => Date;
  /** If republishing a failed message itself fails, wait this long before giving the message back to the queue. */
  requeueDelayMs?: number;
}

/** Header names. The x-error-* / x-failure-* / x-original-* / x-retry-count ones are what a person reads when triaging the DLQ. */
export const H = {
  retryCount: 'x-retry-count',
  originalRoutingKey: 'x-original-routing-key',
  originalQueue: 'x-original-queue',
  failureKind: 'x-failure-kind',
  errorClass: 'x-error-class',
  error: 'x-error',
  errorStack: 'x-error-stack',
  firstFailedAt: 'x-first-failed-at',
  failedAt: 'x-failed-at',
  correlationId: 'x-correlation-id',
} as const;

const consoleLogger: Logger = createCorrelatedLogger();

/** Declares the topology, then handles every message of the queue with retry and dead-lettering. */
export async function startConsumer(ch: RunnerChannel, spec: ConsumerSpec, handler: Handler, opts: RunnerOptions): Promise<QueueNames> {
  const names = await assertTopology(ch, spec, opts.policy);
  await ch.consume(spec.queue, (msg) => {
    if (msg) void processMessage(ch, spec, names, handler, opts, msg);
  });
  return names;
}

/**
 * One delivery, start to finish. NEVER throws and NEVER loses the message:
 *   handler succeeds                         -> ack
 *   fails, transient, retries left           -> copy to the retry queue for the next backoff step (confirmed), then ack the original
 *   fails, permanent or retries used up      -> copy to the dead-letter exchange with the error in headers (confirmed), then ack the original
 *   the copy itself cannot be published      -> give the original back to the queue (nack with requeue), so nothing is dropped
 */
export function processMessage(
  ch: RunnerChannel, spec: ConsumerSpec, names: QueueNames, handler: Handler, opts: RunnerOptions, msg: ConsumeMessage,
): Promise<void> {
  // The whole delivery (the handler, every log line, the retry or dead-letter copy) runs under the id the message arrived with.
  return runWithCorrelation(correlationOf(msg), () => processDelivery(ch, spec, names, handler, opts, msg));
}

async function processDelivery(
  ch: RunnerChannel, spec: ConsumerSpec, names: QueueNames, handler: Handler, opts: RunnerOptions, msg: ConsumeMessage,
): Promise<void> {
  const log = opts.log ?? consoleLogger;
  const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
  const retriesDone = Number(headers[H.retryCount] ?? 0) || 0;
  // A retried message comes back through the default exchange, so its own routing key is the queue name: the original key travels in a header.
  const routingKey = String(headers[H.originalRoutingKey] ?? msg.fields.routingKey);

  try {
    await handler(routingKey, JSON.parse(msg.content.toString('utf8')));
  } catch (err) {
    const kind = classifyError(err);
    const error = describeError(err);
    const now = (opts.now?.() ?? new Date()).toISOString();
    const base = withoutBrokerHeaders(headers);
    const failureHeaders = {
      ...base,
      [H.originalRoutingKey]: routingKey,
      [H.originalQueue]: spec.queue,
      [H.failureKind]: kind,
      [H.errorClass]: error.name,
      [H.error]: error.message,
      [H.errorStack]: error.stack,
      [H.firstFailedAt]: String(headers[H.firstFailedAt] ?? now),
      [H.failedAt]: now,
      [H.correlationId]: currentCorrelationId(),
    };
    const publishOptions = (extra: Record<string, unknown>): Options.Publish => ({
      persistent: true,
      contentType: msg.properties.contentType,
      messageId: msg.properties.messageId,
      headers: { ...failureHeaders, ...extra },
    });

    try {
      if (kind === 'transient' && retriesDone < opts.policy.maxAttempts) {
        const delayMs = delayForRetry(opts.policy, retriesDone + 1);
        ch.publish('', retryQueueFor(names, delayMs), msg.content, publishOptions({ [H.retryCount]: retriesDone + 1 }));
        await ch.waitForConfirms();
        ch.ack(msg);
        log.warn(`[events] ${spec.queue} ${routingKey}: ${error.name}: ${error.message}; retry ${retriesDone + 1}/${opts.policy.maxAttempts} in ${delayMs}ms`);
      } else {
        ch.publish(DEAD_LETTER_EXCHANGE, names.dlqRoutingKey, msg.content, publishOptions({ [H.retryCount]: retriesDone }));
        await ch.waitForConfirms();
        ch.ack(msg);
        log.error(`[events] ${spec.queue} ${routingKey}: dead-lettered to ${names.dlq} (${kind}, after ${retriesDone} retries): ${error.name}: ${error.message}`);
      }
    } catch (publishError) {
      log.error(`[events] ${spec.queue} ${routingKey}: could not move a failed message (${(publishError as Error).message}); giving it back to the queue`);
      if (opts.requeueDelayMs) await new Promise((r) => setTimeout(r, opts.requeueDelayMs));
      try { ch.nack(msg, false, true); } catch { /* the channel is gone: the broker requeues the unacked message by itself */ }
    }
    return;
  }

  // The handler succeeded. If the ack cannot be sent (the channel closed under us) the broker redelivers the message: safe, consumers are idempotent.
  try {
    ch.ack(msg);
  } catch (ackError) {
    log.warn(`[events] ${spec.queue} ${routingKey}: handled, but the ack could not be sent (${(ackError as Error).message}); the broker will redeliver it`);
  }
}

/** The broker adds x-death & co. when it dead-letters a message; they are rebuilt by the broker, so they are not copied forward. */
function withoutBrokerHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith('x-death') && !k.startsWith('x-first-death') && !k.startsWith('x-last-death')));
}
