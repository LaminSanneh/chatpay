<?php

namespace App\Messaging;

/** The few broker operations the retry logic needs. AmqpLibChannel implements it over php-amqplib; tests use a fake. */
interface ChannelPort
{
    public function declareExchange(string $name, string $type): void;

    /** @param array<string, mixed> $arguments */
    public function declareQueue(string $name, array $arguments = []): void;

    public function bind(string $queue, string $exchange, string $routingKey = ''): void;

    /**
     * Publishes a persistent message and WAITS for the broker to confirm it; throws if the broker does not.
     *
     * @param array<string, mixed> $headers
     */
    public function publish(string $exchange, string $routingKey, string $body, array $headers, ?string $contentType, ?string $messageId): void;

    public function ack(mixed $tag): void;

    /** Gives the message back to its queue. */
    public function requeue(mixed $tag): void;
}
