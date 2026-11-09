import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import {
  classifyError, DEFAULT_RETRY_POLICY, delayForRetry, describeError, PermanentError, retryDelays, retryPolicyFromEnv, TransientError,
} from '../src/messaging/retry-policy';

const withCode = (code: string, message = 'boom') => Object.assign(new Error(message), { code });

describe('backoff', () => {
  test('defaults wait 2s, 4s, 8s, 16s and then stay at the 30s cap', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => delayForRetry(DEFAULT_RETRY_POLICY, n)), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  test('one retry queue per DISTINCT delay: the cap does not create duplicates', () => {
    assert.deepEqual(retryDelays(DEFAULT_RETRY_POLICY), [2000, 4000, 8000, 16000, 30000]);
    const capped = { initialDelayMs: 1000, multiplier: 3, maxDelayMs: 5000, maxAttempts: 5 };
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => delayForRetry(capped, n)), [1000, 3000, 5000, 5000, 5000]);
    assert.deepEqual(retryDelays(capped), [1000, 3000, 5000]);
  });

  test('a multiplier of 1 is a constant delay; zero attempts means no retry queues at all', () => {
    assert.deepEqual(retryDelays({ initialDelayMs: 500, multiplier: 1, maxDelayMs: 9999, maxAttempts: 4 }), [500]);
    assert.deepEqual(retryDelays({ ...DEFAULT_RETRY_POLICY, maxAttempts: 0 }), []);
  });
});

describe('classifying a failure', () => {
  test('things retrying can never fix are permanent', () => {
    assert.equal(classifyError(new PermanentError('no')), 'permanent');
    assert.equal(classifyError((() => { try { JSON.parse('{not json'); } catch (e) { return e; } })()), 'permanent');
    assert.equal(classifyError((() => { try { z.object({ a: z.string() }).parse({}); } catch (e) { return e; } })()), 'permanent');
    assert.equal(classifyError(withCode('22P02')), 'permanent');       // Postgres: invalid text representation
    assert.equal(classifyError(withCode('23505')), 'permanent');       // Postgres: unique violation
  });

  test('network and database trouble is transient', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P03', '08006', '53300', '40001', '40P01']) {
      assert.equal(classifyError(withCode(code)), 'transient', code);
    }
    assert.equal(classifyError(new TransientError('later')), 'transient');
    assert.equal(classifyError(new Error('Connection terminated unexpectedly')), 'transient');
    assert.equal(classifyError(new Error('timeout exceeded when trying to connect')), 'transient');
  });

  test('anything we cannot classify is retried (bounded) rather than dropped', () => {
    assert.equal(classifyError(new Error('something odd')), 'transient');
    assert.equal(classifyError('a string'), 'transient');
    assert.equal(classifyError(undefined), 'transient');
  });

  test('error descriptions are short enough to travel in headers', () => {
    const d = describeError(new Error('x'.repeat(5000)));
    assert.equal(d.message.length, 500);
    assert.ok(d.stack.length <= 2000);
    assert.equal(describeError('plain').message, 'plain');
  });
});

describe('policy from environment', () => {
  test('defaults, overrides and refusal of nonsense', () => {
    assert.deepEqual(retryPolicyFromEnv({}), DEFAULT_RETRY_POLICY);
    assert.deepEqual(retryPolicyFromEnv({ RETRY_INITIAL_MS: '100', RETRY_MULTIPLIER: '3', RETRY_MAX_MS: '900', RETRY_MAX_ATTEMPTS: '2' }),
      { initialDelayMs: 100, multiplier: 3, maxDelayMs: 900, maxAttempts: 2 });
    assert.throws(() => retryPolicyFromEnv({ RETRY_INITIAL_MS: 'soon' }), /RETRY_INITIAL_MS/);
    assert.throws(() => retryPolicyFromEnv({ RETRY_MULTIPLIER: '0.5' }), /RETRY_MULTIPLIER/);
    assert.throws(() => retryPolicyFromEnv({ RETRY_MAX_ATTEMPTS: '-1' }), /RETRY_MAX_ATTEMPTS/);
  });
});
