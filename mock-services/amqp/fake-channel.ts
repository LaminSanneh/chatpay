/**
 * Permanent in-memory stand-in for an amqplib ConfirmChannel, for unit-testing consumers WITHOUT a broker.
 * It records what a consumer declares, publishes, acks and nacks, and lets a test deliver messages by hand.
 * It does NOT route messages or run TTLs: whether RabbitMQ really moves a message from a retry queue back to the main queue is proven by the
 * integration test (services/chat-service/tests/messaging.integration.test.ts) against a real broker.
 * Used by: services/chat-service/tests/consumer-runner.test.ts
 */
import type { ConsumeMessage, GetMessage, Options } from 'amqplib';

export interface Published {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: Options.Publish;
}

export interface Binding { queue: string; exchange: string; pattern: string }

export class FakeChannel {
  exchanges = new Map<string, { type: string; options: Record<string, unknown> }>();
  queues = new Map<string, Record<string, unknown>>();
  bindings: Binding[] = [];
  published: Published[] = [];
  acked: ConsumeMessage[] = [];
  nacked: { msg: ConsumeMessage; requeue: boolean }[] = [];
  consumers = new Map<string, (msg: ConsumeMessage | null) => void>();
  /** Messages waiting in each queue (see seed / get). Publishing to the default exchange ('') delivers into the queue named by the routing key. */
  stored = new Map<string, ConsumeMessage[]>();
  private pending = new Map<number, { queue: string; msg: ConsumeMessage }>();
  private nextTag = 1;
  /** Set to make the next publisher confirm fail, as if the broker refused to store the copy. */
  confirmError: Error | null = null;

  async assertExchange(exchange: string, type: string, options: Record<string, unknown> = {}) { this.exchanges.set(exchange, { type, options }); }
  async assertQueue(queue: string, options: Record<string, unknown> = {}) { this.queues.set(queue, options); }
  async bindQueue(queue: string, exchange: string, pattern: string) { this.bindings.push({ queue, exchange, pattern }); }
  async consume(queue: string, onMessage: (msg: ConsumeMessage | null) => void) { this.consumers.set(queue, onMessage); }

  ack(msg: ConsumeMessage) { this.acked.push(msg); this.pending.delete(msg.fields.deliveryTag); }
  nack(msg: ConsumeMessage, allUpTo = false, requeue = true) {
    this.nacked.push({ msg, requeue });
    const tags = allUpTo ? [...this.pending.keys()].filter((t) => t <= msg.fields.deliveryTag).sort((a, b) => a - b) : [msg.fields.deliveryTag];
    const released = tags.map((t) => this.pending.get(t)).filter((p): p is { queue: string; msg: ConsumeMessage } => !!p);
    for (const p of released) this.pending.delete(p.msg.fields.deliveryTag);
    if (requeue) for (const p of released.reverse()) this.stored.set(p.queue, [p.msg, ...(this.stored.get(p.queue) ?? [])]);   // back to the FRONT, in order
  }
  publish(exchange: string, routingKey: string, content: Buffer, options: Options.Publish = {}) {
    this.published.push({ exchange, routingKey, content, options });
    if (exchange === '') {
      const delivered = { content, fields: { consumerTag: 'fake', deliveryTag: 0, redelivered: false, exchange: '', routingKey }, properties: { headers: options.headers ?? {}, contentType: options.contentType, messageId: options.messageId } } as ConsumeMessage;
      this.stored.set(routingKey, [...(this.stored.get(routingKey) ?? []), delivered]);
    }
    return true;
  }
  async waitForConfirms() { if (this.confirmError) throw this.confirmError; }

  /** Puts a message into a queue, as if it had been routed there. */
  seed(queue: string, msg: ConsumeMessage) { this.stored.set(queue, [...(this.stored.get(queue) ?? []), msg]); }
  /** basic.get: hands out the next message of a queue; it stays unacked until ack/nack. */
  async get(queue: string): Promise<GetMessage | false> {
    const msg = (this.stored.get(queue) ?? []).shift();
    if (!msg) return false;
    msg.fields.deliveryTag = this.nextTag++;
    this.pending.set(msg.fields.deliveryTag, { queue, msg });
    return msg as unknown as GetMessage;
  }
  /** How many messages a queue holds, counting the ones handed out but not yet acked. */
  depth(queue: string): number { return (this.stored.get(queue) ?? []).length + [...this.pending.values()].filter((p) => p.queue === queue).length; }

  // ---- helpers for tests
  /** Builds a message exactly as amqplib would hand it to a consumer. */
  static message(body: unknown, opts: { routingKey?: string; headers?: Record<string, unknown>; raw?: string } = {}): ConsumeMessage {
    const content = Buffer.from(opts.raw ?? JSON.stringify(body));
    return {
      content,
      fields: { consumerTag: 'fake', deliveryTag: Math.floor(Math.random() * 1e9), redelivered: false, exchange: '', routingKey: opts.routingKey ?? '' },
      properties: { headers: opts.headers ?? {}, contentType: 'application/json' } as ConsumeMessage['properties'],
    } as ConsumeMessage;
  }

  /** What the broker would do when a retry message expires: hand it back to the main queue through the default exchange (routing key = queue name). */
  static redeliverFromRetryQueue(published: Published, mainQueue: string): ConsumeMessage {
    return {
      content: published.content,
      fields: { consumerTag: 'fake', deliveryTag: Math.floor(Math.random() * 1e9), redelivered: false, exchange: '', routingKey: mainQueue },
      properties: { headers: { ...(published.options.headers ?? {}), 'x-death': [{ count: 1, reason: 'expired', queue: published.routingKey }] }, contentType: 'application/json' } as ConsumeMessage['properties'],
    } as ConsumeMessage;
  }
}
