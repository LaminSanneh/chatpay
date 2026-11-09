/**
 * Permanent in-memory stand-in for an amqplib ConfirmChannel, for unit-testing consumers WITHOUT a broker.
 * It records what a consumer declares, publishes, acks and nacks, and lets a test deliver messages by hand.
 * It does NOT route messages or run TTLs: whether RabbitMQ really moves a message from a retry queue back to the main queue is proven by the
 * integration test (services/chat-service/tests/messaging.integration.test.ts) against a real broker.
 * Used by: services/chat-service/tests/consumer-runner.test.ts
 */
import type { ConsumeMessage, Options } from 'amqplib';

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
  /** Set to make the next publisher confirm fail, as if the broker refused to store the copy. */
  confirmError: Error | null = null;

  async assertExchange(exchange: string, type: string, options: Record<string, unknown> = {}) { this.exchanges.set(exchange, { type, options }); }
  async assertQueue(queue: string, options: Record<string, unknown> = {}) { this.queues.set(queue, options); }
  async bindQueue(queue: string, exchange: string, pattern: string) { this.bindings.push({ queue, exchange, pattern }); }
  async consume(queue: string, onMessage: (msg: ConsumeMessage | null) => void) { this.consumers.set(queue, onMessage); }

  ack(msg: ConsumeMessage) { this.acked.push(msg); }
  nack(msg: ConsumeMessage, _allUpTo = false, requeue = true) { this.nacked.push({ msg, requeue }); }
  publish(exchange: string, routingKey: string, content: Buffer, options: Options.Publish = {}) {
    this.published.push({ exchange, routingKey, content, options });
    return true;
  }
  async waitForConfirms() { if (this.confirmError) throw this.confirmError; }

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
