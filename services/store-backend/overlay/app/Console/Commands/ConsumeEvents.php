<?php

namespace App\Console\Commands;

use App\Messaging\AmqpLibChannel;
use App\Messaging\Backoff;
use App\Messaging\MessageProcessor;
use App\Messaging\RetryPolicy;
use App\Messaging\Topology;
use App\Services\OrderService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;
use PhpAmqpLib\Connection\AMQPStreamConnection;
use PhpAmqpLib\Message\AMQPMessage;

/**
 * Long-running worker: listens to the wallet's events (payment received, settlement done).
 *
 * Failures are retried with exponential backoff and then dead-lettered (see app/Messaging); a lost RabbitMQ connection is
 * re-established with backoff, so this worker survives a broker restart without a supervisor (a supervisor still restarts it if it crashes).
 */
class ConsumeEvents extends Command
{
    protected $signature = 'events:consume';
    protected $description = 'Consume wallet events from RabbitMQ (transfer.completed, settlement.completed)';

    public function handle(OrderService $orders): int
    {
        $cfg = config('store.amqp');
        $policy = RetryPolicy::fromConfig(config('store.retry'));
        $failures = 0;

        while (true) {
            $connection = null;
            try {
                $connection = new AMQPStreamConnection($cfg['host'], $cfg['port'], $cfg['user'], $cfg['password']);
                $channel = $connection->channel();
                $port = new AmqpLibChannel($channel);
                $names = Topology::declare($port, $cfg, $policy, ['transfer.completed', 'settlement.completed']);
                $channel->basic_qos(0, 10, false);

                $handler = fn (string $key, array $data) => match ($key) {
                    'transfer.completed' => $orders->onTransferCompleted($data),
                    'settlement.completed' => $orders->onSettlementCompleted($data),
                    default => null,
                };
                $channel->basic_consume($names['main'], '', false, false, false, false, function (AMQPMessage $message) use ($port, $handler, $names, $policy) {
                    MessageProcessor::process($port, AmqpLibChannel::delivery($message), $handler, $names, $policy,
                        static fn (string $line) => Log::warning("[events] {$line}"));
                });

                $this->info("Consuming {$names['main']} from {$cfg['wallet_exchange']}; retries: ".implode(', ', array_map(fn ($d) => "{$d}ms", array_keys($names['retryQueues']))).'; dead letters: '.$names['dlq']);
                $failures = 0;
                while ($channel->is_consuming()) {
                    $channel->wait();
                }
            } catch (\Throwable $e) {
                $failures++;
                $delay = Backoff::delayMs($failures);
                $this->error("Lost RabbitMQ ({$e->getMessage()}); reconnecting in {$delay}ms");
                Log::error('[events] connection lost', ['error' => $e->getMessage(), 'consecutive_failures' => $failures]);
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
