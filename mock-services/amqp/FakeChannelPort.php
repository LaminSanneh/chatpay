<?php

/**
 * Permanent in-memory stand-in for the store backend's ChannelPort (the broker operations its retry logic uses), for unit tests without a
 * broker. It records what is declared, published, acked and requeued. It does not route messages or run TTLs: that is the broker's job and
 * is proven by the resilience script. Counterpart of mock-services/amqp/fake-channel.ts (used by the chat service's tests).
 */

namespace MockServices\Amqp;

use App\Messaging\ChannelPort;

final class FakeChannelPort implements ChannelPort
{
    /** @var array<string, string> */
    public array $exchanges = [];
    /** @var array<string, array<string, mixed>> */
    public array $queues = [];
    /** @var list<array{queue: string, exchange: string, key: string}> */
    public array $bindings = [];
    /** @var list<array{exchange: string, key: string, body: string, headers: array<string, mixed>, contentType: ?string, messageId: ?string}> */
    public array $published = [];
    public array $acked = [];
    public array $requeued = [];
    /** Set to make publish() fail, as if the broker did not confirm. */
    public ?\Throwable $publishFailure = null;

    public function declareExchange(string $name, string $type): void
    {
        $this->exchanges[$name] = $type;
    }

    public function declareQueue(string $name, array $arguments = []): void
    {
        $this->queues[$name] = $arguments;
    }

    public function bind(string $queue, string $exchange, string $routingKey = ''): void
    {
        $this->bindings[] = ['queue' => $queue, 'exchange' => $exchange, 'key' => $routingKey];
    }

    public function publish(string $exchange, string $routingKey, string $body, array $headers, ?string $contentType, ?string $messageId): void
    {
        if ($this->publishFailure !== null) {
            throw $this->publishFailure;
        }
        $this->published[] = ['exchange' => $exchange, 'key' => $routingKey, 'body' => $body, 'headers' => $headers, 'contentType' => $contentType, 'messageId' => $messageId];
    }

    public function ack(mixed $tag): void
    {
        $this->acked[] = $tag;
    }

    public function requeue(mixed $tag): void
    {
        $this->requeued[] = $tag;
    }
}
