<?php

namespace Tests\Feature;

use App\Exceptions\DomainError;
use App\Models\Order;
use App\Services\OrderService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\Support\StoreFixtures;
use Tests\TestCase;

class OrderFulfilmentTest extends TestCase
{
    use RefreshDatabase, StoreFixtures;

    private function order(string $status, int $price = 5000, array $storeAttributes = []): Order
    {
        $this->fakeWallet();
        $product = $this->makeProduct($this->makeStore($storeAttributes), ['price_minor' => $price, 'stock' => 10]);
        $order = app(OrderService::class)->create($this->alice, ['items' => [['productId' => $product->id, 'quantity' => 1]]]);
        $order->update(['status' => $status]);

        return $order;
    }

    private function expectTransitionError(callable $call): void
    {
        try {
            $call();
            $this->fail('Expected INVALID_TRANSITION');
        } catch (DomainError $e) {
            $this->assertSame('INVALID_TRANSITION', $e->errorCode);
            $this->assertSame(409, $e->status);
        }
    }

    public function test_orders_move_forward_one_step_at_a_time(): void
    {
        $order = $this->order(Order::PAID);
        $this->expectTransitionError(fn () => app(OrderService::class)->deliver($order));   // cannot skip shipping

        $this->assertSame(Order::SHIPPED, app(OrderService::class)->ship($order)->status);
        $this->expectTransitionError(fn () => app(OrderService::class)->ship($order));       // cannot ship twice
        $this->assertSame(Order::DELIVERED, app(OrderService::class)->deliver($order)->status);
    }

    public function test_an_unpaid_order_cannot_be_shipped(): void
    {
        $order = $this->order(Order::PENDING);

        $this->expectTransitionError(fn () => app(OrderService::class)->ship($order));
    }

    public function test_payout_releases_escrow_minus_commission_with_an_idempotency_key(): void
    {
        $order = $this->order(Order::DELIVERED, 5000);

        $done = app(OrderService::class)->settle($order);

        $this->assertSame(Order::COMPLETED, $done->status);
        $this->assertNotNull($done->settled_at);
        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), "/api/v1/internal/orders/{$order->id}/release")
            && $r->hasHeader('Idempotency-Key', "order-{$order->id}-release")
            && $r['commissionMinor'] === 500);   // default commission: 10% of 5000
    }

    public function test_a_store_specific_commission_wins(): void
    {
        $order = $this->order(Order::DELIVERED, 5000, ['commission_bps' => 2000]);

        app(OrderService::class)->settle($order);

        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), '/release') && $r['commissionMinor'] === 1000);
    }

    public function test_paying_out_twice_calls_the_wallet_once(): void
    {
        $order = $this->order(Order::DELIVERED);

        app(OrderService::class)->settle($order);
        app(OrderService::class)->settle($order);

        $this->assertSame(1, Http::recorded(fn (Request $r) => str_ends_with($r->url(), '/release'))->count());
    }

    public function test_only_delivered_orders_can_be_paid_out(): void
    {
        $order = $this->order(Order::SHIPPED);

        $this->expectTransitionError(fn () => app(OrderService::class)->settle($order));
        Http::assertNotSent(fn (Request $r) => str_ends_with($r->url(), '/release'));
    }

    public function test_a_failed_payout_leaves_the_order_delivered_so_it_can_be_retried(): void
    {
        $order = $this->order(Order::DELIVERED);
        $this->fakeWallet(['*/api/v1/internal/orders/*/release' => Http::response(['code' => 'BOOM'], 500)]);

        try {
            app(OrderService::class)->settle($order);
            $this->fail('Expected the wallet error to surface');
        } catch (\App\Services\WalletException $e) {
            $this->assertSame(500, $e->status);
        }
        $this->assertSame(Order::DELIVERED, $order->fresh()->status);
    }

    public function test_refunding_an_escrowed_order_returns_the_money_and_the_stock(): void
    {
        $order = $this->order(Order::PAID);
        $stockBefore = $order->items->first()->product_id ? \App\Models\Product::find($order->items->first()->product_id)->stock : null;

        $refunded = app(OrderService::class)->refund($order);

        $this->assertSame(Order::REFUNDED, $refunded->status);
        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), "/api/v1/internal/orders/{$order->id}/refund")
            && $r->hasHeader('Idempotency-Key', "order-{$order->id}-refund"));
        $this->assertSame($stockBefore + 1, \App\Models\Product::find($order->items->first()->product_id)->stock);
    }

    public function test_money_that_was_already_paid_out_cannot_be_refunded_this_way(): void
    {
        $this->expectTransitionError(fn () => app(OrderService::class)->refund($this->order(Order::COMPLETED)));
    }

    public function test_the_expire_command_cancels_overdue_unpaid_orders_and_restocks(): void
    {
        $overdue = $this->order(Order::PENDING);
        $overdue->update(['expires_at' => now()->subMinute()]);
        $fresh = $this->order(Order::PENDING);
        $fresh->update(['expires_at' => now()->addMinutes(10)]);
        $productId = $overdue->items->first()->product_id;
        $stockBefore = \App\Models\Product::find($productId)->stock;

        $this->artisan('orders:expire')->assertSuccessful();

        $this->assertSame(Order::CANCELLED, $overdue->fresh()->status);
        $this->assertSame(Order::PENDING, $fresh->fresh()->status);
        $this->assertSame($stockBefore + 1, \App\Models\Product::find($productId)->stock);
    }

    public function test_the_settle_command_waits_for_the_return_window(): void
    {
        config(['store.return_window_days' => 7]);
        $recent = $this->order(Order::DELIVERED);
        $recent->update(['delivered_at' => now()->subDays(2)]);
        $old = $this->order(Order::DELIVERED);
        $old->update(['delivered_at' => now()->subDays(8)]);

        $this->artisan('orders:settle')->assertSuccessful();

        $this->assertSame(Order::DELIVERED, $recent->fresh()->status);
        $this->assertSame(Order::COMPLETED, $old->fresh()->status);
    }
}
