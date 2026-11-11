<?php

namespace Tests\Unit\Messaging;

use App\Messaging\RetryPolicy;
use App\Messaging\Topology;
use MockServices\Amqp\FakeChannelPort;
use PHPUnit\Framework\TestCase;

require_once dirname(__DIR__, 5).'/mock-services/amqp/FakeChannelPort.php';

class TopologyTest extends TestCase
{
    private const CFG = ['wallet_exchange' => 'wallet.events', 'wallet_queue' => 'store.wallet-events', 'dead_letter_exchange' => 'store.dlx'];

    public function test_it_declares_the_dead_letter_exchange_queue_retry_queues_and_the_main_queue(): void
    {
        $ch = new FakeChannelPort();

        $names = Topology::declare($ch, self::CFG, new RetryPolicy(), ['transfer.completed', 'settlement.completed']);

        $this->assertSame(['store.dlx' => 'fanout', 'wallet.events' => 'topic'], $ch->exchanges);
        $this->assertSame([], $ch->queues['store.wallet-events.dlq']);
        $this->assertSame(['x-dead-letter-exchange' => 'store.dlx'], $ch->queues['store.wallet-events'],
            'the main queue keeps exactly its ORIGINAL arguments: RabbitMQ refuses to redeclare it with different ones');
        $this->assertSame([2000, 4000, 8000, 16000, 30000], array_keys($names['retryQueues']));
        foreach ($names['retryQueues'] as $delay => $queue) {
            $this->assertSame("store.wallet-events.retry.{$delay}ms", $queue);
            $this->assertSame(['x-message-ttl' => $delay, 'x-dead-letter-exchange' => '', 'x-dead-letter-routing-key' => 'store.wallet-events'], $ch->queues[$queue]);
        }
        $this->assertContains(['queue' => 'store.wallet-events.dlq', 'exchange' => 'store.dlx', 'key' => ''], $ch->bindings);
        $this->assertContains(['queue' => 'store.wallet-events', 'exchange' => 'wallet.events', 'key' => 'transfer.completed'], $ch->bindings);
        $this->assertContains(['queue' => 'store.wallet-events', 'exchange' => 'wallet.events', 'key' => 'settlement.completed'], $ch->bindings);
    }

    public function test_with_no_retries_there_are_no_retry_queues(): void
    {
        $ch = new FakeChannelPort();

        $names = Topology::declare($ch, self::CFG, new RetryPolicy(2000, 2.0, 30000, 0), ['transfer.completed']);

        $this->assertSame([], $names['retryQueues']);
        $this->assertSame(['store.wallet-events.dlq', 'store.wallet-events'], array_keys($ch->queues));
    }
}
