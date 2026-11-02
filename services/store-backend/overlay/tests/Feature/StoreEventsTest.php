<?php

namespace Tests\Feature;

use App\Models\OutboxEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\StoreFixtures;
use Tests\TestCase;

/** The chat shows a store icon next to a store owner: it learns about it from these events (and only from these). */
class StoreEventsTest extends TestCase
{
    use RefreshDatabase, StoreFixtures;

    private function routingKeys(): array
    {
        return OutboxEvent::orderBy('id')->pluck('routing_key')->all();
    }

    public function test_a_pending_store_announces_nothing(): void
    {
        $this->makeStore(['status' => 'pending']);

        $this->assertSame([], $this->routingKeys());
    }

    public function test_opening_a_store_publishes_store_opened_with_what_the_chat_needs(): void
    {
        $store = $this->makeStore();

        $event = OutboxEvent::firstOrFail();
        $this->assertSame('store.events', $event->exchange);
        $this->assertSame('store.opened', $event->routing_key);
        $this->assertSame($this->bob, $event->payload['ownerUserId']);
        $this->assertSame((string) $store->id, $event->payload['storeId']);
        $this->assertSame("Bob's Shop", $event->payload['name']);
        $this->assertSame('bobs-shop', $event->payload['slug']);
    }

    public function test_suspending_and_reactivating_a_store_publishes_closed_then_opened(): void
    {
        $store = $this->makeStore();

        $store->update(['status' => 'suspended']);
        $store->update(['status' => 'active']);

        $this->assertSame(['store.opened', 'store.closed', 'store.opened'], $this->routingKeys());
    }

    public function test_renaming_an_active_store_re_announces_it_but_a_closed_one_stays_quiet(): void
    {
        $store = $this->makeStore();
        $store->update(['name' => 'Bob & Sons']);
        $this->assertSame(['store.opened', 'store.opened'], $this->routingKeys());
        $this->assertSame('Bob & Sons', OutboxEvent::orderByDesc('id')->first()->payload['name']);

        $store->update(['status' => 'closed']);
        $store->update(['name' => 'Bob again']);
        $this->assertSame(['store.opened', 'store.opened', 'store.closed'], $this->routingKeys());
    }
}
