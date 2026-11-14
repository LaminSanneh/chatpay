/**
 * Dead-letter tool.  See docs/runbooks/dead-letters.md.
 *   npm run dlq:list   -- <queue> [--limit 50]
 *   npm run dlq:replay -- <queue> [--limit 10] [--match text] [--to queue] [--yes]       (without --yes: a dry run)
 * The broker comes from AMQP_URL (default amqp://chatpay:chatpay@localhost:5672). Works for chat.wallet-events.dlq, chat.store-events.dlq
 * and store.wallet-events.dlq.
 */
import amqp from 'amqplib';
import { type DeadLetter, listDeadLetters, replayDeadLetters } from './dlq';

export interface CliArgs {
  command: 'list' | 'replay';
  queue: string;
  limit: number;
  match?: string;
  to?: string;
  yes: boolean;
}

export const USAGE = `usage:
  dlq:list   <queue> [--limit 50]
  dlq:replay <queue> [--limit 10] [--match text] [--to queue] [--yes]    (without --yes nothing is moved)`;

export function parseArgs(argv: string[]): CliArgs {
  const [command, queue, ...rest] = argv;
  if ((command !== 'list' && command !== 'replay') || !queue || queue.startsWith('--')) throw new Error(USAGE);
  const args: CliArgs = { command, queue, limit: command === 'list' ? 50 : 10, yes: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => { const v = rest[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`); return v; };
    if (flag === '--limit') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new Error(`--limit must be a whole number >= 1\n${USAGE}`);
      args.limit = n;
    } else if (flag === '--match' && command === 'replay') args.match = value();
    else if (flag === '--to' && command === 'replay') args.to = value();
    else if (flag === '--yes' && command === 'replay') args.yes = true;
    else throw new Error(`unknown option ${flag}\n${USAGE}`);
  }
  return args;
}

export function formatDeadLetter(d: DeadLetter): string {
  const replayed = d.replayCount ? `  (replayed ${d.replayCount}x before)` : '';
  return [
    `#${d.position}  ${d.failureKind ?? '?'}  retries=${d.retryCount}  ${d.failedAt ?? 'unknown time'}${replayed}`,
    `    from ${d.originalQueue ?? '?'} / ${d.originalRoutingKey ?? '?'}   ${d.errorClass ?? ''}: ${d.error ?? '(no error recorded)'}`,
    `    ${d.correlationId ? 'cid=' + d.correlationId + '  ' : ''}${d.bytes} bytes: ${d.preview}`,
  ].join('\n');
}

async function main() {
  let args: CliArgs;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); process.exit(2); }
  const conn = await amqp.connect(process.env.AMQP_URL ?? 'amqp://chatpay:chatpay@localhost:5672');
  const ch = await conn.createConfirmChannel();
  try {
    if (args.command === 'list') {
      const letters = await listDeadLetters(ch, args.queue, { limit: args.limit });
      if (!letters.length) console.log(`${args.queue} is empty.`);
      letters.forEach((d) => console.log(formatDeadLetter(d) + '\n'));
      if (letters.length === args.limit) console.log(`(showing the first ${args.limit}; use --limit for more)`);
      return;
    }
    const result = await replayDeadLetters(ch, args.queue, { limit: args.limit, match: args.match, to: args.to, dryRun: !args.yes });
    result.skipped.forEach((s) => console.log(`skipped #${s.position}: ${s.reason}`));
    if (!args.yes) console.log(`Dry run: would replay ${result.wouldReplay} message(s) from ${args.queue}. Nothing was moved; add --yes to do it.`);
    else console.log(`Replayed ${result.replayed} message(s) from ${args.queue}.`);
    if (result.stoppedBecause) { console.error(result.stoppedBecause); process.exitCode = 1; }
  } finally {
    await ch.close().catch(() => undefined);
    await conn.close().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
