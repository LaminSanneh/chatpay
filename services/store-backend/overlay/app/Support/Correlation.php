<?php

namespace App\Support;

/**
 * The correlation id of the request or RabbitMQ message being handled. One id follows a request through every service, its outbox event,
 * the AMQP message, the consumer's log lines and any dead letter, so "what happened to this payment?" is a single search.
 *
 * Plain PHP (no framework): the web middleware, the queue consumer and the scheduled commands all use it, and so do the framework-free tests.
 * A listener (registered by AppServiceProvider) copies the current id into the log context.
 */
final class Correlation
{
    public const HEADER = 'X-Correlation-Id';
    public const AMQP_HEADER = 'x-correlation-id';

    private static ?string $current = null;

    /** @var (callable(?string): void)|null */
    private static $listener = null;

    public static function current(): ?string
    {
        return self::$current;
    }

    /** The current id, or a fresh one when nothing is being handled (an event created from tinker, a seeder, a test). */
    public static function currentOrNew(): string
    {
        return self::$current ?? self::generate();
    }

    public static function generate(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);      // version 4
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);      // variant

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    /** Letters, digits and . _ : - only, at most 64 characters: anything else (spaces, newlines, huge values) could forge or flood a log line. */
    public static function sanitize(mixed $raw): ?string
    {
        if (is_array($raw)) {
            $raw = $raw[0] ?? null;
        }

        return is_string($raw) && preg_match('/\A[A-Za-z0-9._:-]{1,64}\z/', $raw) === 1 ? $raw : null;
    }

    public static function set(?string $id): void
    {
        self::$current = $id;
        if (self::$listener !== null) {
            (self::$listener)($id);
        }
    }

    /**
     * Runs $fn under $id (an invalid or missing id is replaced by a new one) and restores the previous id afterwards.
     *
     * @template T
     * @param callable(): T $fn
     * @return T
     */
    public static function within(mixed $id, callable $fn): mixed
    {
        $previous = self::$current;
        self::set(self::sanitize($id) ?? self::generate());
        try {
            return $fn();
        } finally {
            self::set($previous);
        }
    }

    /** @param (callable(?string): void)|null $listener called whenever the current id changes */
    public static function listen(?callable $listener): void
    {
        self::$listener = $listener;
    }
}
