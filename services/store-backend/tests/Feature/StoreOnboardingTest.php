<?php

namespace Tests\Feature;

use App\Models\Store;
use Filament\Panel;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\StoreFixtures;
use Tests\TestCase;

class StoreOnboardingTest extends TestCase
{
    use RefreshDatabase, StoreFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->fakeLogins();
    }

    public function test_anyone_signed_in_can_apply_and_the_store_starts_pending_and_invisible(): void
    {
        $this->as('carol')->postJson('/api/v1/stores', ['name' => 'Carol Crafts', 'description' => 'Handmade'])
            ->assertCreated()->assertJsonPath('status', 'pending')->assertJsonPath('slug', 'carol-crafts');

        $this->getJson('/api/v1/stores/carol-crafts')->assertNotFound();
        $this->assertSame([], \App\Models\OutboxEvent::pluck('routing_key')->all());   // not announced until an admin activates it
    }

    public function test_applying_needs_a_login_and_valid_input(): void
    {
        $this->postJson('/api/v1/stores', ['name' => 'Anon Shop'])->assertUnauthorized();
        $this->as('carol')->postJson('/api/v1/stores', ['name' => 'x'])->assertStatus(422);
    }

    public function test_one_store_per_person_and_unique_slugs(): void
    {
        $this->as('carol')->postJson('/api/v1/stores', ['name' => 'Same Name'])->assertCreated();
        $this->as('carol')->postJson('/api/v1/stores', ['name' => 'Another'])->assertStatus(409)->assertJsonPath('code', 'STORE_EXISTS');

        $this->as('alice')->postJson('/api/v1/stores', ['name' => 'Same Name'])->assertCreated()->assertJsonPath('slug', 'same-name-2');
    }

    public function test_the_owner_can_see_their_own_store_in_any_status(): void
    {
        $this->as('carol')->getJson('/api/v1/me/store')->assertOk()->assertJsonPath('store', null);
        $this->as('carol')->postJson('/api/v1/stores', ['name' => 'Carol Crafts']);

        $this->as('carol')->getJson('/api/v1/me/store')->assertOk()->assertJsonPath('store.status', 'pending');
    }

    public function test_the_vendor_panel_opens_only_for_an_approved_store(): void
    {
        $vendorPanel = Panel::make()->id('vendor');
        $adminPanel = Panel::make()->id('admin');
        $carol = $this->makeUser($this->carol);
        $store = Store::create(['owner_user_id' => $this->carol, 'name' => 'Carol Crafts', 'slug' => 'carol-crafts', 'status' => 'pending']);

        $this->assertFalse($carol->canAccessPanel($vendorPanel));   // applied, not approved yet
        $store->update(['status' => 'active']);
        $this->assertTrue($carol->canAccessPanel($vendorPanel));
        $store->update(['status' => 'suspended']);
        $this->assertTrue($carol->canAccessPanel($vendorPanel));    // suspended owners can still see their orders
        $store->update(['status' => 'closed']);
        $this->assertFalse($carol->canAccessPanel($vendorPanel));

        $this->assertFalse($carol->canAccessPanel($adminPanel));    // owning a store never grants admin access
        $this->assertTrue($this->makeUser($this->alice, ['catalog-admin'])->canAccessPanel($adminPanel));
        $this->assertTrue($this->makeUser($this->bob, ['wallet-admin'])->canAccessPanel($adminPanel));
    }

    public function test_anonymous_calls_never_use_up_the_quota_and_the_limit_is_per_person(): void
    {
        for ($i = 0; $i < 8; $i++) {
            $this->postJson('/api/v1/stores', ['name' => 'Anon Shop'])->assertUnauthorized();   // refused before the limiter sees them
        }

        $this->as('carol')->postJson('/api/v1/stores', ['name' => 'Carol Crafts'])->assertCreated();   // 1st attempt this hour
        for ($i = 0; $i < 4; $i++) {
            $this->as('carol')->postJson('/api/v1/stores', ['name' => 'Again'])->assertStatus(409);     // attempts 2..5
        }
        $this->as('carol')->postJson('/api/v1/stores', ['name' => 'Again'])->assertStatus(429);         // the 6th in an hour

        $this->as('alice')->postJson('/api/v1/stores', ['name' => 'Alice Wares'])->assertCreated();     // someone else is unaffected
    }
}
