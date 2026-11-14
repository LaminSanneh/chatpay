<?php

namespace App\Services;

use App\Support\Correlation;
use App\Models\OutboxEvent;

/**
 * Writes an event to the outbox table. Call it inside the same DB transaction as the change it describes;
 * `php artisan outbox:relay` then publishes it to RabbitMQ (at-least-once), so a crash can never lose an event.
 */
class EventPublisher
{
    public function publish(string $exchange, string $routingKey, array $payload): void
    {
        OutboxEvent::create([
            'exchange' => $exchange,
            'routing_key' => $routingKey,
            // The correlation id is part of the stored event, so it survives a crash and the relay can publish it as the x-correlation-id header.
            'payload' => $payload + ['version' => 1, 'occurredAt' => now()->toIso8601String(), 'correlationId' => Correlation::currentOrNew()],
        ]);
    }
}
