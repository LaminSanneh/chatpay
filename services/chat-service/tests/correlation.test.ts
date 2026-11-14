/**
 * Correlation ids in the chat service: an id arrives with an HTTP request or a RabbitMQ message, follows it through every await, shows up in
 * every log line, goes back out on the response / the retry and dead-letter copies, and never leaks into another request.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import express from 'express';
import { FakeChannel } from '../../../mock-services/amqp/fake-channel';
import { createHttpApp } from '../src/http/app';
import { H, processMessage } from '../src/messaging/consumer-runner';
import { DEFAULT_RETRY_POLICY, PermanentError, TransientError } from '../src/messaging/retry-policy';
import { namesFor } from '../src/messaging/topology';
import {
  correlationMiddleware, correlationOf, createCorrelatedLogger, currentCorrelationId, installCorrelatedConsole, newCorrelationId,
  normalizeCorrelationId, runWithCorrelation, socketCorrelation, type ConsoleLike,
} from '../src/observability/correlation';
import { listDeadLetters } from '../src/tools/dlq';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeConsole() {
  const lines: { level: string; args: unknown[] }[] = [];
  const at = (level: string) => (...args: unknown[]) => { lines.push({ level, args }); };
  const target: ConsoleLike = { log: at('log'), info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
  return { lines, target };
}

describe('what an id may look like', () => {
  test('ordinary ids are accepted, as are the first of repeated headers', () => {
    for (const id of [newCorrelationId(), 'req-123', 'a.b_c:d-e', 'X'.repeat(64)]) assert.equal(normalizeCorrelationId(id), id);
    assert.equal(normalizeCorrelationId(['first', 'second']), 'first');
    assert.match(newCorrelationId(), UUID);
  });

  test('anything that could forge or flood a log line is refused', () => {
    for (const bad of ['', 'X'.repeat(65), 'two words', 'line\nbreak', 'inject\r\nERROR fake', '<script>', 'ünï', 42, null, undefined, {}]) {
      assert.equal(normalizeCorrelationId(bad), undefined, String(bad));
    }
  });
});

describe('the id follows the async call chain and never leaks', () => {
  test('outside a request or message there is no id', () => assert.equal(currentCorrelationId(), undefined));

  test('it survives awaits, timers and promises', async () => {
    await runWithCorrelation('chain-1', async () => {
      assert.equal(currentCorrelationId(), 'chain-1');
      await sleep(5);
      await Promise.resolve().then(() => assert.equal(currentCorrelationId(), 'chain-1'));
      await new Promise<void>((r) => setTimeout(() => { assert.equal(currentCorrelationId(), 'chain-1'); r(); }, 5));
    });
    assert.equal(currentCorrelationId(), undefined, 'and is gone afterwards');
  });

  test('interleaved requests each keep their own id', async () => {
    const seen: string[] = [];
    const work = (id: string, delay: number) => runWithCorrelation(id, async () => { await sleep(delay); seen.push(`${id}:${currentCorrelationId()}`); });

    await Promise.all([work('a', 20), work('b', 5), work('c', 10)]);

    assert.deepEqual(seen.sort(), ['a:a', 'b:b', 'c:c']);
  });

  test('an invalid or missing id is replaced, never propagated', () => {
    assert.equal(runWithCorrelation('bad id\n', () => currentCorrelationId())?.length, 36);
    assert.match(runWithCorrelation(undefined, () => currentCorrelationId())!, UUID);
  });

  test('every Socket.IO event gets its own id', () => {
    const ids: (string | undefined)[] = [];
    socketCorrelation({}, () => ids.push(currentCorrelationId()));
    socketCorrelation({}, () => ids.push(currentCorrelationId()));
    assert.match(ids[0]!, UUID);
    assert.notEqual(ids[0], ids[1]);
  });
});

describe('log lines carry the id', () => {
  test('the console wrapper tags lines inside a request or message and leaves the rest alone, and can be undone', () => {
    const { lines, target } = fakeConsole();
    const restore = installCorrelatedConsole(target);

    runWithCorrelation('trace-7', () => { target.log('inside'); target.error('failed', { code: 1 }); });
    target.warn('outside');
    restore();
    runWithCorrelation('trace-8', () => target.log('after restore'));

    assert.deepEqual(lines.map((l) => [l.level, ...l.args]), [
      ['log', '[cid=trace-7]', 'inside'], ['error', '[cid=trace-7]', 'failed', { code: 1 }], ['warn', 'outside'], ['log', 'after restore'],
    ]);
  });

  test('the logger used by consumers tags its lines too', () => {
    const { lines, target } = fakeConsole();
    const log = createCorrelatedLogger(target);

    runWithCorrelation('trace-9', () => { log.info('consuming'); log.warn('retrying', 'detail'); log.error('dead-lettered'); });

    assert.deepEqual(lines.map((l) => l.args), [['[cid=trace-9]', 'consuming'], ['[cid=trace-9]', 'retrying', 'detail'], ['[cid=trace-9]', 'dead-lettered']]);
  });
});

describe('HTTP', () => {
  async function serveBare() {
    const app = express();
    app.use(correlationMiddleware);
    app.get('/whoami', async (_req, res) => { await sleep(5); res.json({ id: currentCorrelationId() }); });
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  test('a valid X-Correlation-Id is used, echoed on the response, and visible to the handler after an await', async () => {
    const s = await serveBare();
    const res = await fetch(`${s.base}/whoami`, { headers: { 'X-Correlation-Id': 'from-the-client-1' } });
    assert.equal(res.headers.get('x-correlation-id'), 'from-the-client-1');
    assert.deepEqual(await res.json(), { id: 'from-the-client-1' });
    await s.close();
  });

  test('without one a UUID is generated; an invalid one is replaced', async () => {
    const s = await serveBare();
    const none = await fetch(`${s.base}/whoami`);
    const bad = await fetch(`${s.base}/whoami`, { headers: { 'X-Correlation-Id': 'not valid!' } });
    assert.match(none.headers.get('x-correlation-id')!, UUID);
    assert.match(bad.headers.get('x-correlation-id')!, UUID);
    assert.equal(((await none.json()) as { id: string }).id, none.headers.get('x-correlation-id'));
    await s.close();
  });

  test('parallel requests do not see each other\'s ids', async () => {
    const s = await serveBare();
    const results = await Promise.all(['p1', 'p2', 'p3', 'p4'].map(async (id) => ((await (await fetch(`${s.base}/whoami`, { headers: { 'X-Correlation-Id': id } })).json()) as { id: string }).id));
    assert.deepEqual(results, ['p1', 'p2', 'p3', 'p4']);
    await s.close();
  });

  test('the real chat app returns it on every kind of response, and lets browsers read it', async () => {
    const chat = { touchUser: async () => ({}) } as never;
    const verifier = { verify: async () => { throw new Error('bad'); } } as never;
    const server = createServer(createHttpApp({ chat, verifier, corsOrigins: ['http://localhost:3000'] }));
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const ok = await fetch(`${base}/health`, { headers: { 'X-Correlation-Id': 'h-1', Origin: 'http://localhost:3000' } });
    const unauthorised = await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer x', 'X-Correlation-Id': 'h-2' } });

    assert.equal(ok.headers.get('x-correlation-id'), 'h-1');
    assert.match(ok.headers.get('access-control-expose-headers') ?? '', /X-Correlation-Id/i);
    assert.equal(unauthorised.status, 401);
    assert.equal(unauthorised.headers.get('x-correlation-id'), 'h-2', 'errors can be traced too');
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('RabbitMQ consumers', () => {
  const SPEC = { exchange: 'wallet.events', queue: 'chat.wallet-events', routingKeys: ['transfer.completed'] };
  const names = namesFor(SPEC.queue, DEFAULT_RETRY_POLICY);
  const opts = (log: ReturnType<typeof createCorrelatedLogger>) => ({ policy: DEFAULT_RETRY_POLICY, log, now: () => new Date('2026-01-01T00:00:00Z') });
  const headersOf = (p: { options: { headers?: Record<string, unknown> } }) => (p.options.headers ?? {}) as Record<string, unknown>;

  test('the handler runs under the id the message was published with', async () => {
    const ch = new FakeChannel();
    const seen: (string | undefined)[] = [];

    await processMessage(ch, SPEC, names, async () => { await sleep(2); seen.push(currentCorrelationId()); }, opts(createCorrelatedLogger(fakeConsole().target)),
      FakeChannel.message({ n: 1 }, { routingKey: 'transfer.completed', headers: { 'x-correlation-id': 'from-wallet-1' } }));

    assert.deepEqual(seen, ['from-wallet-1']);
    assert.equal(ch.acked.length, 1);
  });

  test('an id inside the JSON body is used when the header is missing; a header wins over the body', () => {
    const body = { correlationId: 'from-body' };
    assert.equal(correlationOf(FakeChannel.message(body)), 'from-body');
    assert.equal(correlationOf(FakeChannel.message(body, { headers: { 'x-correlation-id': 'from-header' } })), 'from-header');
    assert.equal(correlationOf(FakeChannel.message({}, { raw: '{broken' })), undefined);
    assert.equal(correlationOf(FakeChannel.message({ correlationId: 'bad id!' })), undefined);
  });

  test('the retry copy carries the id, and a retried delivery keeps it', async () => {
    const ch = new FakeChannel();
    const failing = async () => { throw new TransientError('database down'); };
    const log = opts(createCorrelatedLogger(fakeConsole().target));

    await processMessage(ch, SPEC, names, failing, log, FakeChannel.message({ n: 1 }, { routingKey: 'transfer.completed', headers: { 'x-correlation-id': 'trace-A' } }));
    const retry = ch.published[0];
    await processMessage(ch, SPEC, names, failing, log, FakeChannel.redeliverFromRetryQueue(retry, SPEC.queue));

    assert.equal(headersOf(retry)[H.correlationId], 'trace-A');
    assert.equal(headersOf(ch.published[1])[H.correlationId], 'trace-A');
  });

  test('the dead letter carries the id, so a person finds the whole story from it', async () => {
    const ch = new FakeChannel();

    await processMessage(ch, SPEC, names, async () => { throw new PermanentError('unknown schema'); }, opts(createCorrelatedLogger(fakeConsole().target)),
      FakeChannel.message({ n: 1 }, { routingKey: 'transfer.completed', headers: { 'x-correlation-id': 'trace-B' } }));

    assert.equal(ch.published[0].exchange, 'chat.dlx');
    assert.equal(headersOf(ch.published[0])[H.correlationId], 'trace-B');
  });

  test('a message that arrived without any id is given one, used everywhere, and written on its dead letter', async () => {
    const ch = new FakeChannel();
    let inside: string | undefined;

    await processMessage(ch, SPEC, names, async () => { inside = currentCorrelationId(); throw new PermanentError('x'); }, opts(createCorrelatedLogger(fakeConsole().target)),
      FakeChannel.message({ n: 1 }, { routingKey: 'transfer.completed' }));

    assert.match(inside!, UUID);
    assert.equal(headersOf(ch.published[0])[H.correlationId], inside);
  });

  test('every log line of a failing delivery carries the id', async () => {
    const { lines, target } = fakeConsole();
    const ch = new FakeChannel();

    await processMessage(ch, SPEC, names, async () => { throw new TransientError('db down'); }, opts(createCorrelatedLogger(target)),
      FakeChannel.message({ n: 1 }, { routingKey: 'transfer.completed', headers: { 'x-correlation-id': 'trace-C' } }));

    assert.ok(lines.length >= 1);
    for (const l of lines) assert.equal(l.args[0], '[cid=trace-C]');
    assert.match(String(lines[0].args[1]), /retry 1\/5/);
  });

  test('messages handled at the same time keep their own ids', async () => {
    const ch = new FakeChannel();
    const seen: string[] = [];
    const handler = async (_k: string, p: unknown) => { await sleep((p as { delay: number }).delay); seen.push(`${(p as { n: string }).n}:${currentCorrelationId()}`); };
    const log = opts(createCorrelatedLogger(fakeConsole().target));
    const send = (n: string, delay: number) => processMessage(ch, SPEC, names, handler, log,
      FakeChannel.message({ n, delay }, { routingKey: 'transfer.completed', headers: { 'x-correlation-id': `id-${n}` } }));

    await Promise.all([send('a', 20), send('b', 5), send('c', 10)]);

    assert.deepEqual(seen.sort(), ['a:id-a', 'b:id-b', 'c:id-c']);
  });

  test('the dead-letter tool shows the id and a replay keeps it', async () => {
    const ch = new FakeChannel();
    await processMessage(ch, SPEC, names, async () => { throw new PermanentError('x'); }, opts(createCorrelatedLogger(fakeConsole().target)),
      FakeChannel.message({ n: 1 }, { routingKey: 'transfer.completed', headers: { 'x-correlation-id': 'trace-D' } }));
    ch.seed('chat.wallet-events.dlq', FakeChannel.redeliverFromRetryQueue(ch.published[0], 'chat.wallet-events.dlq'));

    const [letter] = await listDeadLetters(ch, 'chat.wallet-events.dlq');

    assert.equal(letter.correlationId, 'trace-D');
  });
});
