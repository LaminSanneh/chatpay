/** The dead-letter tool (list / replay) against the permanent fake channel: it must never lose or duplicate a message, whatever goes wrong. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FakeChannel } from '../../../mock-services/amqp/fake-channel';
import { formatDeadLetter, parseArgs } from '../src/tools/dlq-cli';
import { listDeadLetters, replayDeadLetters, summarize } from '../src/tools/dlq';

const DLQ = 'chat.wallet-events.dlq';
const MAIN = 'chat.wallet-events';
const NOW = () => new Date('2026-12-01T12:00:00Z');

function deadLetter(body: unknown, extra: Record<string, unknown> = {}, raw?: string) {
  return FakeChannel.message(body, {
    raw,
    headers: {
      'x-failure-kind': 'transient', 'x-error-class': 'Error', 'x-error': 'db down', 'x-original-queue': MAIN,
      'x-original-routing-key': 'transfer.completed', 'x-retry-count': 5, 'x-first-failed-at': '2026-12-01T10:00:00.000Z', 'x-failed-at': '2026-12-01T10:01:00.000Z',
      'x-trace': 'keep-me', 'x-death': [{ count: 1 }], ...extra,
    },
  });
}

function fill(...messages: ReturnType<typeof deadLetter>[]) {
  const ch = new FakeChannel();
  messages.forEach((m) => ch.seed(DLQ, m));
  return ch;
}

describe('list', () => {
  test('describes each dead letter from its headers and leaves every one of them in the queue', async () => {
    const ch = fill(deadLetter({ n: 1 }), deadLetter({ n: 2 }, { 'x-error': 'schema', 'x-failure-kind': 'permanent', 'x-retry-count': 0, 'x-replay-count': 2 }));

    const letters = await listDeadLetters(ch, DLQ);

    assert.equal(letters.length, 2);
    assert.deepEqual({ ...letters[0], bytes: 0 }, {
      position: 1, originalQueue: MAIN, originalRoutingKey: 'transfer.completed', failureKind: 'transient', errorClass: 'Error', error: 'db down',
      retryCount: 5, replayCount: 0, firstFailedAt: '2026-12-01T10:00:00.000Z', failedAt: '2026-12-01T10:01:00.000Z', messageId: undefined, bytes: 0, preview: '{"n":1}',
    });
    assert.equal(letters[1].replayCount, 2);
    assert.equal(ch.depth(DLQ), 2, 'listing changes nothing');
  });

  test('respects the limit and keeps the order', async () => {
    const ch = fill(deadLetter({ n: 1 }), deadLetter({ n: 2 }), deadLetter({ n: 3 }));

    assert.deepEqual((await listDeadLetters(ch, DLQ, { limit: 2 })).map((l) => l.preview), ['{"n":1}', '{"n":2}']);
    assert.equal(ch.depth(DLQ), 3);
    assert.deepEqual((await listDeadLetters(ch, DLQ)).map((l) => l.preview), ['{"n":1}', '{"n":2}', '{"n":3}'], 'the order survived being peeked at');
  });

  test('an empty queue is simply empty; long bodies are shortened in the preview', async () => {
    assert.deepEqual(await listDeadLetters(new FakeChannel(), DLQ), []);
    assert.ok(summarize(deadLetter({ big: 'x'.repeat(500) }), 1).preview.length <= 120);
  });

  test('the printed form carries what a person needs to decide', () => {
    const out = formatDeadLetter(summarize(deadLetter({ n: 1 }, { 'x-replay-count': 1 }), 3));
    for (const part of ['#3', 'transient', 'retries=5', 'chat.wallet-events / transfer.completed', 'Error: db down', 'replayed 1x']) assert.ok(out.includes(part), part);
  });
});

describe('replay', () => {
  const opts = { limit: 10, dryRun: false, now: NOW };

  test('a dry run shows what would happen and moves nothing', async () => {
    const ch = fill(deadLetter({ n: 1 }), deadLetter({ n: 2 }));

    const r = await replayDeadLetters(ch, DLQ, { ...opts, dryRun: true });

    assert.deepEqual({ replayed: r.replayed, wouldReplay: r.wouldReplay }, { replayed: 0, wouldReplay: 2 });
    assert.equal(ch.depth(DLQ), 2);
    assert.equal(ch.published.length, 0);
  });

  test('puts the message back on its ORIGINAL queue with a fresh retry budget and a trail of who did it', async () => {
    const original = deadLetter({ transferId: 't1', amountMinor: 100 });
    const ch = fill(original);

    const r = await replayDeadLetters(ch, DLQ, opts);

    assert.equal(r.replayed, 1);
    assert.equal(ch.depth(DLQ), 0, 'removed from the dead-letter queue');
    assert.equal(ch.depth(MAIN), 1, 'and waiting on the main queue');
    const p = ch.published[0];
    assert.equal(p.exchange, '');
    assert.equal(p.routingKey, MAIN);
    assert.equal(p.content.toString(), original.content.toString(), 'the same bytes');
    assert.equal(p.options.persistent, true);
    assert.deepEqual(p.options.headers, {
      'x-original-queue': MAIN, 'x-original-routing-key': 'transfer.completed', 'x-trace': 'keep-me',
      'x-replay-count': 1, 'x-replayed-at': '2026-12-01T12:00:00.000Z', 'x-replayed-from': DLQ,
    });
    assert.equal(ch.acked.length, 1);
  });

  test('a message replayed twice records that', async () => {
    const ch = fill(deadLetter({ n: 1 }, { 'x-replay-count': 1 }));
    await replayDeadLetters(ch, DLQ, opts);
    assert.equal((ch.published[0].options.headers as Record<string, unknown>)['x-replay-count'], 2);
  });

  test('--limit replays the oldest N and leaves the rest', async () => {
    const ch = fill(deadLetter({ n: 1 }), deadLetter({ n: 2 }), deadLetter({ n: 3 }));

    const r = await replayDeadLetters(ch, DLQ, { ...opts, limit: 2 });

    assert.equal(r.replayed, 2);
    assert.deepEqual(ch.published.map((p) => p.content.toString()), ['{"n":1}', '{"n":2}']);
    assert.equal(ch.depth(DLQ), 1);
  });

  test('--match replays only matching messages, and terminates even though the others stay', async () => {
    const ch = fill(deadLetter({ id: 'a' }), deadLetter({ id: 'b' }, { 'x-error': 'schema mismatch' }), deadLetter({ id: 'c' }));

    const byBody = await replayDeadLetters(ch, DLQ, { ...opts, match: '"id":"c"' });
    const byError = await replayDeadLetters(ch, DLQ, { ...opts, match: 'schema' });

    assert.equal(byBody.replayed, 1);
    assert.equal(byError.replayed, 1);
    assert.deepEqual(byBody.skipped.map((s) => s.reason), ['does not match', 'does not match']);
    assert.equal(ch.depth(DLQ), 1);
    assert.deepEqual(ch.published.map((p) => p.content.toString()), ['{"id":"c"}', '{"id":"b"}']);
  });

  test('an old-format dead letter (no x-original-queue) is skipped, not guessed, unless --to says where', async () => {
    const old = FakeChannel.message({ n: 1 }, { headers: { 'x-death': [{ queue: MAIN }] } });
    const ch = fill(old);

    const without = await replayDeadLetters(ch, DLQ, opts);
    assert.equal(without.replayed, 0);
    assert.match(without.skipped[0].reason, /--to/);
    assert.equal(ch.depth(DLQ), 1, 'still there');

    const withTo = await replayDeadLetters(ch, DLQ, { ...opts, to: MAIN });
    assert.equal(withTo.replayed, 1);
    assert.equal(ch.published[0].routingKey, MAIN);
  });

  test('if the broker refuses the copy the dead letter STAYS, nothing is lost, and the run stops with an explanation', async () => {
    const ch = fill(deadLetter({ n: 1 }), deadLetter({ n: 2 }));
    ch.confirmError = new Error('broker refused');

    const r = await replayDeadLetters(ch, DLQ, opts);

    assert.equal(r.replayed, 0);
    assert.match(r.stoppedBecause ?? '', /broker refused.*still in chat\.wallet-events\.dlq/);
    assert.equal(ch.depth(DLQ), 2, 'both dead letters are still in the queue');
    assert.equal(ch.acked.length, 0);
  });

  test('replaying a store dead letter works the same way (same header convention)', async () => {
    const ch = new FakeChannel();
    ch.seed('store.wallet-events.dlq', deadLetter({ n: 1 }, { 'x-original-queue': 'store.wallet-events' }));

    await replayDeadLetters(ch, 'store.wallet-events.dlq', opts);

    assert.equal(ch.depth('store.wallet-events'), 1);
  });
});

describe('command line', () => {
  test('list and replay take a queue and options', () => {
    assert.deepEqual(parseArgs(['list', DLQ]), { command: 'list', queue: DLQ, limit: 50, yes: false });
    assert.deepEqual(parseArgs(['replay', DLQ, '--limit', '3', '--match', 'abc', '--to', MAIN, '--yes']), { command: 'replay', queue: DLQ, limit: 3, match: 'abc', to: MAIN, yes: true });
    assert.equal(parseArgs(['replay', DLQ]).yes, false, 'replay is a dry run unless --yes is given');
    assert.equal(parseArgs(['replay', DLQ]).limit, 10);
  });

  test('mistakes are refused with the usage text', () => {
    for (const bad of [[], ['list'], ['purge', DLQ], ['list', DLQ, '--limit', '0'], ['list', DLQ, '--limit', 'many'], ['list', DLQ, '--yes'], ['replay', DLQ, '--match'], ['replay', DLQ, '--wat']]) {
      assert.throws(() => parseArgs(bad), /usage|--limit|needs a value|unknown option/, JSON.stringify(bad));
    }
  });
});
