import amqp from 'amqplib';
import { z } from 'zod';
import type { ChatService } from '../core/chat-service';

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

interface Binding {
  exchange: string;
  queue: string;
  routingKeys: string[];
  handle: (routingKey: string, payload: unknown) => Promise<void>;
}

/**
 * Consumes wallet events (payment bubbles) and store events (store icon on contacts, gift-order bubbles).
 * Each queue is durable, so events wait while the chat is down. Retries the broker connection forever so the
 * chat keeps working without these features while RabbitMQ is down.
 */
export function startEventConsumers(cfg: BrokerConfig, chat: ChatService) {
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
  void connectLoop(cfg.url, bindings);
}

async function connectLoop(url: string, bindings: Binding[]) {
  for (;;) {
    try {
      const conn = await amqp.connect(url);
      const channel = await conn.createChannel();
      await channel.prefetch(10);
      for (const b of bindings) {
        await channel.assertExchange(b.exchange, 'topic', { durable: true });
        await channel.assertQueue(b.queue, { durable: true });
        for (const key of b.routingKeys) await channel.bindQueue(b.queue, b.exchange, key);
        await channel.consume(b.queue, async (msg) => {
          if (!msg) return;
          try {
            await b.handle(msg.fields.routingKey, JSON.parse(msg.content.toString('utf8')));
            channel.ack(msg);
          } catch (err) {
            // Malformed or unprocessable: drop it (TODO: route to a dead-letter queue, see CHECKLIST).
            console.error(`[events] failed to process ${msg.fields.routingKey}`, err);
            channel.nack(msg, false, false);
          }
        });
        console.log(`[events] consuming ${b.queue} <- ${b.exchange} (${b.routingKeys.join(', ')})`);
      }
      await new Promise<void>((resolve) => {
        conn.on('close', () => { console.error('[events] connection closed, reconnecting'); resolve(); });
        conn.on('error', (e: Error) => console.error('[events] connection error', e.message));
      });
    } catch (err) {
      console.error('[events] connect failed, retrying in 5s:', (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
