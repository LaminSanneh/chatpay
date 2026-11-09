/**
 * The retry / dead-letter decisions of the consumer runner, with no broker: a permanent fake channel (mock-services/amqp) records what the
 * runner declares, publishes, acks and nacks. Whether RabbitMQ really carries a message through a retry queue and back is proven separately
 * in messaging.integration.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { FakeChannel } from '../../../mock-services/amqp/fake-channel';
import { H, type Logger, processMessage, startConsumer } from '../src/messaging/consumer-runner';
import { DEFAULT_RETRY_POLICY, PermanentError, type RetryPolicy, TransientError } from '../src/messaging/retry-policy';
import { DEAD_LETTER_EXCHANGE, type ConsumerSpec, type QueueNames } from '../src/messaging/topology';

const SPEC: ConsumerSpec = { exchange: 'store.events', queue: 'chat.store-events', routingKeys: ['store.opened', 'store.closed', 'order.paid'] };
const silent: Logger = { info() {}, warn() {}, error() {} };

async function setup(policy: RetryPolicy = DEFAULT_RETRY_POLICY) {
  const ch = new FakeChannel();
  const names = await startConsumer(ch, SPEC, async () => undefined, { policy, log: silent });
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const opts = { policy, log: silent, now: () => new Date((clock += 1000)), requeueDelayMs: 0 };
  return { ch, names, opts };
}

const headersOf = (p: { options: { headers?: Record<string, unknown> } }) => (p.options.headers ?? {}) as Record<string, unknown>;

describe('topology', () => {
  test('dead-letter exchange, dead-letter queue and its binding', async () => {
    const { ch } = await setup();
    assert.deepEqual(ch.exchanges.get(DEAD_LETTER_EXCHANGE), { type: 'direct', options: { durable: true } });
    assert.deepEqual(ch.queues.get('chat.store-events.dlq'), { durable: true });
    assert.ok(ch.bindings.some((b) => b.queue === 'chat.store-events.dlq' && b.exchange === DEAD_LETTER_EXCHANGE && b.pattern === 'chat.store-events.dlq'));
  });

  test('the main queue points at the DLX and binds every routing key', async () => {
    const { ch } = await setup();
    assert.deepEqual(ch.queues.get('chat.store-events'), {
      durable: true, arguments: { 'x-dead-letter-exchange': 'chat.dlx', 'x-dead-letter-routing-key': 'chat.store-events.dlq' },
    });
    assert.deepEqual(ch.bindings.filter((b) => b.queue === 'chat.store-events').map((b) => b.pattern), ['store.opened', 'store.closed', 'order.paid']);
    assert.equal(ch.exchanges.get('store.events')?.type, 'topic');
  });

  test('one retry queue per backoff step: TTL = the delay, expired messages go back to the main queue', async () => {
    const { ch, names } = await setup();
    assert.deepEqual(names.retryQueues.map((r) => r.delayMs), [2000, 4000, 8000, 16000, 30000]);
    for (const r of names.retryQueues) {
      assert.deepEqual(ch.queues.get(r.queue), {
        durable: true, arguments: { 'x-message-ttl': r.delayMs, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'chat.store-events' },
      });
    }
  });

  test('a message cancelled by the broker (null) is ignored without crashing', async () => {
    const { ch } = await setup();
    ch.consumers.get('chat.store-events')!(null);
  });
});

describe('a message the handler accepts', () => {
  test('is acked once, nothing is republished, and the handler sees the parsed payload and the routing key', async () => {
    const { ch, names, opts } = await setup();
    const seen: unknown[] = [];
    const msg = FakeChannel.message({ storeId: 's1' }, { routingKey: 'store.opened' });

    await processMessage(ch, SPEC, names, async (key, payload) => { seen.push([key, payload]); }, opts, msg);

    assert.deepEqual(seen, [['store.opened', { storeId: 's1' }]]);
    assert.deepEqual(ch.acked, [msg]);
    assert.equal(ch.published.length, 0);
    assert.equal(ch.nacked.length, 0);
  });
});

describe('transient failures', () => {
  test('are copied to the first retry queue with the error and the bookkeeping headers, and the original is acked', async () => {
    const { ch, names, opts } = await setup();
    const msg = FakeChannel.message({ orderId: 'o1' }, { routingKey: 'order.paid', headers: { 'x-trace': 'abc' } });

    await processMessage(ch, SPEC, names, async () => { throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }); }, opts, msg);

    assert.equal(ch.published.length, 1);
    const p = ch.published[0];
    assert.equal(p.exchange, '', 'through the default exchange, straight to the retry queue');
    assert.equal(p.routingKey, 'chat.store-events.retry.2000ms');
    assert.equal(p.content.toString(), msg.content.toString());
    assert.equal(p.options.persistent, true);
    assert.deepEqual(headersOf(p), {
      'x-trace': 'abc',
      [H.retryCount]: 1,
      [H.originalRoutingKey]: 'order.paid',
      [H.originalQueue]: 'chat.store-events',
      [H.failureKind]: 'transient',
      [H.errorClass]: 'Error',
      [H.error]: 'db down',
      [H.errorStack]: headersOf(p)[H.errorStack],
      [H.firstFailedAt]: '2026-01-01T00:00:01.000Z',
      [H.failedAt]: '2026-01-01T00:00:01.000Z',
    });
    assert.deepEqual(ch.acked, [msg]);
    assert.equal(ch.nacked.length, 0);
  });

  test('back off exponentially, then land in the DLQ after the last retry, keeping the original routing key all the way', async () => {
    const { ch, names, opts } = await setup();
    const keys: string[] = [];
    const failing = async (key: string) => { keys.push(key); throw new TransientError('still down'); };
    let msg = FakeChannel.message({ orderId: 'o1' }, { routingKey: 'order.paid' });

    for (let delivery = 1; delivery <= 6; delivery++) {
      await processMessage(ch, SPEC, names, failing, opts, msg);
      const last = ch.published[ch.published.length - 1];
      if (last.exchange === '') msg = FakeChannel.redeliverFromRetryQueue(last, SPEC.queue);   // the broker returns it when the TTL expires
    }

    assert.deepEqual(ch.published.map((p) => p.routingKey), [
      'chat.store-events.retry.2000ms', 'chat.store-events.retry.4000ms', 'chat.store-events.retry.8000ms',
      'chat.store-events.retry.16000ms', 'chat.store-events.retry.30000ms', 'chat.store-events.dlq',
    ]);
    assert.equal(ch.published[5].exchange, DEAD_LETTER_EXCHANGE);
    assert.equal(headersOf(ch.published[5])[H.retryCount], 5);
    assert.equal(headersOf(ch.published[5])[H.failureKind], 'transient');
    assert.deepEqual(keys, Array(6).fill('order.paid'), 'the handler always sees the ORIGINAL routing key, even on retried deliveries');
    assert.equal(ch.acked.length, 6, 'every delivery is acked exactly once: nothing piles up unacked');
    assert.equal(ch.nacked.length, 0);
  });

  test('that clear after two failures are processed on the third delivery and never reach the DLQ', async () => {
    const { ch, names, opts } = await setup();
    let calls = 0;
    const flaky = async () => { if (++calls <= 2) throw new TransientError('blip'); };
    let msg = FakeChannel.message({ n: 1 }, { routingKey: 'store.opened' });

    for (let delivery = 1; delivery <= 3; delivery++) {
      await processMessage(ch, SPEC, names, flaky, opts, msg);
      if (delivery < 3) msg = FakeChannel.redeliverFromRetryQueue(ch.published[ch.published.length - 1], SPEC.queue);
    }

    assert.equal(calls, 3);
    assert.deepEqual(ch.published.map((p) => p.routingKey), ['chat.store-events.retry.2000ms', 'chat.store-events.retry.4000ms']);
    assert.equal(ch.published.some((p) => p.exchange === DEAD_LETTER_EXCHANGE), false);
    assert.equal(ch.acked.length, 3);
  });

  test('keep when they FIRST failed while updating when they LAST failed', async () => {
    const { ch, names, opts } = await setup();
    const failing = async () => { throw new TransientError('down'); };
    const first = FakeChannel.message({}, { routingKey: 'order.paid' });
    await processMessage(ch, SPEC, names, failing, opts, first);
    await processMessage(ch, SPEC, names, failing, opts, FakeChannel.redeliverFromRetryQueue(ch.published[0], SPEC.queue));

    const [a, b] = ch.published.map(headersOf);
    assert.equal(b[H.firstFailedAt], a[H.firstFailedAt]);
    assert.notEqual(b[H.failedAt], a[H.failedAt]);
  });

  test('do not carry the broker\'s own x-death bookkeeping forward', async () => {
    const { ch, names, opts } = await setup();
    const msg = FakeChannel.message({}, { routingKey: 'order.paid', headers: { 'x-death': [{ count: 3 }], 'x-first-death-queue': 'q', 'x-first-death-reason': 'expired', 'x-keep': 1 } });

    await processMessage(ch, SPEC, names, async () => { throw new TransientError('x'); }, opts, msg);

    const headers = headersOf(ch.published[0]);
    assert.equal('x-death' in headers, false);
    assert.equal('x-first-death-queue' in headers, false);
    assert.equal(headers['x-keep'], 1);
  });
});

describe('permanent failures', () => {
  test('go straight to the DLQ, with no retry, whatever the attempt count', async () => {
    const { ch, names, opts } = await setup();
    let calls = 0;
    const msg = FakeChannel.message({ bad: true }, { routingKey: 'store.opened' });

    await processMessage(ch, SPEC, names, async () => { calls++; throw new PermanentError('schema v9 is unknown'); }, opts, msg);

    assert.equal(calls, 1);
    assert.equal(ch.published.length, 1);
    assert.equal(ch.published[0].exchange, DEAD_LETTER_EXCHANGE);
    assert.equal(ch.published[0].routingKey, 'chat.store-events.dlq');
    assert.equal(headersOf(ch.published[0])[H.failureKind], 'permanent');
    assert.equal(headersOf(ch.published[0])[H.errorClass], 'PermanentError');
    assert.equal(headersOf(ch.published[0])[H.retryCount], 0);
    assert.equal(headersOf(ch.published[0])[H.error], 'schema v9 is unknown');
    assert.deepEqual(ch.acked, [msg]);
  });

  test('unparseable JSON never reaches the handler and is dead-lettered as a SyntaxError', async () => {
    const { ch, names, opts } = await setup();
    let calls = 0;

    await processMessage(ch, SPEC, names, async () => { calls++; }, opts, FakeChannel.message(null, { raw: '{not json', routingKey: 'store.opened' }));

    assert.equal(calls, 0);
    assert.equal(ch.published[0].exchange, DEAD_LETTER_EXCHANGE);
    assert.equal(headersOf(ch.published[0])[H.errorClass], 'SyntaxError');
    assert.equal(ch.published[0].content.toString(), '{not json', 'the original bytes are kept so a person can read them');
  });

  test('a payload that fails validation (zod) is dead-lettered immediately', async () => {
    const { ch, names, opts } = await setup();
    const schema = z.object({ storeId: z.string() });

    await processMessage(ch, SPEC, names, async (_k, payload) => { schema.parse(payload); }, opts, FakeChannel.message({ storeId: 7 }, { routingKey: 'store.opened' }));

    assert.equal(ch.published.length, 1);
    assert.equal(ch.published[0].exchange, DEAD_LETTER_EXCHANGE);
    assert.equal(headersOf(ch.published[0])[H.errorClass], 'ZodError');
  });
});

describe('the policy decides how many retries there are', () => {
  test('with zero retries a transient failure is dead-lettered at once (and no retry queues exist)', async () => {
    const { ch, names, opts } = await setup({ ...DEFAULT_RETRY_POLICY, maxAttempts: 0 });

    await processMessage(ch, SPEC, names, async () => { throw new TransientError('x'); }, opts, FakeChannel.message({}, { routingKey: 'order.paid' }));

    assert.equal(names.retryQueues.length, 0);
    assert.equal(ch.published[0].exchange, DEAD_LETTER_EXCHANGE);
  });
});

describe('when the failed message cannot be moved', () => {
  test('it is given back to the queue (requeue) instead of being acked or lost', async () => {
    const { ch, names, opts } = await setup();
    ch.confirmError = new Error('broker refused the copy');
    const msg = FakeChannel.message({}, { routingKey: 'order.paid' });

    await processMessage(ch, SPEC, names, async () => { throw new TransientError('x'); }, opts, msg);

    assert.equal(ch.acked.length, 0);
    assert.deepEqual(ch.nacked, [{ msg, requeue: true }]);
  });

  test('same for a dead-letter copy that cannot be stored', async () => {
    const { ch, names, opts } = await setup();
    ch.confirmError = new Error('broker refused the copy');
    const msg = FakeChannel.message({}, { routingKey: 'order.paid' });

    await processMessage(ch, SPEC, names, async () => { throw new PermanentError('x'); }, opts, msg);

    assert.equal(ch.acked.length, 0);
    assert.deepEqual(ch.nacked, [{ msg, requeue: true }]);
  });
});
