<?php

namespace Tests\Feature;

use App\Console\Commands\RelayOutbox;
use App\Models\OutboxEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class OutboxRelayFailureTest extends TestCase
{
    use RefreshDatabase;

    private function row(string $key): OutboxEvent
    {
        return OutboxEvent::create(['exchange' => 'store.events', 'routing_key' => $key, 'payload' => ['correlationId' => 'cid-'.$key]]);
    }

    private function relay(): RelayOutbox
    {
        return app(RelayOutbox::class);
    }

    public function test_a_failed_publish_is_counted_and_explained_and_the_row_stays_unpublished(): void
    {
        $row = $this->row('order.paid');

        try {
            $this->relay()->relayPending(function () {
                throw new \RuntimeException('broker did not confirm');
            });
            $this->fail('the failure must reach the caller so it can back off');
        } catch (\RuntimeException $e) {
            $this->assertSame('broker did not confirm', $e->getMessage());
        }

        $row->refresh();
        $this->assertNull($row->published_at);
        $this->assertSame(0, $row->attempts, 'attempts still counts only successful publishes');
        $this->assertSame(1, $row->failed_attempts);
        $this->assertSame('RuntimeException: broker did not confirm', $row->last_error);
    }

    public function test_every_failure_counts_and_the_latest_error_wins_and_a_long_one_is_truncated(): void
    {
        $row = $this->row('order.paid');
        $fail = function (string $message) {
            return function () use ($message) {
                throw new \RuntimeException($message);
            };
        };

        foreach (['first', 'second'] as $message) {
            try {
                $this->relay()->relayPending($fail($message));
            } catch (\RuntimeException) {
            }
        }
        $this->assertSame(2, $row->refresh()->failed_attempts);
        $this->assertSame('RuntimeException: second', $row->last_error);

        try {
            $this->relay()->relayPending($fail(str_repeat('x', 5000)));
        } catch (\RuntimeException) {
        }
        $this->assertSame(RelayOutbox::MAX_ERROR_LENGTH, mb_strlen($row->refresh()->last_error));
        $this->assertSame(3, $row->failed_attempts);
    }

    public function test_a_failing_row_stops_the_batch_so_later_rows_are_not_published_ahead_of_it(): void
    {
        $first = $this->row('store.opened');
        $failing = $this->row('order.paid');
        $third = $this->row('store.closed');

        try {
            $this->relay()->relayPending(function (OutboxEvent $r) {
                if ($r->routing_key === 'order.paid') {
                    throw new \RuntimeException('boom');
                }
            });
        } catch (\RuntimeException) {
        }

        $this->assertNotNull($first->refresh()->published_at);
        $this->assertNull($failing->refresh()->published_at);
        $this->assertSame(1, $failing->failed_attempts);
        $this->assertNull($third->refresh()->published_at);
        $this->assertSame(0, $third->failed_attempts, 'never attempted');
    }

    public function test_a_later_success_publishes_the_row_clears_the_error_and_keeps_the_history(): void
    {
        $row = $this->row('order.paid');
        try {
            $this->relay()->relayPending(function () {
                throw new \RuntimeException('connection refused');
            });
        } catch (\RuntimeException) {
        }

        $published = $this->relay()->relayPending(fn () => null);

        $row->refresh();
        $this->assertSame(1, $published);
        $this->assertNotNull($row->published_at);
        $this->assertSame(1, $row->attempts);
        $this->assertNull($row->last_error);
        $this->assertSame(1, $row->failed_attempts, 'how often it failed stays visible');
    }
}
