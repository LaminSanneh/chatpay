<?php

namespace App\Messaging;

/** One message handed to a consumer. */
final class Delivery
{
    /** @param array<string, mixed> $headers */
    public function __construct(
        public readonly string $body,
        public readonly string $routingKey,
        public readonly array $headers,
        public readonly mixed $tag,
        public readonly ?string $messageId = null,
        public readonly ?string $contentType = 'application/json',
    ) {
    }
}
