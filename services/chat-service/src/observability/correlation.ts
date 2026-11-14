import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Correlation ids: one id follows a request through every service, its outbox event, the RabbitMQ message, the consumer's log lines and any
 * dead letter, so "what happened to this payment?" is a single search.
 *
 * The id lives in an AsyncLocalStorage, so it follows the async call chain without being passed around, and concurrent requests/messages
 * never see each other's id.
 */
export const CORRELATION_HEADER = 'x-correlation-id';
export const CORRELATION_RESPONSE_HEADER = 'X-Correlation-Id';

const store = new AsyncLocalStorage<string>();
/** Letters, digits and . _ : - only, at most 64 characters: anything else (spaces, newlines, huge values) could forge or flood log lines. */
const VALID = /^[A-Za-z0-9._:-]{1,64}$/;

export const newCorrelationId = (): string => randomUUID();

export function normalizeCorrelationId(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && VALID.test(value) ? value : undefined;
}

/** The id of the request or message being handled, or undefined outside of one. */
export const currentCorrelationId = (): string | undefined => store.getStore();

/** Runs `fn` (and everything it awaits) with this id; an absent or invalid id is replaced by a new one. */
export function runWithCorrelation<T>(id: unknown, fn: () => T): T {
  return store.run(normalizeCorrelationId(id) ?? newCorrelationId(), fn);
}

/** Express: take X-Correlation-Id from the request (or make one), return it on the response, and run the rest of the request with it. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = normalizeCorrelationId(req.headers[CORRELATION_HEADER]) ?? newCorrelationId();
  res.setHeader(CORRELATION_RESPONSE_HEADER, id);
  store.run(id, () => next());
}

/** Socket.IO: every incoming event gets its own id, so a message:send can be followed through the logs. Use with `socket.use(...)`. */
export function socketCorrelation(_packet: unknown, next: (err?: Error) => void): void {
  store.run(newCorrelationId(), () => next());
}

type LogMethod = (...args: unknown[]) => void;
export interface ConsoleLike { log: LogMethod; info: LogMethod; warn: LogMethod; error: LogMethod; debug: LogMethod }

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** Puts `[cid=<id>]` in front of every line logged while a correlation id is active. Returns a function that undoes it. */
export function installCorrelatedConsole(target: ConsoleLike = console as unknown as ConsoleLike): () => void {
  const originals = new Map<string, LogMethod>();
  for (const level of LEVELS) {
    const original = target[level].bind(target);
    originals.set(level, target[level]);
    target[level] = (...args: unknown[]) => {
      const id = currentCorrelationId();
      original(...(id ? [`[cid=${id}]`, ...args] : args));
    };
  }
  return () => { for (const level of LEVELS) target[level] = originals.get(level)!; };
}

/** A logger that tags each line with the active correlation id (for code that takes a logger as a parameter). */
export function createCorrelatedLogger(target: ConsoleLike = console as unknown as ConsoleLike) {
  const tag = (args: unknown[]) => { const id = currentCorrelationId(); return id ? [`[cid=${id}]`, ...args] : args; };
  return {
    info: (m: string, d?: unknown) => target.log(...tag(d === undefined ? [m] : [m, d])),
    warn: (m: string, d?: unknown) => target.warn(...tag(d === undefined ? [m] : [m, d])),
    error: (m: string, d?: unknown) => target.error(...tag(d === undefined ? [m] : [m, d])),
  };
}

/** The id a message was published with: its x-correlation-id header, else a correlationId field in its JSON body, else none (a new one is made). */
export function correlationOf(msg: { content: Buffer; properties: { headers?: Record<string, unknown> } }): string | undefined {
  const fromHeader = normalizeCorrelationId(msg.properties.headers?.[CORRELATION_HEADER]);
  if (fromHeader) return fromHeader;
  try {
    return normalizeCorrelationId((JSON.parse(msg.content.toString('utf8')) as { correlationId?: unknown }).correlationId);
  } catch {
    return undefined;
  }
}
