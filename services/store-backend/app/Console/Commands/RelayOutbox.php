<?php

namespace App\Console\Commands;

use App\Messaging\Backoff;
use App\Models\OutboxEvent;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;
use PhpAmqpLib\Connection\AMQPStreamConnection;
use App\Support\Correlation;
use PhpAmqpLib\Message\AMQPMessage;
use PhpAmqpLib\Wire\AMQPTable;

/**
 * Publishes outbox rows to RabbitMQ (at-least-once). Consumers must therefore be idempotent, and the chat's are.
 * If RabbitMQ is unreachable the rows simply stay in the table; the relay reconnects with backoff (1s, 2s, 4s ... 30s) and sends them
 * when the broker is back. With --once it makes one pass and exits non-zero on failure.
 */
class RelayOutbox extends Command
{
    public const MAX_ERROR_LENGTH = 2000;

    protected $signature = 'outbox:relay {--once : publish what is pending and exit}';
    protected $description = 'Publish pending outbox events (store.opened, store.closed, order.paid) to RabbitMQ';

    /**
     * Publishes pending rows one by one, in id order, and records what goes wrong.
     *
     * A row whose publish (or the broker's confirm) fails gets failed_attempts + 1 and a truncated last_error, and is NOT marked published.
     * The batch then stops, so a later row never overtakes the failing one, and the original error is rethrown for the caller to back off.
     * A later success sets published_at and clears last_error (failed_attempts stays as history).
     * If the broker accepts a message but marking the row fails, the row is sent again later: at-least-once, consumers are idempotent.
     *
     * @param callable(OutboxEvent): void $publish        publishes ONE row; throws if the broker did not confirm it
     * @param (callable(OutboxEvent): void)|null $onPublished called after a row was published and marked
     * @return int how many rows were published
     */
    public function relayPending(callable $publish, int $limit = 100, ?callable $onPublished = null): int
    {
        $published = 0;
        foreach (OutboxEvent::query()->whereNull('published_at')->orderBy('id')->limit($limit)->get() as $row) {
            try {
                $publish($row);
            } catch (\Throwable $e) {
                try {
                    $row->update([
                        'failed_attempts' => $row->failed_attempts + 1,
                        'last_error' => mb_substr(get_class($e).': '.$e->getMessage(), 0, self::MAX_ERROR_LENGTH),
                    ]);
                } catch (\Throwable) {
                    // The database is failing too: the broker error is the one worth reporting, so do not mask it.
                }

                throw $e;
            }
            $row->update(['published_at' => now(), 'attempts' => $row->attempts + 1, 'last_error' => null]);
            $published++;
            if ($onPublished !== null) {
                $onPublished($row);
            }
        }

        return $published;
    }

    public function handle(): int
    {
        $cfg = config('store.amqp');
        $failures = 0;

        while (true) {
            $connection = null;
            try {
                $connection = new AMQPStreamConnection($cfg['host'], $cfg['port'], $cfg['user'], $cfg['password']);
                $channel = $connection->channel();
                $channel->exchange_declare($cfg['store_exchange'], 'topic', false, true, false);
                $channel->confirm_select();    // the broker confirms each publish; only then do we mark the row as sent
                if ($failures > 0) {
                    $this->info("RabbitMQ is back after {$failures} failed attempt(s); sending what is pending");
                }
                $failures = 0;

                do {
                    // A row that cannot be published is recorded (failed_attempts, last_error) by relayPending(), then the failure
                    // reaches the catch below: the relay reconnects with backoff. Rows stay in order.
                    $this->relayPending(function (OutboxEvent $row) use ($channel) {
                        $message = new AMQPMessage(json_encode($row->payload), [
                            'content_type' => 'application/json', 'delivery_mode' => AMQPMessage::DELIVERY_MODE_PERSISTENT,
                            'application_headers' => new AMQPTable([Correlation::AMQP_HEADER => (string) ($row->payload['correlationId'] ?? Correlation::generate())]),
                        ]);
                        $channel->basic_publish($message, $row->exchange, $row->routing_key);
                        $channel->wait_for_pending_acks();           // the broker's confirm: only after it is the row marked as sent
                    }, 100, fn (OutboxEvent $row) => $this->line('[cid='.($row->payload['correlationId'] ?? '-')."] published {$row->routing_key} #{$row->id}"));
                    if ($this->option('once')) {
                        return self::SUCCESS;
                    }
                    sleep(1);
                } while (true);
            } catch (\Throwable $e) {
                if ($this->option('once')) {
                    $this->error("Could not publish: {$e->getMessage()}");

                    return self::FAILURE;
                }
                $failures++;
                $delay = Backoff::delayMs($failures);
                try {
                    $pending = OutboxEvent::query()->whereNull('published_at')->count();
                } catch (\Throwable) {
                    $pending = '?';      // the database is down too: say so rather than die
                }
                $this->error("Publishing failed ({$e->getMessage()}); {$pending} event(s) are waiting in the outbox; retrying in {$delay}ms");
                Log::error('[outbox] publishing failed', ['error' => $e->getMessage(), 'consecutive_failures' => $failures, 'pending' => $pending]);
                usleep($delay * 1000);
            } finally {
                try {
                    $connection?->close();
                } catch (\Throwable) {
                    // already closed
                }
            }
        }
    }
}
