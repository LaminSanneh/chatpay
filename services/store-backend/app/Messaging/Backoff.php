<?php

namespace App\Messaging;

/** Wait times for a worker that keeps failing to reach a dependency (RabbitMQ): 1s, 2s, 4s ... capped. Resets when it works again. */
final class Backoff
{
    public static function delayMs(int $consecutiveFailures, int $baseMs = 1000, int $maxMs = 30000): int
    {
        if ($consecutiveFailures < 1) {
            return 0;
        }

        return (int) min($baseMs * (2 ** min($consecutiveFailures - 1, 30)), $maxMs);
    }
}
