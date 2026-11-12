import amqp from 'amqplib';
import { z } from 'zod';
import type { ChatService } from '../core/chat-service';
import { type Handler, type RunnerChannel, startConsumer } from './consumer-runner';
import type { Log } from '../resilience/process-guards';
import { type RetryPolicy, reconnectDelayMs, retryPolicyFromEnv } from './retry-policy';
import type { ConsumerSpec } from './topology';

export const TransferCompleted = z.object({
  version: z.number().optional(),
  transferId: z.string(),
  intentId: z.string().nullish(),
  kind: z.string().nullish(),
  fromUserId: z.string(),
  toUserId: z.string(),
  amountMinor: z.number().int().positive(),
  currency: z.string(),
  note: z.string().nullish(),
  referenceType: z.string().nullish(),
  referenceId: z.string().nullish(),
  occurredAt: z.string().optional(),
});   // unknown extra fields are ignored => producers can add fields without breaking us

export const OrderPaid = z.object({
  version: z.number().optional(),
  orderId: z.string(),
  storeId: z.string(),
  storeName: z.string(),
  buyerUserId: z.string(),
  recipientUserId: z.string().nullish(),
  totalMinor: z.number().int().nonnegative(),
  currency: z.string(),
  items: z.array(z.object({
    name: z.string(), quantity: z.number().int(), unitPriceMinor: z.number().int(), imageUrl: z.string().nullish().transform((v) => v ?? null),
  })),
  context: z.object({ type: z.string(), roomId: z.string() }).nullish(),
  occurredAt: z.string().optional(),
});

export const StoreOpened = z.object({ ownerUserId: z.string(), storeId: z.string(), name: z.string(), slug: z.string() });
export const StoreClosed = z.object({ ownerUserId: z.string(), storeId: z.string() });

export interface BrokerConfig {
  url: string;
  walletExchange: string;
  walletQueue: string;
  storeExchange: string;
  storeQueue: string;
}

interface Binding extends ConsumerSpec {
  handle: Handler;
}

/**
 * Consumes wallet events (payment bubbles) and store events (store icon on contacts, gift-order bubbles).
 * Each queue is durable, so events wait while the chat is down. Failures are retried with exponential backoff and then dead-lettered
 * (see consumer-runner.ts and topology.ts), so no message is ever silently dropped. Retries the broker connection forever so the
 * chat keeps working without these features while RabbitMQ is down.
 */
export function startEventConsumers(cfg: BrokerConfig, chat: ChatService, policy: RetryPolicy = retryPolicyFromEnv()) {
  const bindings: Binding[] = [
    {
      exchange: cfg.walletExchange, queue: cfg.walletQueue, routingKeys: ['transfer.completed'],
      handle: async (_key, payload) => { await chat.applyTransferCompleted(TransferCompleted.parse(payload)); },
    },
    {
      exchange: cfg.storeExchange, queue: cfg.storeQueue, routingKeys: ['store.opened', 'store.closed', 'order.paid'],
      handle: async (key, payload) => {
        if (key === 'store.opened') await chat.applyStoreOpened(StoreOpened.parse(payload));
        else if (key === 'store.closed') await chat.applyStoreClosed(StoreClosed.parse(payload));
        else if (key === 'order.paid') await chat.applyOrderPaid(OrderPaid.parse(payload));
      },
    },
  ];
  connectLoop(cfg.url, bindings, policy).catch((err) => console.error('[events] the connection loop stopped unexpectedly', err));
}

export interface ChannelHandle extends RunnerChannel {
  prefetch(count: number): Promise<unknown> | unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface AmqpConnectionLike {
  createConfirmChannel(): Promise<ChannelHandle>;
  close(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface LoopDeps {
  connect?: (url: string) => Promise<AmqpConnectionLike>;
  sleep?: (ms: number) => Promise<void>;
  log?: Log;
  /** Lets a test end the loop; in production it runs forever. */
  stop?: AbortSignal;
}

/**
 * Keeps the consumers running across RabbitMQ outages, forever:
 *  - cannot connect: log it, wait 1s, 2s, 4s ... 30s, try again (the wait restarts from 1s once a session worked);
 *  - the CONNECTION or just the CHANNEL is lost mid-session (broker restart, a server-side channel close): tear everything down and start over,
 *    so the consumers are never left silently dead on a half-open connection;
 *  - 'error' events on the connection and the channel are listened to: an emitter without an 'error' listener throws, which would kill the process.
 */
export async function connectLoop(url: string, bindings: Binding[], policy: RetryPolicy, deps: LoopDeps = {}): Promise<void> {
  const connect = deps.connect ?? ((u: string) => amqp.connect(u) as unknown as Promise<AmqpConnectionLike>);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? console;
  let failures = 0;

  while (!deps.stop?.aborted) {
    let conn: AmqpConnectionLike | undefined;
    try {
      conn = await connect(url);
      let lose!: (why: string) => void;
      const lost = new Promise<string>((resolve) => { lose = resolve; });
      conn.on('error', (e: Error) => log.warn(`[events] connection error: ${e.message}`));
      conn.on('close', () => lose('the connection closed'));
      const channel = await conn.createConfirmChannel();        // publisher confirms: a failed message is only acked once its copy is safely stored
      channel.on('error', (e: Error) => log.warn(`[events] channel error: ${e.message}`));
      channel.on('close', () => lose('the channel closed'));
      await channel.prefetch(10);
      for (const b of bindings) {
        const names = await startConsumer(channel, b, b.handle, { policy });
        log.info(`[events] consuming ${b.queue} <- ${b.exchange} (${b.routingKeys.join(', ')}); retries: ${names.retryQueues.map((r) => r.delayMs + 'ms').join(', ')}; dead letters: ${names.dlq}`);
      }
      failures = 0;
      log.warn(`[events] ${await lost}; reconnecting`);
    } catch (err) {
      failures++;
      const message = (err as Error).message;
      if (/PRECONDITION/i.test(message)) {
        log.error('[events] A queue already exists with different settings (it was created before dead-lettering was added). '
          + 'Delete the chat queues once and restart: scripts/reset-chat-queues.sh --yes. Details: ' + message);
      } else {
        log.warn(`[events] cannot reach RabbitMQ (${message}); retrying in ${reconnectDelayMs(failures)}ms`);
      }
    } finally {
      await conn?.close().catch(() => undefined);
    }
    if (deps.stop?.aborted) return;
    await sleep(reconnectDelayMs(Math.max(failures, 1)));
  }
}
