/**
 * Retry with backoff and dead-lettering on a REAL RabbitMQ: the part the unit tests cannot prove (that the broker really carries a message
 * through a retry queue's TTL and back to the main queue, and that the queue arguments dead-letter anything the runner does not handle).
 * Skipped unless RABBITMQ_URL is set. Run with:  make test-chat   (docker compose up -d first)   or in CI (a RabbitMQ service container).
 * Every test uses its own exchange and queues (random suffix) and deletes them afterwards, so it is safe against a shared broker.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import amqp, { type ConfirmChannel, type GetMessage } from 'amqplib';
import { startConsumer } from '../src/messaging/consumer-runner';
import { PermanentError, type RetryPolicy, TransientError } from '../src/messaging/retry-policy';
import { assertTopology, type ConsumerSpec, namesFor, type QueueNames } from '../src/messaging/topology';

const URL = process.env.RABBITMQ_URL;
const POLICY: RetryPolicy = { initialDelayMs: 200, multiplier: 2, maxDelayMs: 800, maxAttempts: 3 };    // delays 200, 400, 800 ms
const silent = { info() {}, warn() {}, error() {} };
const SLACK_MS = 30;

interface Ctx { ch: ConfirmChannel; spec: ConsumerSpec; names: QueueNames }

async function withBroker(fn: (ctx: Ctx) => Promise<void>) {
  const conn = await amqp.connect(URL!);
  const ch = await conn.createConfirmChannel();
  const id = randomUUID().slice(0, 8);
  const spec: ConsumerSpec = { exchange: `it.events.${id}`, queue: `it.chat.${id}`, routingKeys: ['thing.happened'] };
  const names = namesFor(spec.queue, POLICY);
  try {
    await fn({ ch, spec, names });
  } finally {
    for (const q of [names.main, names.dlq, ...names.retryQueues.map((r) => r.queue)]) await ch.deleteQueue(q).catch(() => undefined);
    await ch.deleteExchange(spec.exchange).catch(() => undefined);
    await conn.close().catch(() => undefined);
  }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

async function publish(ctx: Ctx, body: unknown) {
  ctx.ch.publish(ctx.spec.exchange, 'thing.happened', Buffer.from(JSON.stringify(body)), { persistent: true });
  await ctx.ch.waitForConfirms();
}

async function takeFromDlq(ctx: Ctx): Promise<GetMessage> {
  let found: GetMessage | undefined;
  await until(async () => { const m = await ctx.ch.get(ctx.names.dlq, { noAck: true }); if (m) found = m; return !!m; }, 15_000, 'a message in the dead-letter queue');
  return found!;
}

const depth = async (ctx: Ctx, queue: string) => (await ctx.ch.checkQueue(queue)).messageCount;

describe('retry and dead-lettering on a real RabbitMQ', { skip: URL ? false : 'set RABBITMQ_URL to run (make test-chat)' }, () => {
  test('transient failures are retried with growing delays and then succeed; the original routing key survives; nothing is dead-lettered', { timeout: 30_000 }, () =>
    withBroker(async (ctx) => {
      const calls: { key: string; at: number }[] = [];
      await startConsumer(ctx.ch, ctx.spec, async (key) => {
        calls.push({ key, at: Date.now() });
        if (calls.length <= 2) throw new TransientError('database briefly down');
      }, { policy: POLICY, log: silent });

      await publish(ctx, { n: 1 });
      await until(() => calls.length === 3, 15_000, 'three deliveries');

      assert.deepEqual(calls.map((c) => c.key), ['thing.happened', 'thing.happened', 'thing.happened'], 'routing key preserved across retries');
      assert.ok(calls[1].at - calls[0].at >= 200 - SLACK_MS, `first retry after ~200ms, was ${calls[1].at - calls[0].at}`);
      assert.ok(calls[2].at - calls[1].at >= 400 - SLACK_MS, `second retry after ~400ms, was ${calls[2].at - calls[1].at}`);
      await until(async () => (await depth(ctx, ctx.names.main)) === 0, 5_000, 'the main queue to drain');
      for (const r of ctx.names.retryQueues) assert.equal(await depth(ctx, r.queue), 0, r.queue);
      assert.equal(await depth(ctx, ctx.names.dlq), 0);
    }));

  test('a permanent failure goes straight to the DLQ with the error in its headers and is never retried', { timeout: 30_000 }, () =>
    withBroker(async (ctx) => {
      let calls = 0;
      await startConsumer(ctx.ch, ctx.spec, async () => { calls++; throw new PermanentError('unknown schema version'); }, { policy: POLICY, log: silent });

      await publish(ctx, { orderId: 'o-1' });
      const dead = await takeFromDlq(ctx);

      const h = dead.properties.headers as Record<string, unknown>;
      assert.deepEqual(JSON.parse(dead.content.toString()), { orderId: 'o-1' });
      assert.equal(h['x-failure-kind'], 'permanent');
      assert.equal(h['x-error-class'], 'PermanentError');
      assert.equal(h['x-error'], 'unknown schema version');
      assert.equal(h['x-original-queue'], ctx.spec.queue);
      assert.equal(h['x-original-routing-key'], 'thing.happened');
      assert.equal(h['x-retry-count'], 0);
      await new Promise((r) => setTimeout(r, 1200));                      // longer than every retry delay: it must not come back
      assert.equal(calls, 1);
      assert.equal(await depth(ctx, ctx.names.main), 0);
    }));

  test('a failure that never clears is retried maxAttempts times (1 + 3 deliveries) and then dead-lettered', { timeout: 30_000 }, () =>
    withBroker(async (ctx) => {
      let calls = 0;
      const started = Date.now();
      await startConsumer(ctx.ch, ctx.spec, async () => { calls++; throw new TransientError('still down'); }, { policy: POLICY, log: silent });

      await publish(ctx, { n: 2 });
      const dead = await takeFromDlq(ctx);
      const elapsed = Date.now() - started;

      const h = dead.properties.headers as Record<string, unknown>;
      assert.equal(calls, 4);
      assert.equal(h['x-retry-count'], 3);
      assert.equal(h['x-failure-kind'], 'transient');
      assert.equal(h['x-error'], 'still down');
      assert.ok(elapsed >= 200 + 400 + 800 - 3 * SLACK_MS, `the three backoff waits add up to ~1400ms, took ${elapsed}`);
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(calls, 4, 'no further deliveries after dead-lettering');
    }));

  test('the main queue itself dead-letters anything rejected at the broker level (safety net behind the runner)', { timeout: 30_000 }, () =>
    withBroker(async (ctx) => {
      await assertTopology(ctx.ch, ctx.spec, POLICY);
      await assertTopology(ctx.ch, ctx.spec, POLICY);                      // declaring again is harmless
      await ctx.ch.consume(ctx.spec.queue, (m) => { if (m) ctx.ch.nack(m, false, false); });   // a bare reject, no runner involved

      await publish(ctx, { n: 3 });
      const dead = await takeFromDlq(ctx);

      const death = (dead.properties.headers as Record<string, unknown>)['x-death'] as { reason: string; queue: string }[];
      assert.equal(death[0].reason, 'rejected');
      assert.equal(death[0].queue, ctx.spec.queue);
      assert.deepEqual(JSON.parse(dead.content.toString()), { n: 3 });
    }));
});
