<?php

namespace App\Console\Commands;

use App\Services\OrderService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;
use PhpAmqpLib\Connection\AMQPStreamConnection;
use PhpAmqpLib\Message\AMQPMessage;
use PhpAmqpLib\Wire\AMQPTable;

/** Long-running worker: listens to the wallet's events (payment received, settlement done). Run it under a supervisor. */
class ConsumeEvents extends Command
{
    protected $signature = 'events:consume';
    protected $description = 'Consume wallet events from RabbitMQ (transfer.completed, settlement.completed)';

    public function handle(OrderService $orders): int
    {
        $cfg = config('store.amqp');
        $connection = new AMQPStreamConnection($cfg['host'], $cfg['port'], $cfg['user'], $cfg['password']);
        $channel = $connection->channel();

        $channel->exchange_declare($cfg['wallet_exchange'], 'topic', false, true, false);
        // Messages we cannot process are routed to a dead-letter queue instead of being lost (inspect them in the RabbitMQ UI).
        // NOTE: RabbitMQ refuses to redeclare an existing queue with different arguments: delete `store.wallet-events` once if it already exists.
        $channel->exchange_declare($cfg['dead_letter_exchange'], 'fanout', false, true, false);
        $channel->queue_declare($cfg['wallet_queue'].'.dlq', false, true, false, false);
        $channel->queue_bind($cfg['wallet_queue'].'.dlq', $cfg['dead_letter_exchange']);
        $channel->queue_declare($cfg['wallet_queue'], false, true, false, false, false,
            new AMQPTable(['x-dead-letter-exchange' => $cfg['dead_letter_exchange']]));   // durable: events wait while we are down
        foreach (['transfer.completed', 'settlement.completed'] as $key) {
            $channel->queue_bind($cfg['wallet_queue'], $cfg['wallet_exchange'], $key);
        }
        $channel->basic_qos(0, 10, false);

        $channel->basic_consume($cfg['wallet_queue'], '', false, false, false, false, function (AMQPMessage $message) use ($orders) {
            $key = $message->getRoutingKey();
            try {
                $data = json_decode($message->getBody(), true, 512, JSON_THROW_ON_ERROR);
                match ($key) {
                    'transfer.completed' => $orders->onTransferCompleted($data),
                    'settlement.completed' => $orders->onSettlementCompleted($data),
                    default => null,
                };
                $message->ack();
            } catch (\Throwable $e) {
                // Unprocessable: reject without requeue, which sends it to the dead-letter queue.
                Log::error("Could not process {$key}", ['error' => $e->getMessage()]);
                $message->nack(false, false);
            }
        });

        $this->info("Consuming {$cfg['wallet_queue']} from {$cfg['wallet_exchange']}");
        while ($channel->is_consuming()) {
            $channel->wait();
        }

        return self::SUCCESS;
    }
}
