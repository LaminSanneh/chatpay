<?php

namespace App\Messaging;

use App\Support\Correlation;

/**
 * One delivery, start to finish. Never throws, never loses the message:
 *   handler succeeds                       -> ack
 *   fails, transient, retries left         -> copy to the retry queue for the next backoff step (confirmed), then ack the original
 *   fails, permanent or retries used up    -> copy to the dead-letter exchange with the error in headers (confirmed), then ack the original
 *   the copy itself cannot be published    -> give the original back to its queue, so nothing is dropped
 * The header names match services/chat-service/src/messaging/consumer-runner.ts so one dead-letter tool serves both (docs/runbooks/dead-letters.md).
 */
final class MessageProcessor
{
    public const H_RETRY_COUNT = 'x-retry-count';
    public const H_ORIGINAL_KEY = 'x-original-routing-key';
    public const H_ORIGINAL_QUEUE = 'x-original-queue';
    public const H_KIND = 'x-failure-kind';
    public const H_CLASS = 'x-error-class';
    public const H_ERROR = 'x-error';
    public const H_STACK = 'x-error-stack';
    public const H_FIRST_FAILED = 'x-first-failed-at';
    public const H_FAILED = 'x-failed-at';
    public const H_CORRELATION = Correlation::AMQP_HEADER;

    /**
     * @param callable(string, array): void $handler  receives the ORIGINAL routing key and the decoded payload
     * @param array{main: string, dlq: string, dlx: string, retryQueues: array<int, string>} $names
     * @param (callable(string): void)|null $log
     * @param (callable(): \DateTimeInterface)|null $now
     */
    public static function process(
        ChannelPort $ch, Delivery $delivery, callable $handler, array $names, RetryPolicy $policy,
        ?callable $log = null, ?callable $now = null, int $requeueDelayMs = 1000,
    ): void {
        // The whole delivery (the handler, every log line, the events it publishes, the retry or dead-letter copy) runs under the id the message arrived with.
        Correlation::within(self::correlationOf($delivery), static fn () => self::processDelivery($ch, $delivery, $handler, $names, $policy, $log, $now, $requeueDelayMs));
    }

    /** The id a message was published with: its x-correlation-id header, else a correlationId field in its JSON body, else none (a new one is made). */
    public static function correlationOf(Delivery $delivery): ?string
    {
        $fromHeader = Correlation::sanitize($delivery->headers[Correlation::AMQP_HEADER] ?? null);
        if ($fromHeader !== null) {
            return $fromHeader;
        }
        $payload = json_decode($delivery->body, true);

        return is_array($payload) ? Correlation::sanitize($payload['correlationId'] ?? null) : null;
    }

    private static function processDelivery(
        ChannelPort $ch, Delivery $delivery, callable $handler, array $names, RetryPolicy $policy,
        ?callable $log, ?callable $now, int $requeueDelayMs,
    ): void {
        $log ??= static fn (string $m) => null;
        $retriesDone = (int) ($delivery->headers[self::H_RETRY_COUNT] ?? 0);
        // A retried message returns through the default exchange, so its own routing key is the queue name: the original key travels in a header.
        $key = (string) ($delivery->headers[self::H_ORIGINAL_KEY] ?? $delivery->routingKey);

        try {
            $payload = json_decode($delivery->body, true, 512, JSON_THROW_ON_ERROR);
            if (! is_array($payload)) {
                throw new PermanentFailure('the payload is not a JSON object');
            }
            $handler($key, $payload);
            $ch->ack($delivery->tag);

            return;
        } catch (\Throwable $e) {
            $kind = FailureClassifier::classify($e);
            $at = ($now ? $now() : new \DateTimeImmutable())->format('Y-m-d\TH:i:s.v\Z');
            $failure = array_merge(self::withoutBrokerHeaders($delivery->headers), [
                self::H_ORIGINAL_KEY => $key,
                self::H_ORIGINAL_QUEUE => $names['main'],
                self::H_KIND => $kind,
                self::H_CLASS => (new \ReflectionClass($e))->getShortName(),
                self::H_ERROR => mb_substr($e->getMessage(), 0, 500),
                self::H_STACK => mb_substr($e->getTraceAsString(), 0, 2000),
                self::H_FIRST_FAILED => (string) ($delivery->headers[self::H_FIRST_FAILED] ?? $at),
                self::H_FAILED => $at,
                self::H_CORRELATION => Correlation::current(),
            ]);

            try {
                if ($kind === FailureClassifier::TRANSIENT && $retriesDone < $policy->maxAttempts) {
                    $delay = $policy->delayForRetry($retriesDone + 1);
                    $ch->publish('', $names['retryQueues'][$delay], $delivery->body, array_merge($failure, [self::H_RETRY_COUNT => $retriesDone + 1]), $delivery->contentType, $delivery->messageId);
                    $ch->ack($delivery->tag);
                    $log("{$names['main']} {$key}: {$e->getMessage()}; retry ".($retriesDone + 1)."/{$policy->maxAttempts} in {$delay}ms");
                } else {
                    $ch->publish($names['dlx'], '', $delivery->body, array_merge($failure, [self::H_RETRY_COUNT => $retriesDone]), $delivery->contentType, $delivery->messageId);
                    $ch->ack($delivery->tag);
                    $log("{$names['main']} {$key}: dead-lettered to {$names['dlq']} ({$kind}, after {$retriesDone} retries): {$e->getMessage()}");
                }
            } catch (\Throwable $publishError) {
                $log("{$names['main']} {$key}: could not move a failed message ({$publishError->getMessage()}); giving it back to the queue");
                if ($requeueDelayMs > 0) {
                    usleep($requeueDelayMs * 1000);
                }
                try {
                    $ch->requeue($delivery->tag);
                } catch (\Throwable) {
                    // the channel is gone: the broker requeues an unacked message by itself
                }
            }
        }
    }

    /** The broker adds x-death & co. when it dead-letters a message; it rebuilds them itself, so they are not copied forward. */
    private static function withoutBrokerHeaders(array $headers): array
    {
        return array_filter($headers, static fn ($key) => ! str_starts_with((string) $key, 'x-death')
            && ! str_starts_with((string) $key, 'x-first-death') && ! str_starts_with((string) $key, 'x-last-death'), ARRAY_FILTER_USE_KEY);
    }
}
