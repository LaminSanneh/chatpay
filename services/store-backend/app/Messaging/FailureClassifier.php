<?php

namespace App\Messaging;

/**
 * transient: may work if tried again later (database or network trouble, the wallet unreachable or erroring).
 * permanent: retrying cannot help (unreadable JSON, a payload of the wrong type, data the database will always refuse).
 * Anything unrecognised is transient: the retries are bounded, so a poison message still ends in the dead-letter queue, and losing a message is worse than delaying it.
 * Class names are matched as strings so this stays free of framework dependencies.
 */
final class FailureClassifier
{
    public const TRANSIENT = 'transient';
    public const PERMANENT = 'permanent';

    public static function classify(\Throwable $e): string
    {
        for ($cause = $e; $cause !== null; $cause = $cause->getPrevious()) {
            if ($cause instanceof PermanentFailure || $cause instanceof \JsonException || $cause instanceof \TypeError
                || $cause instanceof \ValueError || $cause instanceof \UnhandledMatchError) {
                return self::PERMANENT;
            }
            $code = (string) $cause->getCode();
            if (preg_match('/^[0-9A-Z]{5}$/', $code) === 1) {                      // a PostgreSQL SQLSTATE
                if (preg_match('/^(08|53|57P0[123])/', $code) === 1 || $code === '40001' || $code === '40P01') {
                    return self::TRANSIENT;                                        // connection, resources, shutdown, serialization failure, deadlock
                }
                if (preg_match('/^(22|23)/', $code) === 1) {
                    return self::PERMANENT;                                        // data exception, integrity violation
                }
            }
            if (str_ends_with($cause::class, 'ConnectionException') || str_ends_with($cause::class, 'WalletException')) {
                return self::wallet($cause);
            }
        }

        return self::TRANSIENT;
    }

    /** The wallet unreachable or failing (5xx, 429, no status) may recover; a 4xx answer to the same request will not change. */
    private static function wallet(\Throwable $e): string
    {
        $status = property_exists($e, 'status') ? (int) $e->status : 0;

        return ($status === 0 || $status === 429 || $status >= 500) ? self::TRANSIENT : self::PERMANENT;
    }
}
