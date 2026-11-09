import { type RetryPolicy, retryDelays } from './retry-policy';

/** The one dead-letter exchange for every chat queue. */
export const DEAD_LETTER_EXCHANGE = 'chat.dlx';

/** One consumed queue: where its messages come from. */
export interface ConsumerSpec {
  exchange: string;
  queue: string;
  routingKeys: string[];
}

export interface RetryQueue {
  delayMs: number;
  queue: string;
}

export interface QueueNames {
  main: string;
  dlq: string;
  dlqRoutingKey: string;
  retryQueues: RetryQueue[];
}

/** The minimal piece of an amqplib channel needed to declare topology (so it can be tested without a broker). */
export interface TopologyChannel {
  assertExchange(exchange: string, type: string, options?: Record<string, unknown>): Promise<unknown>;
  assertQueue(queue: string, options?: Record<string, unknown>): Promise<unknown>;
  bindQueue(queue: string, source: string, pattern: string): Promise<unknown>;
}

export function namesFor(queue: string, policy: RetryPolicy): QueueNames {
  return {
    main: queue,
    dlq: `${queue}.dlq`,
    dlqRoutingKey: `${queue}.dlq`,
    retryQueues: retryDelays(policy).map((delayMs) => ({ delayMs, queue: `${queue}.retry.${delayMs}ms` })),
  };
}

export function retryQueueFor(names: QueueNames, delayMs: number): string {
  const found = names.retryQueues.find((r) => r.delayMs === delayMs);
  if (!found) throw new Error(`no retry queue for a ${delayMs}ms delay`);
  return found.queue;
}

/**
 * Declares everything one consumer needs (idempotent):
 *
 *   <exchange> (topic) --routing keys--> <queue> ---fails with a transient error--> <queue>.retry.<delay>ms   (TTL = delay)
 *                                           ^                                               |
 *                                           +------------- message expires: back to <queue> -+
 *   <queue> --rejected, or retries used up--> chat.dlx (direct) --> <queue>.dlq   (waits for a person)
 *
 * The main queue ALSO carries x-dead-letter-exchange/-routing-key arguments, so anything that dead-letters a message at the broker level
 * (a plain reject, a crash-time nack without requeue) lands in the DLQ instead of vanishing.
 *
 * NOTE: RabbitMQ refuses to redeclare an existing queue with different arguments (PRECONDITION_FAILED). A queue created before dead-lettering
 * existed has to be deleted once: see scripts/reset-chat-queues.sh.
 */
export async function assertTopology(ch: TopologyChannel, spec: ConsumerSpec, policy: RetryPolicy): Promise<QueueNames> {
  const names = namesFor(spec.queue, policy);

  await ch.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
  await ch.assertQueue(names.dlq, { durable: true });
  await ch.bindQueue(names.dlq, DEAD_LETTER_EXCHANGE, names.dlqRoutingKey);

  for (const retry of names.retryQueues) {
    await ch.assertQueue(retry.queue, {
      durable: true,
      arguments: {
        'x-message-ttl': retry.delayMs,
        'x-dead-letter-exchange': '',                    // the default exchange...
        'x-dead-letter-routing-key': spec.queue,         // ...routes an expired message straight back to the main queue
      },
    });
  }

  await ch.assertExchange(spec.exchange, 'topic', { durable: true });
  await ch.assertQueue(spec.queue, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE, 'x-dead-letter-routing-key': names.dlqRoutingKey },
  });
  for (const key of spec.routingKeys) await ch.bindQueue(spec.queue, spec.exchange, key);

  return names;
}
