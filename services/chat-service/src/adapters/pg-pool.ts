import { Pool, type PoolConfig } from 'pg';
import { reconnectDelayMs } from '../messaging/retry-policy';
import type { Log } from '../resilience/process-guards';

/**
 * The one place a Postgres pool is created.
 *
 * pg emits 'error' on the POOL when an IDLE connection is lost (the database was stopped or restarted, or the network dropped). A pool without
 * an 'error' listener turns that into an uncaught exception and the whole service dies. With the listener the dead connection is discarded and
 * the next query opens a new one, so the service survives a database outage and recovers when the database returns.
 */
export function createPool(connectionString: string, log: Log = console, overrides: PoolConfig = {}): Pool {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    connectionTimeoutMillis: 5_000,     // a query fails after 5s instead of waiting forever for a connection
    query_timeout: 15_000,              // ...and a query stuck on a dead connection fails after 15s
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    ...overrides,
  });
  pool.on('error', (err) => log.warn(`[db] an idle connection was lost (${err.message}); the pool reconnects on the next query`));
  return pool;
}

export interface WaitOptions {
  log?: Log;
  sleep?: (ms: number) => Promise<void>;
  /** Give up after this many attempts (default: never; used by tests). */
  maxAttempts?: number;
}

/** Startup: wait (with backoff) for the database instead of dying because it is not up yet. */
export async function waitForDatabase(pool: Pick<Pool, 'query'>, opts: WaitOptions = {}): Promise<void> {
  const log = opts.log ?? console;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let failures = 0;
  for (;;) {
    try {
      await pool.query('select 1');
      if (failures > 0) log.info(`[db] reachable again after ${failures} failed attempt(s)`);
      return;
    } catch (err) {
      failures++;
      if (opts.maxAttempts !== undefined && failures >= opts.maxAttempts) throw err;
      const delay = reconnectDelayMs(failures);
      log.warn(`[db] not reachable yet (${(err as Error).message}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}
