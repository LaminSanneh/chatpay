import { isDependencyOutage } from '../messaging/retry-policy';

export interface Log {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/** The part of `process` the guards use (so they can be tested without touching the real process). */
export interface ProcessLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  exit(code?: number): unknown;
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A safety net, NOT a substitute for handling errors where they happen (the database pool and the AMQP loop do that).
 *  - an unhandled rejection or uncaught exception caused by an unavailable dependency is logged calmly and the process keeps running;
 *  - an unhandled rejection from anything else is logged loudly (it is a bug) but does not take the service down;
 *  - an uncaught exception from anything else leaves the process in an unknown state, so it is logged and the process exits for a supervisor to restart.
 */
export function installProcessGuards(proc: ProcessLike = process, log: Log = console): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    if (isDependencyOutage(reason)) log.warn(`[process] a dependency is unavailable (${describe(reason)}); it will be retried`);
    else log.error('[process] unhandled promise rejection (a bug: nobody handled this error):', reason);
  });
  proc.on('uncaughtException', (err: unknown) => {
    if (isDependencyOutage(err)) {
      log.warn(`[process] a dependency is unavailable (${describe(err)}); it will be retried`);
      return;
    }
    log.error('[process] uncaught exception, exiting so a supervisor can restart the service:', err);
    proc.exit(1);
  });
}
