<?php

namespace Tests\Unit\Messaging;

use App\Messaging\FailureClassifier;
use App\Messaging\PermanentFailure;
use PHPUnit\Framework\TestCase;

class FakeWalletException extends \RuntimeException
{
    public function __construct(public int $status = 0)
    {
        parent::__construct('wallet said '.$status);
    }
}

class FakeConnectionException extends \RuntimeException
{
}

class FailureClassifierTest extends TestCase
{
    private function sqlState(string $state): \PDOException
    {
        $e = new \PDOException('database error');
        (new \ReflectionProperty(\Exception::class, 'code'))->setValue($e, $state);

        return $e;
    }

    public function test_things_retrying_can_never_fix_are_permanent(): void
    {
        $unreadable = null;
        try {
            json_decode('{not json', true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $unreadable) {
        }
        $unhandled = null;
        try {
            match ('x') {
                'y' => 1,
            };
        } catch (\UnhandledMatchError $unhandled) {
        }

        foreach ([new PermanentFailure('no'), $unreadable, new \TypeError('array expected'), new \ValueError('bad'), $unhandled, $this->sqlState('23505'), $this->sqlState('22P02')] as $e) {
            $this->assertSame(FailureClassifier::PERMANENT, FailureClassifier::classify($e), get_class($e));
        }
    }

    public function test_database_trouble_is_transient(): void
    {
        foreach (['08006', '08001', '53300', '57P01', '57P03', '40001', '40P01'] as $state) {
            $this->assertSame(FailureClassifier::TRANSIENT, FailureClassifier::classify($this->sqlState($state)), $state);
        }
    }

    public function test_the_cause_is_looked_at_not_only_the_wrapper(): void
    {
        $wrapped = new \RuntimeException('query failed', 0, $this->sqlState('08006'));
        $wrappedPermanent = new \RuntimeException('query failed', 0, $this->sqlState('23505'));

        $this->assertSame(FailureClassifier::TRANSIENT, FailureClassifier::classify($wrapped));
        $this->assertSame(FailureClassifier::PERMANENT, FailureClassifier::classify($wrappedPermanent));
    }

    public function test_the_wallet_being_unreachable_or_erroring_is_transient_but_a_client_error_is_not(): void
    {
        foreach ([0, 429, 500, 502, 503] as $status) {
            $this->assertSame(FailureClassifier::TRANSIENT, FailureClassifier::classify(new FakeWalletException($status)), (string) $status);
        }
        foreach ([400, 404, 409, 422] as $status) {
            $this->assertSame(FailureClassifier::PERMANENT, FailureClassifier::classify(new FakeWalletException($status)), (string) $status);
        }
        $this->assertSame(FailureClassifier::TRANSIENT, FailureClassifier::classify(new FakeConnectionException('refused')));
    }

    public function test_anything_unrecognised_is_retried_rather_than_dropped(): void
    {
        $this->assertSame(FailureClassifier::TRANSIENT, FailureClassifier::classify(new \RuntimeException('something odd')));
        $this->assertSame(FailureClassifier::TRANSIENT, FailureClassifier::classify(new \Exception('x', 12345)));
    }
}
