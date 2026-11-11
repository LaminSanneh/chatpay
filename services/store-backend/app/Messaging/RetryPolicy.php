<?php

namespace App\Messaging;

/** How a failed message is retried: exponential backoff, a bounded number of times. Mirrors services/chat-service/src/messaging/retry-policy.ts. */
final class RetryPolicy
{
    public function __construct(
        public readonly int $initialDelayMs = 2000,
        public readonly float $multiplier = 2.0,
        public readonly int $maxDelayMs = 30000,
        /** How many RETRIES follow the first failed delivery. After that the message is dead-lettered. */
        public readonly int $maxAttempts = 5,
    ) {
        if ($initialDelayMs < 1 || $multiplier < 1 || $maxDelayMs < 1 || $maxAttempts < 0) {
            throw new \InvalidArgumentException('Invalid retry policy');
        }
    }

    public static function fromConfig(array $config): self
    {
        return new self(
            (int) ($config['initial_delay_ms'] ?? 2000),
            (float) ($config['multiplier'] ?? 2.0),
            (int) ($config['max_delay_ms'] ?? 30000),
            (int) ($config['max_attempts'] ?? 5),
        );
    }

    /** Delay before retry number $retryNumber (1 = the first retry). Defaults: 2s, 4s, 8s, 16s, 30s (capped). */
    public function delayForRetry(int $retryNumber): int
    {
        return (int) min(round($this->initialDelayMs * ($this->multiplier ** max(0, $retryNumber - 1))), $this->maxDelayMs);
    }

    /** @return list<int> The distinct delays this policy produces, in order: one retry queue exists per delay. */
    public function delays(): array
    {
        $delays = [];
        for ($n = 1; $n <= $this->maxAttempts; $n++) {
            $delays[] = $this->delayForRetry($n);
        }

        return array_values(array_unique($delays));
    }
}
