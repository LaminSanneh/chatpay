import amqp from 'amqplib';
import { z } from 'zod';
import type { ChatService } from '../core/chat-service';
import { type Handler, startConsumer } from './consumer-runner';
import { type RetryPolicy, retryPolicyFromEnv } from './retry-policy';
import type { ConsumerSpec } from './topology';

const TransferCompleted = z.object({
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

const OrderPaid = z.object({
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

const StoreOpened = z.object({ ownerUserId: z.string(), storeId: z.string(), name: z.string(), slug: z.string() });
const StoreClosed = z.object({ ownerUserId: z.string(), storeId: z.string() });

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
  void connectLoop(cfg.url, bindings, policy);
}

async function connectLoop(url: string, bindings: Binding[], policy: RetryPolicy) {
  for (;;) {
    let conn: Awaited<ReturnType<typeof amqp.connect>> | undefined;
    try {
      conn = await amqp.connect(url);
      const channel = await conn.createConfirmChannel();      // publisher confirms: a failed message is only acked once its copy is safely stored
      await channel.prefetch(10);
      for (const b of bindings) {
        const names = await startConsumer(channel, b, b.handle, { policy });
        console.log(`[events] consuming ${b.queue} <- ${b.exchange} (${b.routingKeys.join(', ')}); retries: ${names.retryQueues.map((r) => r.delayMs + 'ms').join(', ')}; dead letters: ${names.dlq}`);
      }
      const open = conn;
      await new Promise<void>((resolve) => {
        open.on('close', () => { console.error('[events] connection closed, reconnecting'); resolve(); });
        open.on('error', (e: Error) => console.error('[events] connection error', e.message));
      });
    } catch (err) {
      const message = (err as Error).message;
      if (/PRECONDITION/i.test(message)) {
        console.error('[events] A queue already exists with different settings (it was created before dead-lettering was added). '
          + 'Delete the chat queues once and restart: scripts/reset-chat-queues.sh --yes. Details: ' + message);
      } else {
        console.error('[events] connect failed, retrying in 5s:', message);
      }
      await conn?.close().catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
