<?php

namespace Tests\Unit\Messaging;

use App\Messaging\Delivery;
use App\Messaging\MessageProcessor as P;
use App\Messaging\PermanentFailure;
use App\Messaging\RetryPolicy;
use App\Messaging\Topology;
use App\Support\Correlation;
use MockServices\Amqp\FakeChannelPort;
use PHPUnit\Framework\TestCase;

require_once dirname(__DIR__, 5).'/mock-services/amqp/FakeChannelPort.php';

/** The correlation id on a consumed message: the handler runs under it, every log line and every copy carries it, and it never leaks into the next message. */
class MessageProcessorCorrelationTest extends TestCase
{
    private const CFG = ['wallet_exchange' => 'wallet.events', 'wallet_queue' => 'store.wallet-events', 'dead_letter_exchange' => 'store.dlx'];
    private const UUID = '/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/';

    private FakeChannelPort $ch;
    private array $names;
    private RetryPolicy $policy;
    /** @var list<string|null> the correlation id current at the moment each log line was written */
    private array $loggedUnder = [];

    protected function setUp(): void
    {
        Correlation::listen(null);
        Correlation::set(null);
        $this->ch = new FakeChannelPort();
        $this->policy = new RetryPolicy();
        $this->names = Topology::declare($this->ch, self::CFG, $this->policy, ['transfer.completed']);
    }

    private function process(Delivery $d, callable $handler): void
    {
        P::process($this->ch, $d, $handler, $this->names, $this->policy, function (string $line) {
            $this->loggedUnder[] = Correlation::current();
        }, null, 0);
    }

    private function delivery(array $body, array $headers = []): Delivery
    {
        return new Delivery(json_encode($body), 'transfer.completed', $headers, 1, 'm-1');
    }

    public function test_the_handler_runs_under_the_id_the_message_was_published_with_and_the_previous_id_is_restored(): void
    {
        Correlation::set('http-request-that-is-not-ours');
        $seen = null;

        $this->process($this->delivery(['n' => 1], ['x-correlation-id' => 'from-wallet-1']), function () use (&$seen) {
            $seen = Correlation::current();
        });

        $this->assertSame('from-wallet-1', $seen);
        $this->assertSame('http-request-that-is-not-ours', Correlation::current());
        $this->assertSame([1], $this->ch->acked);
    }

    public function test_the_body_field_is_used_when_the_header_is_missing_and_the_header_wins_over_the_body(): void
    {
        $fromBody = $this->delivery(['correlationId' => 'from-body']);
        $both = $this->delivery(['correlationId' => 'from-body'], ['x-correlation-id' => 'from-header']);
        $broken = new Delivery('{broken', 'transfer.completed', [], 1);
        $bad = $this->delivery(['correlationId' => 'bad id!']);

        $this->assertSame('from-body', P::correlationOf($fromBody));
        $this->assertSame('from-header', P::correlationOf($both));
        $this->assertNull(P::correlationOf($broken));
        $this->assertNull(P::correlationOf($bad));
    }

    public function test_a_message_with_no_id_is_given_one_which_is_used_everywhere_including_the_dead_letter(): void
    {
        $inside = null;

        $this->process($this->delivery(['n' => 1]), function () use (&$inside) {
            $inside = Correlation::current();
            throw new PermanentFailure('unknown schema');
        });

        $this->assertMatchesRegularExpression(self::UUID, $inside);
        $this->assertSame($inside, $this->ch->published[0]['headers'][P::H_CORRELATION]);
        $this->assertNull(Correlation::current());
    }

    public function test_the_retry_copy_and_a_retried_delivery_keep_the_id(): void
    {
        $failing = function () {
            throw new \RuntimeException('database down');
        };

        $this->process($this->delivery(['n' => 1], ['x-correlation-id' => 'trace-A']), $failing);
        $retry = $this->ch->published[0];
        $this->process(new Delivery($retry['body'], 'store.wallet-events', $retry['headers'] + ['x-death' => [['count' => 1]]], 2, 'm-1'), $failing);

        $this->assertSame('trace-A', $retry['headers'][P::H_CORRELATION]);
        $this->assertSame('trace-A', $this->ch->published[1]['headers'][P::H_CORRELATION]);
    }

    public function test_the_dead_letter_carries_the_id_so_the_whole_story_can_be_found_from_it(): void
    {
        $this->process($this->delivery(['n' => 1], ['x-correlation-id' => 'trace-B']), function () {
            throw new PermanentFailure('bad');
        });

        $this->assertSame('store.dlx', $this->ch->published[0]['exchange']);
        $this->assertSame('trace-B', $this->ch->published[0]['headers'][P::H_CORRELATION]);
    }

    public function test_every_log_line_is_written_under_the_messages_id(): void
    {
        $this->process($this->delivery(['n' => 1], ['x-correlation-id' => 'trace-C']), function () {
            throw new \RuntimeException('db down');
        });
        $this->process($this->delivery(['n' => 2], ['x-correlation-id' => 'trace-D']), function () {
            throw new PermanentFailure('bad');
        });

        $this->assertSame(['trace-C', 'trace-D'], $this->loggedUnder);
    }

    public function test_events_published_by_a_handler_get_the_messages_id(): void
    {
        // What EventPublisher does: it reads Correlation::currentOrNew() while the handler runs.
        $published = null;

        $this->process($this->delivery(['n' => 1], ['x-correlation-id' => 'trace-E']), function () use (&$published) {
            $published = Correlation::currentOrNew();
        });

        $this->assertSame('trace-E', $published);
    }

    public function test_a_following_message_never_inherits_the_previous_ones_id(): void
    {
        $seen = [];
        $handler = function () use (&$seen) {
            $seen[] = Correlation::current();
        };

        $this->process($this->delivery(['n' => 1], ['x-correlation-id' => 'first']), $handler);
        $this->process($this->delivery(['n' => 2]), $handler);

        $this->assertSame('first', $seen[0]);
        $this->assertNotSame('first', $seen[1]);
        $this->assertMatchesRegularExpression(self::UUID, $seen[1]);
    }
}
