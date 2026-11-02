<?php

namespace Tests\Feature;

use App\Models\Order;
use App\Models\OutboxEvent;
use App\Services\OrderService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\Support\StoreFixtures;
use Tests\TestCase;

/** What happens when the wallet tells us money arrived (or not): the order must only ever become paid for the RIGHT payment. */
class OrderPaymentEventsTest extends TestCase
{
    use RefreshDatabase, StoreFixtures;

    private function pendingOrder(array $extra = []): Order
    {
        $this->fakeWallet();
        $product = $this->makeProduct($this->makeStore(), ['price_minor' => 2500, 'stock' => 10, 'name' => 'Mug']);

        return app(OrderService::class)->create($this->alice, [
            'items' => [['productId' => $product->id, 'quantity' => 2]],
        ] + $extra);
    }

    private function paymentEvent(Order $order, array $overrides = []): array
    {
        return $overrides + [
            'kind' => 'ORDER_PAYMENT', 'referenceType' => 'order', 'referenceId' => $order->id, 'transferId' => 'transfer-1',
            'intentId' => 'intent-1', 'fromUserId' => $this->alice, 'amountMinor' => 5000, 'currency' => 'GMD',
        ];
    }

    private function paidEvents(): int
    {
        return OutboxEvent::where('routing_key', 'order.paid')->count();
    }

    public function test_a_matching_payment_marks_the_order_paid_and_announces_it(): void
    {
        $order = $this->pendingOrder(['giftFor' => $this->bob, 'context' => ['type' => 'chat', 'roomId' => 'room-1']]);

        app(OrderService::class)->onTransferCompleted($this->paymentEvent($order));

        $order->refresh();
        $this->assertSame(Order::PAID, $order->status);
        $this->assertSame('transfer-1', $order->transfer_id);
        $this->assertNotNull($order->paid_at);

        $event = OutboxEvent::where('routing_key', 'order.paid')->firstOrFail();
        $this->assertSame('store.events', $event->exchange);
        $this->assertSame($order->id, $event->payload['orderId']);
        $this->assertSame($this->alice, $event->payload['buyerUserId']);
        $this->assertSame($this->bob, $event->payload['recipientUserId']);
        $this->assertSame(5000, $event->payload['totalMinor']);
        $this->assertSame("Bob's Shop", $event->payload['storeName']);
        $this->assertSame(['type' => 'chat', 'roomId' => 'room-1'], $event->payload['context']);
        $this->assertSame('Mug', $event->payload['items'][0]['name']);
        $this->assertSame(2, $event->payload['items'][0]['quantity']);
    }

    public function test_delivering_the_same_event_twice_changes_nothing(): void
    {
        $order = $this->pendingOrder();
        $event = $this->paymentEvent($order);

        app(OrderService::class)->onTransferCompleted($event);
        app(OrderService::class)->onTransferCompleted($event);

        $this->assertSame(Order::PAID, $order->fresh()->status);
        $this->assertSame(1, $this->paidEvents());
    }

    public function test_person_to_person_payments_and_other_references_are_ignored(): void
    {
        $order = $this->pendingOrder();

        app(OrderService::class)->onTransferCompleted($this->paymentEvent($order, ['kind' => 'P2P']));
        app(OrderService::class)->onTransferCompleted($this->paymentEvent($order, ['referenceType' => 'chat']));

        $this->assertSame(Order::PENDING, $order->fresh()->status);
        $this->assertSame(0, $this->paidEvents());
    }

    public function test_a_payment_that_does_not_match_goes_to_review_instead_of_paid(): void
    {
        foreach ([['amountMinor' => 1], ['fromUserId' => $this->carol], ['intentId' => 'someone-elses-intent'], ['currency' => 'USD']] as $wrong) {
            $order = $this->pendingOrder();
            $order->update(['payment_intent_id' => 'intent-1']);

            app(OrderService::class)->onTransferCompleted($this->paymentEvent($order, $wrong));

            $this->assertSame(Order::REVIEW, $order->fresh()->status, 'mismatch: '.json_encode($wrong));
        }
        $this->assertSame(0, $this->paidEvents());
    }

    public function test_an_event_for_an_unknown_order_is_ignored(): void
    {
        $order = $this->pendingOrder();

        app(OrderService::class)->onTransferCompleted($this->paymentEvent($order, ['referenceId' => '00000000-0000-4000-8000-000000000000']));

        $this->assertSame(Order::PENDING, $order->fresh()->status);
    }

    public function test_a_payment_that_arrives_after_the_order_was_cancelled_is_refunded_once(): void
    {
        $order = $this->pendingOrder();
        app(OrderService::class)->cancel($order);
        $event = $this->paymentEvent($order);

        app(OrderService::class)->onTransferCompleted($event);
        app(OrderService::class)->onTransferCompleted($event);   // duplicate delivery

        $this->assertSame(Order::REFUNDED, $order->fresh()->status);
        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), "/api/v1/internal/orders/{$order->id}/refund")
            && $r->hasHeader('Idempotency-Key', "order-{$order->id}-late-refund"));
        $refunds = Http::recorded(fn (Request $r) => str_ends_with($r->url(), '/refund'))->count();
        $this->assertSame(1, $refunds);
        $this->assertSame(0, $this->paidEvents());
    }

    public function test_if_the_automatic_refund_fails_a_human_is_asked_to_look(): void
    {
        $order = $this->pendingOrder();
        app(OrderService::class)->cancel($order);
        $this->fakeWallet(['*/api/v1/internal/orders/*/refund' => Http::response(['code' => 'BOOM'], 500)]);

        app(OrderService::class)->onTransferCompleted($this->paymentEvent($order));

        $this->assertSame(Order::REVIEW, $order->fresh()->status);
    }

    public function test_a_finished_settlement_keeps_the_order_in_sync(): void
    {
        $order = $this->pendingOrder();
        $order->update(['status' => Order::DELIVERED]);

        app(OrderService::class)->onSettlementCompleted(['orderId' => $order->id, 'kind' => 'RELEASE']);
        $this->assertSame(Order::COMPLETED, $order->fresh()->status);

        $other = $this->pendingOrder();
        $other->update(['status' => Order::PAID]);
        app(OrderService::class)->onSettlementCompleted(['orderId' => $other->id, 'kind' => 'REFUND']);
        $this->assertSame(Order::REFUNDED, $other->fresh()->status);
    }
}
