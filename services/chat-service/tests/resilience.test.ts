/**
 * The chat service must survive an outage of its database or of RabbitMQ: log calmly, keep running, recover by itself.
 * Each test pins one way the process used to be killable (or could become so). No broker and no database are needed:
 * pool and connection failures are reproduced by emitting the same events pg and amqplib emit.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { Pool } from 'pg';
import { FakeChannel } from '../../../mock-services/amqp/fake-channel';
import { FakeConnection } from '../../../mock-services/amqp/fake-connection';
import { createPool, waitForDatabase } from '../src/adapters/pg-pool';
import { createHttpApp } from '../src/http/app';
import { processMessage } from '../src/messaging/consumer-runner';
import { type AmqpConnectionLike, connectLoop } from '../src/messaging/consumers';
import { DEFAULT_RETRY_POLICY, isDependencyOutage, reconnectDelayMs } from '../src/messaging/retry-policy';
import { installProcessGuards } from '../src/resilience/process-guards';
import { namesFor } from '../src/messaging/topology';

function recordingLog() {
  const lines: { level: string; text: string }[] = [];
  const at = (level: string) => (text: string) => { lines.push({ level, text: String(text) }); };
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error') } };
}
const withCode = (code: string, message = 'boom') => Object.assign(new Error(message), { code });
const until = async (check: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) assert.fail('timed out waiting for the condition'); await new Promise((r) => setTimeout(r, 5)); }
};

describe('what counts as a dependency outage', () => {
  test('network failures, Postgres shutdown/connection errors and connection-lost messages are outages', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P03', '08006', '53300']) assert.equal(isDependencyOutage(withCode(code)), true, code);
    for (const message of ['Connection terminated unexpectedly', 'terminating connection due to administrator command', 'timeout exceeded when trying to connect',
      'the database system is shutting down', 'Channel closed', 'Connection closed: 320 (CONNECTION-FORCED)', 'Client has encountered a connection error and is not queryable']) {
      assert.equal(isDependencyOutage(new Error(message)), true, message);
    }
  });

  test('bugs and bad input are NOT outages (they must stay loud)', () => {
    for (const err of [new Error('something odd'), new TypeError('x is not a function'), withCode('23505'), withCode('22P02'), withCode('40001'), null, undefined, 'text']) {
      assert.equal(isDependencyOutage(err), false, String(err));
    }
  });

  test('reconnect backoff: 1s, 2s, 4s ... capped at 30s', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 500].map((n) => reconnectDelayMs(n)), [0, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

describe('the database pool', () => {
  test('WITHOUT an error listener a lost idle connection kills the process: this is the crash when chat-db is stopped', () => {
    const naive = new Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/x' });
    assert.throws(() => naive.emit('error', new Error('terminating connection due to administrator command')), /terminating connection/);
  });

  test('createPool listens for it: the loss is logged and nothing is thrown', async () => {
    const { lines, log } = recordingLog();
    const pool = createPool('postgres://u:p@127.0.0.1:1/x', log);

    assert.doesNotThrow(() => pool.emit('error', new Error('terminating connection due to administrator command')));

    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 'warn');
    assert.match(lines[0].text, /idle connection was lost.*terminating connection.*reconnects on the next query/);
    await pool.end();
  });

  test('queries and connections have timeouts, so an outage cannot hang a request or a consumer forever', async () => {
    const pool = createPool('postgres://u:p@127.0.0.1:1/x', recordingLog().log);
    assert.equal(pool.options.connectionTimeoutMillis, 5000);
    assert.equal(pool.options.query_timeout, 15000);
    assert.equal(pool.options.keepAlive, true);
    await pool.end();
  });

  test('a refused connection is an ordinary rejected query (handled by callers), not a crash', async () => {
    const pool = createPool('postgres://u:p@127.0.0.1:1/x', recordingLog().log);
    await assert.rejects(pool.query('select 1'), (e: Error) => isDependencyOutage(e));
    await pool.end();
  });
});

describe('waiting for the database at startup', () => {
  test('retries with backoff until it answers, instead of dying because it is not up yet', async () => {
    const { lines, log } = recordingLog();
    const delays: number[] = [];
    let calls = 0;
    const pool = { query: async () => { if (++calls <= 3) throw withCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5434'); return { rows: [] }; } };

    await waitForDatabase(pool as never, { log, sleep: async (ms) => { delays.push(ms); } });

    assert.equal(calls, 4);
    assert.deepEqual(delays, [1000, 2000, 4000]);
    assert.ok(lines.some((l) => /not reachable yet.*retrying in 1000ms/.test(l.text)));
    assert.ok(lines.some((l) => /reachable again after 3 failed attempt/.test(l.text)));
  });

  test('a database that is already up costs nothing, and a limit can end the wait', async () => {
    const delays: number[] = [];
    await waitForDatabase({ query: async () => ({ rows: [] }) } as never, { log: recordingLog().log, sleep: async (ms) => { delays.push(ms); } });
    assert.deepEqual(delays, []);
    await assert.rejects(waitForDatabase({ query: async () => { throw new Error('down'); } } as never, { log: recordingLog().log, sleep: async () => undefined, maxAttempts: 2 }), /down/);
  });
});

describe('process guards', () => {
  function fakeProcess() {
    const proc = new EventEmitter() as EventEmitter & { exit: (code?: number) => void; exits: (number | undefined)[] };
    proc.exits = [];
    proc.exit = (code) => { proc.exits.push(code); };
    return proc;
  }

  test('an outage surfacing as an unhandled rejection or uncaught exception is logged calmly and the process keeps running', () => {
    const proc = fakeProcess();
    const { lines, log } = recordingLog();
    installProcessGuards(proc, log);

    proc.emit('unhandledRejection', withCode('ECONNREFUSED', 'connect ECONNREFUSED'));
    proc.emit('uncaughtException', new Error('terminating connection due to administrator command'));

    assert.deepEqual(proc.exits, []);
    assert.deepEqual(lines.map((l) => l.level), ['warn', 'warn']);
  });

  test('a bug in a promise nobody awaited is logged loudly but does not take the service down', () => {
    const proc = fakeProcess();
    const { lines, log } = recordingLog();
    installProcessGuards(proc, log);

    proc.emit('unhandledRejection', new TypeError('x is not a function'));

    assert.deepEqual(proc.exits, []);
    assert.equal(lines[0].level, 'error');
  });

  test('an uncaught exception that is NOT an outage leaves unknown state: logged, then exit for the supervisor to restart', () => {
    const proc = fakeProcess();
    installProcessGuards(proc, recordingLog().log);

    proc.emit('uncaughtException', new TypeError('x is not a function'));

    assert.deepEqual(proc.exits, [1]);
  });
});

describe('HTTP while the database is down', () => {
  async function serve(deps: Partial<Parameters<typeof createHttpApp>[0]>) {
    const outage = withCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5434');
    const chat = { touchUser: async () => { throw outage; }, ...(deps.chat as object) } as never;
    const verifier = { verify: async () => ({ userId: 'u1', username: 'u1', displayName: 'U1' }), ...(deps.verifier as object) } as never;
    const server: Server = createServer(createHttpApp({ chat, verifier, corsOrigins: [], ready: deps.ready }));
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  const auth = { headers: { authorization: 'Bearer t' } };

  test('an authenticated request gets 503 + Retry-After (not a misleading 401, not a crash)', async () => {
    const s = await serve({});
    const res = await fetch(`${s.base}/api/me`, auth);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '5');
    assert.deepEqual(await res.json(), { code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable, please retry shortly' });
    await s.close();
  });

  test('a genuinely bad token is still a 401', async () => {
    const s = await serve({ verifier: { verify: async () => { throw new Error('bad signature'); } } as never });
    assert.equal((await fetch(`${s.base}/api/me`, auth)).status, 401);
    assert.equal((await fetch(`${s.base}/api/me`)).status, 401);
    await s.close();
  });

  test('a bug is still a 500, so it is not hidden as an outage', async () => {
    const s = await serve({ chat: { touchUser: async () => ({}), listRooms: async () => { throw new TypeError('x is not a function'); } } as never });
    const res = await fetch(`${s.base}/api/rooms`, auth);
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { code: string }).code, 'INTERNAL');
    await s.close();
  });

  test('/health stays 200 (the process is alive) while /ready says 503 (it cannot serve)', async () => {
    const s = await serve({ ready: async () => { throw withCode('ECONNREFUSED', 'connect ECONNREFUSED'); } });
    assert.equal((await fetch(`${s.base}/health`)).status, 200);
    const ready = await fetch(`${s.base}/ready`);
    assert.equal(ready.status, 503);
    assert.equal(((await ready.json()) as { status: string }).status, 'unavailable');
    await s.close();
  });

  test('/ready is 200 when the probe passes, and when there is no probe (in-memory mode)', async () => {
    const withProbe = await serve({ ready: async () => ({ rows: [] }) });
    const without = await serve({});
    assert.equal((await fetch(`${withProbe.base}/ready`)).status, 200);
    assert.equal((await fetch(`${without.base}/ready`)).status, 200);
    await withProbe.close(); await without.close();
  });
});

describe('the RabbitMQ connection loop', () => {
  const BINDINGS = [
    { exchange: 'wallet.events', queue: 'chat.wallet-events', routingKeys: ['transfer.completed'], handle: async () => undefined },
    { exchange: 'store.events', queue: 'chat.store-events', routingKeys: ['store.opened'], handle: async () => undefined },
  ];

  /** Runs the loop against fake connections. `script[i]` decides what the i-th connect attempt does (default: a working connection). */
  function harness(script: ((n: number) => Promise<AmqpConnectionLike>)[] = []) {
    const stop = new AbortController();
    const conns: FakeConnection[] = [];
    const delays: number[] = [];
    const { lines, log } = recordingLog();
    let attempts = 0;
    const connect = async () => {
      const step = script[attempts++];
      if (step) return step(attempts);
      const conn = new FakeConnection();
      conns.push(conn);
      return conn as unknown as AmqpConnectionLike;
    };
    const loop = connectLoop('amqp://x', BINDINGS, DEFAULT_RETRY_POLICY, { connect, sleep: async (ms) => { delays.push(ms); }, log, stop: stop.signal });
    return { stop, conns, delays, lines, loop, attempts: () => attempts };
  }
  const consuming = (c: FakeConnection) => c.channel.consumers.size === 2;
  async function finish(h: ReturnType<typeof harness>) {
    h.stop.abort();
    h.conns.forEach((c) => c.emit('close'));
    await h.loop;
  }

  test('it connects, declares the topology and consumes both queues', async () => {
    const h = harness();
    await until(() => h.conns.length === 1 && consuming(h.conns[0]));
    assert.deepEqual([...h.conns[0].channel.consumers.keys()].sort(), ['chat.store-events', 'chat.wallet-events']);
    assert.ok(h.lines.some((l) => /consuming chat\.wallet-events.*dead letters: chat\.wallet-events\.dlq/.test(l.text)));
    await finish(h);
  });

  test('when the connection is lost (broker restart) it reconnects and consumes again', async () => {
    const h = harness();
    await until(() => h.conns.length === 1 && consuming(h.conns[0]));

    h.conns[0].emit('close');

    await until(() => h.conns.length === 2 && consuming(h.conns[1]));
    assert.deepEqual(h.delays, [1000]);
    assert.ok(h.lines.some((l) => /the connection closed; reconnecting/.test(l.text)));
    await finish(h);
  });

  test('when only the CHANNEL is lost the whole session is rebuilt: consumers are never left silently dead', async () => {
    const h = harness();
    await until(() => h.conns.length === 1 && consuming(h.conns[0]));

    h.conns[0].channel.emit('close');

    await until(() => h.conns.length === 2 && consuming(h.conns[1]));
    assert.equal(h.conns[0].closed, true, 'the old connection was closed');
    await finish(h);
  });

  test('error events on the connection and the channel are logged, not thrown (an emitter with no listener would kill the process)', async () => {
    const h = harness();
    await until(() => h.conns.length === 1 && consuming(h.conns[0]));

    assert.doesNotThrow(() => h.conns[0].emit('error', new Error('socket hang up')));
    assert.doesNotThrow(() => h.conns[0].channel.emit('error', new Error('Channel closed by server: 406')));

    assert.ok(h.lines.some((l) => /connection error: socket hang up/.test(l.text)));
    assert.ok(h.lines.some((l) => /channel error: Channel closed by server: 406/.test(l.text)));
    assert.equal(h.conns.length, 1, 'an error alone does not restart a session that is still alive');
    await finish(h);
  });

  test('while RabbitMQ is down it keeps trying with growing delays, and the delay restarts from 1s once a session worked', async () => {
    const refused = async () => { throw withCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5672'); };
    const h = harness([refused, refused, refused]);

    await until(() => h.conns.length === 1 && consuming(h.conns[0]));
    assert.deepEqual(h.delays, [1000, 2000, 4000]);
    assert.ok(h.lines.some((l) => l.level === 'warn' && /cannot reach RabbitMQ.*retrying in 2000ms/.test(l.text)));

    h.conns[0].emit('close');
    await until(() => h.conns.length === 2);
    assert.deepEqual(h.delays, [1000, 2000, 4000, 1000]);
    await finish(h);
  });

  test('a queue declared with different settings is explained (how to fix it) and retried, not fatal', async () => {
    class MismatchedChannel extends FakeChannel {
      async assertQueue(): Promise<void> { throw new Error('Channel closed by server: 406 (PRECONDITION-FAILED) with message "PRECONDITION_FAILED - inequivalent arg \'x-dead-letter-exchange\'"'); }
    }
    const h = harness([async () => new FakeConnection(new MismatchedChannel()) as unknown as AmqpConnectionLike]);

    await until(() => h.conns.length === 1 && consuming(h.conns[0]));

    assert.ok(h.lines.some((l) => l.level === 'error' && /reset-chat-queues\.sh --yes/.test(l.text)));
    await finish(h);
  });
});

describe('an ack that cannot be sent', () => {
  test('is logged and left to redelivery: it is not mistaken for a handler failure and does not republish the message', async () => {
    class ClosedChannel extends FakeChannel { ack(): void { throw new Error('Channel closed'); } }
    const ch = new ClosedChannel();
    const spec = { exchange: 'wallet.events', queue: 'chat.wallet-events', routingKeys: ['transfer.completed'] };
    const { lines, log } = recordingLog();

    await processMessage(ch, spec, namesFor(spec.queue, DEFAULT_RETRY_POLICY), async () => undefined, { policy: DEFAULT_RETRY_POLICY, log },
      FakeChannel.message({ n: 1 }, { routingKey: 'transfer.completed' }));

    assert.equal(ch.published.length, 0, 'nothing was copied to a retry queue or the DLQ');
    assert.ok(lines.some((l) => /handled, but the ack could not be sent.*redeliver/.test(l.text)));
  });
});
