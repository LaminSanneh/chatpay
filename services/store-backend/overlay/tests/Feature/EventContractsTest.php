<?php

namespace Tests\Feature;

use App\Models\Order;
use App\Models\OutboxEvent;
use App\Services\OrderService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\Contract;
use Tests\Support\StoreFixtures;
use Tests\TestCase;

/**
 * The shared event fixtures (contracts/events) against the real code, both ways:
 * the events THIS service publishes must have the fixtures' shape, and the wallet events it CONSUMES must be understood
 * when they look exactly like the wallet's fixtures.
 */
class EventContractsTest extends TestCase
{
    use RefreshDatabase, StoreFixtures;

    private function pendingOrder(array $extra = []): Order
    {
        $this->fakeWallet();
        $product = $this->makeProduct($this->makeStore(), ['price_minor' => 2500, 'stock' => 10, 'name' => 'Ceramic mug']);

        return app(OrderService::class)->create($this->alice, ['items' => [['productId' => $product->id, 'quantity' => 2]]] + $extra);
    }

    private function lastOutboxPayload(string $routingKey): array
    {
        return OutboxEvent::where('routing_key', $routingKey)->orderByDesc('id')->firstOrFail()->payload;
    }

    /** A wallet event as in the fixture, pointed at the order under test. */
    private function walletPayment(Order $order, array $overrides = []): array
    {
        return array_merge(Contract::load('transfer.completed.order-payment'), [
            'referenceId' => $order->id, 'intentId' => $order->payment_intent_id, 'fromUserId' => $order->buyer_user_id,
            'amountMinor' => $order->total_minor, 'currency' => $order->currency,
        ], $overrides);
    }

    // ------------------------------------------------------------------ what this service publishes
    public function test_store_opened_has_the_shape_of_its_fixture(): void
    {
        $this->makeStore();

        $this->assertSame([], Contract::shapeDifferences(Contract::load('store.opened'), $this->lastOutboxPayload('store.opened')));
    }

    public function test_store_closed_has_the_shape_of_its_fixture(): void
    {
        $this->makeStore()->update(['status' => 'suspended']);

        $this->assertSame([], Contract::shapeDifferences(Contract::load('store.closed'), $this->lastOutboxPayload('store.closed')));
    }

    public function test_order_paid_has_the_shape_of_its_fixture(): void
    {
        $order = $this->pendingOrder(['giftFor' => $this->bob, 'context' => ['type' => 'chat', 'roomId' => 'room-1']]);

        app(OrderService::class)->onTransferCompleted($this->walletPayment($order));

        $this->assertSame([], Contract::shapeDifferences(Contract::load('order.paid'), $this->lastOutboxPayload('order.paid')));
    }

    // ------------------------------------------------------------------ what this service consumes
    public function test_the_wallets_order_payment_fixture_marks_the_order_paid_even_with_an_extra_field(): void
    {
        $order = $this->pendingOrder();

        app(OrderService::class)->onTransferCompleted($this->walletPayment($order, ['aFieldAddedLater' => ['x' => 1]]));

        $this->assertSame(Order::PAID, $order->fresh()->status);
    }

    public function test_the_wallets_person_to_person_fixture_is_ignored(): void
    {
        $order = $this->pendingOrder();
        $event = array_merge(Contract::load('transfer.completed.p2p'), ['referenceId' => $order->id, 'fromUserId' => $order->buyer_user_id]);

        app(OrderService::class)->onTransferCompleted($event);

        $this->assertSame(Order::PENDING, $order->fresh()->status);
    }

    public function test_the_wallets_release_fixture_completes_a_delivered_order(): void
    {
        $order = $this->pendingOrder();
        $order->update(['status' => Order::DELIVERED]);

        app(OrderService::class)->onSettlementCompleted(array_merge(Contract::load('settlement.completed.release'), ['orderId' => $order->id]));

        $this->assertSame(Order::COMPLETED, $order->fresh()->status);
    }

    public function test_the_wallets_refund_fixture_marks_a_paid_order_refunded(): void
    {
        $order = $this->pendingOrder();
        $order->update(['status' => Order::PAID]);

        app(OrderService::class)->onSettlementCompleted(array_merge(Contract::load('settlement.completed.refund'), ['orderId' => $order->id]));

        $this->assertSame(Order::REFUNDED, $order->fresh()->status);
    }

    // ------------------------------------------------------------------ the comparison helper itself
    public function test_the_shape_comparison_notices_missing_extra_and_retyped_fields(): void
    {
        $fixture = ['a' => 1, 'b' => 'x', 'c' => ['d' => 1.5], 'e' => [['f' => 1]], 'n' => null];

        $this->assertSame([], Contract::shapeDifferences($fixture, ['a' => 2, 'b' => 'y', 'c' => ['d' => 2.5], 'e' => [['f' => 9]], 'n' => 'now set']));
        $this->assertSame(['b: missing from the payload'], Contract::shapeDifferences($fixture, ['a' => 1, 'c' => ['d' => 1.5], 'e' => [['f' => 1]], 'n' => null]));
        $this->assertSame(['z: not in the fixture (add it to contracts/events)'], Contract::shapeDifferences(['a' => 1], ['a' => 1, 'z' => true]));
        $this->assertSame(['a: the fixture has integer, the payload has string'], Contract::shapeDifferences(['a' => 1], ['a' => '1']));
        $this->assertSame(['e[0].f: the fixture has integer, the payload has string'], Contract::shapeDifferences(['e' => [['f' => 1]]], ['e' => [['f' => 'x']]]));
    }
}
