<?php

namespace App\Messaging;

/**
 * The queues of the store's wallet-events consumer:
 *   wallet.events --transfer.completed, settlement.completed--> store.wallet-events --transient error--> store.wallet-events.retry.<delay>ms (TTL = delay)
 *                                                                      ^                                          |
 *                                                                      +----------- TTL expires: back to the main queue
 *   store.wallet-events --permanent error, or retries used up--> store.dlx (fanout) --> store.wallet-events.dlq   (waits for a person)
 * The main queue keeps its original arguments (only x-dead-letter-exchange): RabbitMQ would refuse to redeclare it with different ones.
 */
final class Topology
{
    /** @return array{main: string, dlq: string, dlx: string, retryQueues: array<int, string>} retry queue name by delay in ms */
    public static function names(array $cfg, RetryPolicy $policy): array
    {
        $main = $cfg['wallet_queue'];
        $retry = [];
        foreach ($policy->delays() as $delay) {
            $retry[$delay] = "{$main}.retry.{$delay}ms";
        }

        return ['main' => $main, 'dlq' => $main.'.dlq', 'dlx' => $cfg['dead_letter_exchange'], 'retryQueues' => $retry];
    }

    /** @param list<string> $routingKeys */
    public static function declare(ChannelPort $ch, array $cfg, RetryPolicy $policy, array $routingKeys): array
    {
        $names = self::names($cfg, $policy);

        $ch->declareExchange($names['dlx'], 'fanout');
        $ch->declareQueue($names['dlq']);
        $ch->bind($names['dlq'], $names['dlx']);

        foreach ($names['retryQueues'] as $delay => $queue) {
            $ch->declareQueue($queue, [
                'x-message-ttl' => $delay,
                'x-dead-letter-exchange' => '',                      // the default exchange...
                'x-dead-letter-routing-key' => $names['main'],       // ...routes an expired message straight back to the main queue
            ]);
        }

        $ch->declareExchange($cfg['wallet_exchange'], 'topic');
        $ch->declareQueue($names['main'], ['x-dead-letter-exchange' => $names['dlx']]);
        foreach ($routingKeys as $key) {
            $ch->bind($names['main'], $cfg['wallet_exchange'], $key);
        }

        return $names;
    }
}
