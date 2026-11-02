<?php

namespace App\Console\Commands;

use App\Models\OutboxEvent;
use Illuminate\Console\Command;
use PhpAmqpLib\Connection\AMQPStreamConnection;
use PhpAmqpLib\Message\AMQPMessage;

/** Publishes outbox rows to RabbitMQ (at-least-once). Consumers must therefore be idempotent, and the chat's are. */
class RelayOutbox extends Command
{
    protected $signature = 'outbox:relay {--once : publish what is pending and exit}';
    protected $description = 'Publish pending outbox events (store.opened, store.closed, order.paid) to RabbitMQ';

    public function handle(): int
    {
        $cfg = config('store.amqp');
        $connection = new AMQPStreamConnection($cfg['host'], $cfg['port'], $cfg['user'], $cfg['password']);
        $channel = $connection->channel();
        $channel->exchange_declare($cfg['store_exchange'], 'topic', false, true, false);
        $channel->confirm_select();    // the broker confirms each publish; only then do we mark the row as sent

        do {
            $rows = OutboxEvent::query()->whereNull('published_at')->orderBy('id')->limit(100)->get();
            foreach ($rows as $row) {
                $message = new AMQPMessage(json_encode($row->payload), [
                    'content_type' => 'application/json', 'delivery_mode' => AMQPMessage::DELIVERY_MODE_PERSISTENT,
                ]);
                $channel->basic_publish($message, $row->exchange, $row->routing_key);
                $channel->wait_for_pending_acks();
                $row->update(['published_at' => now(), 'attempts' => $row->attempts + 1]);
                $this->line("published {$row->routing_key} #{$row->id}");
            }
            if ($this->option('once')) {
                break;
            }
            sleep(1);
        } while (true);

        $channel->close();
        $connection->close();

        return self::SUCCESS;
    }
}
