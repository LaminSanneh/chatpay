<?php

namespace Tests\Unit\Messaging;

use App\Messaging\ChannelPort;
use App\Messaging\Delivery;
use App\Messaging\MessageProcessor as P;
use App\Messaging\PermanentFailure;
use App\Messaging\RetryPolicy;
use App\Messaging\Topology;
use MockServices\Amqp\FakeChannelPort;
use PHPUnit\Framework\TestCase;

require_once dirname(__DIR__, 5).'/mock-services/amqp/FakeChannelPort.php';

/** The retry / dead-letter decisions of the store's consumer, with no broker. Mirrors services/chat-service/tests/consumer-runner.test.ts. */
class MessageProcessorTest extends TestCase
{
    private const CFG = ['wallet_exchange' => 'wallet.events', 'wallet_queue' => 'store.wallet-events', 'dead_letter_exchange' => 'store.dlx'];

    private FakeChannelPort $ch;
    private array $names;
    private RetryPolicy $policy;
    private int $clock;
    private array $logged = [];

    protected function setUp(): void
    {
        $this->ch = new FakeChannelPort();
        $this->policy = new RetryPolicy();
        $this->names = Topology::declare($this->ch, self::CFG, $this->policy, ['transfer.completed', 'settlement.completed']);
        $this->clock = strtotime('2026-01-01T00:00:00Z');
    }

    private function process(Delivery $d, callable $handler, ?RetryPolicy $policy = null): void
    {
        P::process($this->ch, $d, $handler, $this->names, $policy ?? $this->policy, function (string $line) { $this->logged[] = $line; },
            fn () => (new \DateTimeImmutable())->setTimestamp($this->clock += 1), 0);
    }

    private function delivery(array|string $body, string $key = 'transfer.completed', array $headers = [], int $tag = 1): Delivery
    {
        return new Delivery(is_string($body) ? $body : json_encode($body), $key, $headers, $tag, 'm-1');
    }

    private function failing(\Throwable $e): callable
    {
        return function () use ($e) {
            throw $e;
        };
    }

    /** What the broker does when a retry message expires: hands it back to the main queue through the default exchange. */
    private function comeBack(array $published): Delivery
    {
        return new Delivery($published['body'], 'store.wallet-events', $published['headers'] + ['x-death' => [['count' => 1]]], 7, $published['messageId']);
    }

    public function test_a_message_the_handler_accepts_is_acked_once_and_nothing_is_republished(): void
    {
        $seen = [];

        $this->process($this->delivery(['orderId' => 'o1'], 'settlement.completed'), function (string $key, array $payload) use (&$seen) {
            $seen[] = [$key, $payload];
        });

        $this->assertSame([['settlement.completed', ['orderId' => 'o1']]], $seen);
        $this->assertSame([1], $this->ch->acked);
        $this->assertSame([], $this->ch->published);
        $this->assertSame([], $this->ch->requeued);
    }

    public function test_a_transient_failure_goes_to_the_first_retry_queue_with_the_bookkeeping_headers_and_the_original_is_acked(): void
    {
        $this->process($this->delivery(['n' => 1], 'transfer.completed', ['x-trace' => 'abc']), $this->failing(new \RuntimeException('db down')));

        $this->assertCount(1, $this->ch->published);
        $p = $this->ch->published[0];
        $this->assertSame('', $p['exchange'], 'through the default exchange, straight to the retry queue');
        $this->assertSame('store.wallet-events.retry.2000ms', $p['key']);
        $this->assertSame('{"n":1}', $p['body']);
        $this->assertSame('m-1', $p['messageId']);
        $h = $p['headers'];
        $this->assertSame('abc', $h['x-trace']);
        $this->assertSame(1, $h[P::H_RETRY_COUNT]);
        $this->assertSame('transfer.completed', $h[P::H_ORIGINAL_KEY]);
        $this->assertSame('store.wallet-events', $h[P::H_ORIGINAL_QUEUE]);
        $this->assertSame('transient', $h[P::H_KIND]);
        $this->assertSame('RuntimeException', $h[P::H_CLASS]);
        $this->assertSame('db down', $h[P::H_ERROR]);
        $this->assertSame('2026-01-01T00:00:01.000Z', $h[P::H_FIRST_FAILED]);
        $this->assertSame([1], $this->ch->acked);
        $this->assertSame([], $this->ch->requeued);
    }

    public function test_it_backs_off_exponentially_then_dead_letters_after_the_last_retry_keeping_the_original_routing_key(): void
    {
        $keys = [];
        $failing = function (string $key) use (&$keys) {
            $keys[] = $key;
            throw new \RuntimeException('still down');
        };
        $delivery = $this->delivery(['orderId' => 'o1'], 'transfer.completed');

        for ($i = 1; $i <= 6; $i++) {
            $this->process($delivery, $failing);
            $last = $this->ch->published[array_key_last($this->ch->published)];
            if ($last['exchange'] === '') {
                $delivery = $this->comeBack($last);
            }
        }

        $this->assertSame(['store.wallet-events.retry.2000ms', 'store.wallet-events.retry.4000ms', 'store.wallet-events.retry.8000ms',
            'store.wallet-events.retry.16000ms', 'store.wallet-events.retry.30000ms', ''], array_column($this->ch->published, 'key'));
        $this->assertSame('store.dlx', $this->ch->published[5]['exchange']);
        $this->assertSame(5, $this->ch->published[5]['headers'][P::H_RETRY_COUNT]);
        $this->assertSame('transient', $this->ch->published[5]['headers'][P::H_KIND]);
        $this->assertSame(array_fill(0, 6, 'transfer.completed'), $keys, 'the handler always sees the ORIGINAL routing key, even on retried deliveries');
        $this->assertCount(6, $this->ch->acked, 'every delivery is acked exactly once');
        $this->assertSame([], $this->ch->requeued);
    }

    public function test_failures_that_clear_after_two_attempts_are_processed_on_the_third_delivery_and_never_reach_the_dlq(): void
    {
        $calls = 0;
        $flaky = function () use (&$calls) {
            if (++$calls <= 2) {
                throw new \RuntimeException('blip');
            }
        };
        $delivery = $this->delivery(['n' => 1]);

        for ($i = 1; $i <= 3; $i++) {
            $this->process($delivery, $flaky);
            if ($i < 3) {
                $delivery = $this->comeBack($this->ch->published[array_key_last($this->ch->published)]);
            }
        }

        $this->assertSame(3, $calls);
        $this->assertSame(['store.wallet-events.retry.2000ms', 'store.wallet-events.retry.4000ms'], array_column($this->ch->published, 'key'));
        $this->assertSame([], array_filter($this->ch->published, fn ($p) => $p['exchange'] === 'store.dlx'));
    }

    public function test_first_failure_time_is_kept_and_last_failure_time_moves_and_broker_headers_are_not_carried_forward(): void
    {
        $fail = $this->failing(new \RuntimeException('down'));
        $this->process($this->delivery([], 'transfer.completed', ['x-keep' => 1, 'x-death' => [['count' => 3]], 'x-first-death-queue' => 'q']), $fail);
        $first = $this->ch->published[0];
        $this->process($this->comeBack($first), $fail);
        $second = $this->ch->published[1];

        $this->assertSame($first['headers'][P::H_FIRST_FAILED], $second['headers'][P::H_FIRST_FAILED]);
        $this->assertNotSame($first['headers'][P::H_FAILED], $second['headers'][P::H_FAILED]);
        $this->assertArrayNotHasKey('x-death', $first['headers']);
        $this->assertArrayNotHasKey('x-first-death-queue', $first['headers']);
        $this->assertSame(1, $first['headers']['x-keep']);
    }

    public function test_permanent_failures_skip_the_retries_and_go_straight_to_the_dead_letter_exchange(): void
    {
        $calls = 0;
        $this->process($this->delivery(['bad' => true]), function () use (&$calls) {
            $calls++;
            throw new PermanentFailure('unknown schema version');
        });

        $this->assertSame(1, $calls);
        $this->assertCount(1, $this->ch->published);
        $p = $this->ch->published[0];
        $this->assertSame('store.dlx', $p['exchange']);
        $this->assertSame('permanent', $p['headers'][P::H_KIND]);
        $this->assertSame('PermanentFailure', $p['headers'][P::H_CLASS]);
        $this->assertSame(0, $p['headers'][P::H_RETRY_COUNT]);
        $this->assertSame('unknown schema version', $p['headers'][P::H_ERROR]);
        $this->assertSame([1], $this->ch->acked);
    }

    public function test_unreadable_json_and_payloads_that_are_not_objects_never_reach_the_handler(): void
    {
        $calls = 0;
        $handler = function () use (&$calls) {
            $calls++;
        };

        foreach (['{not json', '"just a string"', '42', ''] as $i => $raw) {
            $this->process($this->delivery($raw, 'transfer.completed', [], $i + 1), $handler);
        }

        $this->assertSame(0, $calls);
        $this->assertSame(['store.dlx', 'store.dlx', 'store.dlx', 'store.dlx'], array_column($this->ch->published, 'exchange'));
        $this->assertSame('JsonException', $this->ch->published[0]['headers'][P::H_CLASS]);
        $this->assertSame('PermanentFailure', $this->ch->published[1]['headers'][P::H_CLASS]);
        $this->assertSame('{not json', $this->ch->published[0]['body'], 'the original bytes are kept so a person can read them');
    }

    public function test_with_zero_retries_a_transient_failure_is_dead_lettered_at_once(): void
    {
        $policy = new RetryPolicy(2000, 2.0, 30000, 0);
        $this->names = Topology::declare($this->ch, self::CFG, $policy, ['transfer.completed']);

        $this->process($this->delivery([]), $this->failing(new \RuntimeException('x')), $policy);

        $this->assertSame('store.dlx', $this->ch->published[0]['exchange']);
    }

    public function test_if_the_failed_message_cannot_be_moved_it_is_given_back_to_the_queue_not_acked_not_lost(): void
    {
        foreach ([new \RuntimeException('transient'), new PermanentFailure('permanent')] as $e) {
            $this->setUp();
            $this->ch->publishFailure = new \RuntimeException('broker did not confirm');

            $this->process($this->delivery([], 'transfer.completed', [], 9), $this->failing($e));

            $this->assertSame([], $this->ch->acked, get_class($e));
            $this->assertSame([9], $this->ch->requeued, get_class($e));
        }
    }

    public function test_it_says_what_it_did(): void
    {
        $this->process($this->delivery([]), $this->failing(new \RuntimeException('db down')));
        $this->process($this->delivery([]), $this->failing(new PermanentFailure('bad')));

        $this->assertStringContainsString('retry 1/5 in 2000ms', $this->logged[0]);
        $this->assertStringContainsString('dead-lettered to store.wallet-events.dlq (permanent', $this->logged[1]);
    }
}
