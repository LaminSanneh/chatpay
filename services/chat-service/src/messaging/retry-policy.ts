/**
 * Retry policy and failure classification for message consumers.
 *
 *   transient  something that may work if we try again later (database briefly down, network blip, deadlock)
 *   permanent  something retrying can never fix (malformed JSON, a payload that fails validation)
 *
 * Transient failures are retried with exponential backoff, a bounded number of times, then dead-lettered.
 * Permanent failures are dead-lettered at once. A failure we cannot classify is treated as transient: losing a message is worse than delaying it,
 * and the retries are bounded, so a poison message still ends up in the dead-letter queue.
 */
export type FailureKind = 'transient' | 'permanent';

/** Throw this from a handler when you KNOW retrying is pointless. */
export class PermanentError extends Error {
  override name = 'PermanentError';
}
/** Throw this from a handler when you KNOW retrying may help. */
export class TransientError extends Error {
  override name = 'TransientError';
}

export interface RetryPolicy {
  /** Delay before the first retry. */
  initialDelayMs: number;
  /** Each further retry waits this many times longer. */
  multiplier: number;
  /** The delay never grows beyond this. */
  maxDelayMs: number;
  /** How many RETRIES follow the first failed delivery. After that the message is dead-lettered. */
  maxAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { initialDelayMs: 2_000, multiplier: 2, maxDelayMs: 30_000, maxAttempts: 5 };

/** Delay before retry number `retryNumber` (1 = the first retry). With the defaults: 2s, 4s, 8s, 16s, 30s (capped). */
export function delayForRetry(policy: RetryPolicy, retryNumber: number): number {
  const raw = policy.initialDelayMs * Math.pow(policy.multiplier, Math.max(0, retryNumber - 1));
  return Math.min(Math.round(raw), policy.maxDelayMs);
}

/** The distinct delays a policy can produce, in order. One retry queue exists per delay. */
export function retryDelays(policy: RetryPolicy): number[] {
  const delays: number[] = [];
  for (let n = 1; n <= policy.maxAttempts; n++) {
    const d = delayForRetry(policy, n);
    if (!delays.includes(d)) delays.push(d);
  }
  return delays;
}

export function retryPolicyFromEnv(env: Record<string, string | undefined> = process.env): RetryPolicy {
  const num = (name: string, fallback: number, min: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number >= ${min}, got "${raw}"`);
    return value;
  };
  return {
    initialDelayMs: num('RETRY_INITIAL_MS', DEFAULT_RETRY_POLICY.initialDelayMs, 1),
    multiplier: num('RETRY_MULTIPLIER', DEFAULT_RETRY_POLICY.multiplier, 1),
    maxDelayMs: num('RETRY_MAX_MS', DEFAULT_RETRY_POLICY.maxDelayMs, 1),
    maxAttempts: num('RETRY_MAX_ATTEMPTS', DEFAULT_RETRY_POLICY.maxAttempts, 0),
  };
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED']);

export function classifyError(err: unknown): FailureKind {
  if (err instanceof PermanentError) return 'permanent';
  if (err instanceof TransientError) return 'transient';
  const e = (err ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  if (err instanceof SyntaxError || e.name === 'ZodError') return 'permanent';        // bad JSON, payload fails validation

  const code = typeof e.code === 'string' ? e.code : '';
  if (NETWORK_CODES.has(code)) return 'transient';
  // PostgreSQL SQLSTATE: 08 connection, 53 resources, 57P01-03 shutdown, 40001 serialization failure, 40P01 deadlock
  if (/^(08|53|57P0[123])/.test(code) || code === '40001' || code === '40P01') return 'transient';
  // 22 data exception, 23 integrity violation: the same input will fail the same way
  if (/^(22|23)/.test(code)) return 'permanent';
  if (/connection terminated|timeout exceeded when trying to connect|too many clients|connection refused/i.test(String(e.message ?? ''))) return 'transient';

  return 'transient';
}

/** Short, header-safe description of an error. */
export function describeError(err: unknown): { name: string; message: string; stack: string } {
  const e = err instanceof Error ? err : new Error(String(err));
  return { name: e.name || 'Error', message: e.message.slice(0, 500), stack: (e.stack ?? '').slice(0, 2000) };
}

const OUTAGE_MESSAGE = /connection terminated|timeout exceeded when trying to connect|too many clients|connection refused|server closed the connection unexpectedly|terminating connection|database system is (starting up|shutting down)|channel closed|connection closed|socket (closed|hang up)|heartbeat timeout|client has encountered a connection error/i;

/**
 * True when the error means a dependency (the database, RabbitMQ) is unreachable or going away, as opposed to a bug or bad input.
 * Such errors are expected during an outage: they must be logged calmly and recovered from, never crash the process.
 */
export function isDependencyOutage(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (NETWORK_CODES.has(code)) return true;
  if (/^(08|53|57P0[123])/.test(code)) return true;                  // Postgres: connection, resources, shutdown
  return OUTAGE_MESSAGE.test(String(e.message ?? ''));
}

/** Wait before reconnecting after `failures` consecutive failures: 1s, 2s, 4s ... capped at 30s. */
export function reconnectDelayMs(failures: number, baseMs = 1_000, maxMs = 30_000): number {
  if (failures < 1) return 0;
  return Math.min(baseMs * Math.pow(2, Math.min(failures - 1, 30)), maxMs);
}
