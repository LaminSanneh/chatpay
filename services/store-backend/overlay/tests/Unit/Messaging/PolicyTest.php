<?php

namespace Tests\Unit\Messaging;

use App\Messaging\Backoff;
use App\Messaging\RetryPolicy;
use PHPUnit\Framework\TestCase;

class PolicyTest extends TestCase
{
    public function test_defaults_wait_2s_4s_8s_16s_and_then_stay_at_the_30s_cap(): void
    {
        $policy = new RetryPolicy();

        $this->assertSame([2000, 4000, 8000, 16000, 30000, 30000, 30000], array_map(fn ($n) => $policy->delayForRetry($n), [1, 2, 3, 4, 5, 6, 7]));
        $this->assertSame([2000, 4000, 8000, 16000, 30000], $policy->delays());
    }

    public function test_one_retry_queue_per_distinct_delay_and_none_when_there_are_no_retries(): void
    {
        $this->assertSame([1000, 3000, 5000], (new RetryPolicy(1000, 3.0, 5000, 5))->delays());
        $this->assertSame([500], (new RetryPolicy(500, 1.0, 9999, 4))->delays());
        $this->assertSame([], (new RetryPolicy(2000, 2.0, 30000, 0))->delays());
    }

    public function test_it_reads_its_settings_from_config_and_refuses_nonsense(): void
    {
        $policy = RetryPolicy::fromConfig(['initial_delay_ms' => 100, 'multiplier' => 3, 'max_delay_ms' => 900, 'max_attempts' => 2]);
        $this->assertSame([100, 300], $policy->delays());
        $this->assertEquals(new RetryPolicy(), RetryPolicy::fromConfig([]));

        foreach ([[0, 2.0, 1, 1], [1, 0.5, 1, 1], [1, 2.0, 0, 1], [1, 2.0, 1, -1]] as $bad) {
            try {
                new RetryPolicy(...$bad);
                $this->fail('accepted '.json_encode($bad));
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function test_a_worker_that_cannot_reach_its_dependency_backs_off_1s_2s_4s_up_to_30s(): void
    {
        $this->assertSame(0, Backoff::delayMs(0));
        $this->assertSame([1000, 2000, 4000, 8000, 16000, 30000, 30000], array_map(fn ($n) => Backoff::delayMs($n), [1, 2, 3, 4, 5, 6, 7]));
        $this->assertSame(30000, Backoff::delayMs(500), 'no overflow however long it has been down');
        $this->assertSame(250, Backoff::delayMs(1, 250, 1000));
    }
}
