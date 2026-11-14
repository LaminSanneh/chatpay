<?php

namespace Tests\Feature;

use App\Models\OutboxEvent;
use App\Services\OrderService;
use App\Services\WalletClient;
use App\Support\Correlation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\Support\Contract;
use Tests\Support\StoreFixtures;
use Tests\TestCase;

/** One correlation id from the HTTP request, through the wallet call and the outbox event, to the AMQP header the relay publishes. */
class CorrelationIdTest extends TestCase
{
    use RefreshDatabase, StoreFixtures;

    private const UUID = '/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/';

    protected function setUp(): void
    {
        parent::setUp();
        $this->fakeLogins();
        Correlation::set(null);
    }

    public function test_a_response_carries_the_id_the_client_sent_or_a_new_one(): void
    {
        $sent = $this->withHeader('X-Correlation-Id', 'from-the-client-1')->getJson('/api/v1/products');
        $none = $this->getJson('/api/v1/products');
        $bad = $this->withHeader('X-Correlation-Id', 'not valid!')->getJson('/api/v1/products');

        $sent->assertHeader('X-Correlation-Id', 'from-the-client-1');
        $this->assertMatchesRegularExpression(self::UUID, $none->headers->get('X-Correlation-Id'));
        $this->assertMatchesRegularExpression(self::UUID, $bad->headers->get('X-Correlation-Id'));
    }

    public function test_error_responses_can_be_traced_too(): void
    {
        $unauthenticated = $this->withHeader('X-Correlation-Id', 'trace-401')->postJson('/api/v1/orders', []);
        $notFound = $this->withHeader('X-Correlation-Id', 'trace-404')->getJson('/api/v1/nothing-here');

        $unauthenticated->assertUnauthorized()->assertHeader('X-Correlation-Id', 'trace-401');
        $notFound->assertNotFound()->assertHeader('X-Correlation-Id', 'trace-404');
    }

    public function test_the_wallet_is_called_under_the_same_id(): void
    {
        $this->fakeWallet();

        Correlation::within('trace-1', fn () => app(WalletClient::class)->createOrderIntent($this->alice, 'store-1', 'order-1', 5000));

        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), '/api/v1/internal/transfer-intents') && $r->hasHeader('X-Correlation-Id', 'trace-1'));
    }

    public function test_a_checkout_request_passes_its_id_on_to_the_wallet(): void
    {
        $this->fakeWallet();
        $product = $this->makeProduct($this->makeStore(), ['price_minor' => 2500, 'stock' => 5]);

        $this->withHeader('X-Correlation-Id', 'trace-http')->as('alice')
            ->postJson('/api/v1/orders', ['items' => [['productId' => $product->id, 'quantity' => 1]]])->assertCreated()
            ->assertHeader('X-Correlation-Id', 'trace-http');

        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), '/api/v1/internal/transfer-intents') && $r->hasHeader('X-Correlation-Id', 'trace-http'));
    }

    public function test_events_written_to_the_outbox_carry_the_id_of_the_work_that_caused_them(): void
    {
        $store = Correlation::within('trace-2', fn () => $this->makeStore());
        $outside = $this->makeStore(['slug' => 'other', 'name' => 'Other', 'owner_user_id' => $this->carol]);

        $caused = OutboxEvent::where('routing_key', 'store.opened')->orderBy('id')->get();
        $this->assertSame('trace-2', $caused[0]->payload['correlationId']);
        $this->assertMatchesRegularExpression(self::UUID, $caused[1]->payload['correlationId'], 'an event created outside any request still gets an id');
    }

    public function test_the_follow_up_event_reuses_the_id_of_the_payment_message_that_caused_it(): void
    {
        $this->fakeWallet();
        $product = $this->makeProduct($this->makeStore(), ['price_minor' => 2500, 'stock' => 10]);
        $order = app(OrderService::class)->create($this->alice, ['items' => [['productId' => $product->id, 'quantity' => 2]], 'giftFor' => $this->bob, 'context' => ['type' => 'chat', 'roomId' => 'room-1']]);
        $payment = array_merge(Contract::load('transfer.completed.order-payment'), [
            'referenceId' => $order->id, 'intentId' => $order->payment_intent_id, 'fromUserId' => $order->buyer_user_id,
            'amountMinor' => $order->total_minor, 'currency' => $order->currency,
        ]);

        // The consumer runs the handler under the id the wallet's message carried (MessageProcessor does this; see its tests).
        Correlation::within('trace-3', fn () => app(OrderService::class)->onTransferCompleted($payment));

        $paid = OutboxEvent::where('routing_key', 'order.paid')->firstOrFail();
        $this->assertSame('trace-3', $paid->payload['correlationId']);
    }

    public function test_the_log_context_follows_the_current_id(): void
    {
        $heard = [];
        Correlation::listen(function (?string $id) use (&$heard) {
            $heard[] = $id;
        });

        $this->withHeader('X-Correlation-Id', 'trace-log')->getJson('/api/v1/products');

        $this->assertContains('trace-log', $heard);
        Correlation::listen(null);
    }
}
