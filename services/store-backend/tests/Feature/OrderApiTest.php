<?php

namespace Tests\Feature;

use App\Models\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\Support\StoreFixtures;
use Tests\TestCase;

class OrderApiTest extends TestCase
{
    use RefreshDatabase, StoreFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->fakeLogins();
        $this->fakeWallet();
    }

    public function test_ordering_requires_a_login(): void
    {
        $this->postJson('/api/v1/orders', [])->assertUnauthorized()->assertJsonPath('code', 'UNAUTHENTICATED');
        $this->as('mallory')->postJson('/api/v1/orders', [])->assertUnauthorized();
        $this->getJson('/api/v1/orders')->assertUnauthorized();
    }

    public function test_checkout_prices_from_the_database_reserves_stock_and_asks_the_wallet_for_exactly_that_amount(): void
    {
        $store = $this->makeStore();
        $mug = $this->makeProduct($store, ['price_minor' => 2500, 'stock' => 10]);
        $lamp = $this->makeProduct($store, ['price_minor' => 22000, 'stock' => 5]);

        $response = $this->as('alice')->postJson('/api/v1/orders', ['items' => [
            ['productId' => $mug->id, 'quantity' => 2], ['productId' => $lamp->id, 'quantity' => 1],
        ]])->assertCreated();

        $response->assertJsonPath('totalMinor', 27000)
            ->assertJsonPath('status', 'pending_payment')
            ->assertJsonPath('payment.intentId', 'intent-1')
            ->assertJsonPath('buyerUserId', $this->alice);
        $this->assertSame(8, $mug->fresh()->stock);
        $this->assertSame(4, $lamp->fresh()->stock);

        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), '/api/v1/internal/transfer-intents')
            && $r->hasHeader('Authorization', 'Bearer svc-token')
            && $r['payerUserId'] === $this->alice
            && $r['amountMinor'] === 27000
            && $r['storeId'] === (string) $store->id
            && $r['orderId'] === $response->json('id'));
    }

    public function test_the_same_product_on_two_lines_is_added_up(): void
    {
        $mug = $this->makeProduct($this->makeStore(), ['price_minor' => 1000, 'stock' => 10]);

        $this->as('alice')->postJson('/api/v1/orders', ['items' => [
            ['productId' => $mug->id, 'quantity' => 1], ['productId' => $mug->id, 'quantity' => 2],
        ]])->assertCreated()->assertJsonPath('totalMinor', 3000)->assertJsonCount(1, 'items');
    }

    public function test_a_client_cannot_name_its_own_price(): void
    {
        $mug = $this->makeProduct($this->makeStore(), ['price_minor' => 2500]);

        $this->as('alice')->postJson('/api/v1/orders', ['items' => [['productId' => $mug->id, 'quantity' => 1, 'priceMinor' => 1]], 'totalMinor' => 1])
            ->assertCreated()->assertJsonPath('totalMinor', 2500);
    }

    public function test_gifts_record_the_recipient_and_the_chat_context(): void
    {
        $mug = $this->makeProduct($this->makeStore());

        $this->as('alice')->postJson('/api/v1/orders', [
            'items' => [['productId' => $mug->id, 'quantity' => 1]], 'giftFor' => $this->bob,
            'context' => ['type' => 'chat', 'roomId' => 'room-1'],
        ])->assertCreated()->assertJsonPath('giftFor', $this->bob)->assertJsonPath('chatContext.roomId', 'room-1');
    }

    public function test_you_cannot_gift_to_yourself_and_contexts_are_validated(): void
    {
        $mug = $this->makeProduct($this->makeStore());
        $items = [['productId' => $mug->id, 'quantity' => 1]];

        $this->as('alice')->postJson('/api/v1/orders', ['items' => $items, 'giftFor' => $this->alice])->assertStatus(422)->assertJsonPath('code', 'INVALID_GIFT');
        $this->as('alice')->postJson('/api/v1/orders', ['items' => $items, 'context' => ['type' => 'web', 'roomId' => 'x']])->assertStatus(422);
        $this->as('alice')->postJson('/api/v1/orders', ['items' => []])->assertStatus(422);
    }

    public function test_an_order_cannot_mix_stores(): void
    {
        $a = $this->makeProduct($this->makeStore());
        $b = $this->makeProduct($this->makeStore(['slug' => 'other', 'name' => 'Other', 'owner_user_id' => $this->carol]));

        $this->as('alice')->postJson('/api/v1/orders', ['items' => [['productId' => $a->id, 'quantity' => 1], ['productId' => $b->id, 'quantity' => 1]]])
            ->assertStatus(422)->assertJsonPath('code', 'MIXED_STORES');
    }

    public function test_out_of_stock_unavailable_and_unknown_products_are_refused_without_touching_stock(): void
    {
        $store = $this->makeStore();
        $few = $this->makeProduct($store, ['stock' => 1]);
        $draft = $this->makeProduct($store, ['status' => 'draft']);

        $this->as('alice')->postJson('/api/v1/orders', ['items' => [['productId' => $few->id, 'quantity' => 2]]])->assertStatus(409)->assertJsonPath('code', 'OUT_OF_STOCK');
        $this->as('alice')->postJson('/api/v1/orders', ['items' => [['productId' => $draft->id, 'quantity' => 1]]])->assertStatus(422)->assertJsonPath('code', 'PRODUCT_UNAVAILABLE');
        $this->as('alice')->postJson('/api/v1/orders', ['items' => [['productId' => 999999, 'quantity' => 1]]])->assertStatus(422)->assertJsonPath('code', 'PRODUCT_NOT_FOUND');

        $this->assertSame(1, $few->fresh()->stock);
        $this->assertSame(0, Order::count());
    }

    public function test_a_suspended_store_cannot_sell(): void
    {
        $product = $this->makeProduct($this->makeStore(['status' => 'suspended']));

        $this->as('alice')->postJson('/api/v1/orders', ['items' => [['productId' => $product->id, 'quantity' => 1]]])
            ->assertStatus(422)->assertJsonPath('code', 'STORE_UNAVAILABLE');
    }

    public function test_if_the_wallet_is_down_the_order_is_cancelled_and_the_stock_comes_back(): void
    {
        $mug = $this->makeProduct($this->makeStore(), ['stock' => 5]);
        $this->fakeWallet(['*/api/v1/internal/transfer-intents' => Http::response(['code' => 'BOOM'], 500)]);

        $this->as('alice')->postJson('/api/v1/orders', ['items' => [['productId' => $mug->id, 'quantity' => 2]]])
            ->assertStatus(502)->assertJsonPath('code', 'PAYMENT_UNAVAILABLE');

        $this->assertSame(5, $mug->fresh()->stock);
        $this->assertSame(Order::CANCELLED, Order::first()->status);
    }

    public function test_only_the_buyer_and_the_gift_recipient_can_see_an_order(): void
    {
        $mug = $this->makeProduct($this->makeStore());
        $id = $this->as('alice')->postJson('/api/v1/orders', ['items' => [['productId' => $mug->id, 'quantity' => 1]], 'giftFor' => $this->bob])->json('id');

        $this->as('alice')->getJson("/api/v1/orders/{$id}")->assertOk();
        $this->as('bob')->getJson("/api/v1/orders/{$id}")->assertOk();
        $this->as('carol')->getJson("/api/v1/orders/{$id}")->assertNotFound();
        $this->assertCount(1, $this->as('bob')->getJson('/api/v1/orders')->json());
        $this->assertCount(0, $this->as('carol')->getJson('/api/v1/orders')->json());
    }

    public function test_the_buyer_can_cancel_an_unpaid_order_and_the_stock_returns(): void
    {
        $mug = $this->makeProduct($this->makeStore(), ['stock' => 5]);
        $id = $this->as('alice')->postJson('/api/v1/orders', ['items' => [['productId' => $mug->id, 'quantity' => 2]]])->json('id');

        $this->as('bob')->postJson("/api/v1/orders/{$id}/cancel")->assertNotFound();
        $this->as('alice')->postJson("/api/v1/orders/{$id}/cancel")->assertOk()->assertJsonPath('status', 'cancelled');

        $this->assertSame(5, $mug->fresh()->stock);
    }

    public function test_a_paid_order_cannot_be_cancelled_by_the_buyer(): void
    {
        $mug = $this->makeProduct($this->makeStore(), ['stock' => 5]);
        $id = $this->as('alice')->postJson('/api/v1/orders', ['items' => [['productId' => $mug->id, 'quantity' => 1]]])->json('id');
        Order::find($id)->update(['status' => Order::PAID]);

        $this->as('alice')->postJson("/api/v1/orders/{$id}/cancel")->assertOk()->assertJsonPath('status', 'paid');
        $this->assertSame(4, $mug->fresh()->stock);
    }
}
