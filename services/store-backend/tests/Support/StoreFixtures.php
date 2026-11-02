<?php

namespace Tests\Support;

use App\Models\Product;
use App\Models\Store;
use App\Models\User;
use App\Services\KeycloakJwt;
use Illuminate\Support\Facades\Http;

/** Shared setup for the feature tests: fake logins (alice, bob, carol, finance), a fake wallet, and store/product builders. */
trait StoreFixtures
{
    protected string $alice = '11111111-1111-4111-8111-111111111111';
    protected string $bob = '22222222-2222-4222-8222-222222222222';
    protected string $carol = '66666666-6666-4666-8666-666666666666';

    /** Bearer tokens "alice", "bob", "carol" and "finance" are accepted. */
    protected function fakeLogins(): void
    {
        $user = fn (string $sub, string $name, array $roles = []) => ['sub' => $sub, 'preferred_username' => $name, 'name' => ucfirst($name), 'realm_access' => ['roles' => $roles]];
        $this->app->instance(KeycloakJwt::class, new FakeKeycloakJwt([
            'alice' => $user($this->alice, 'alice'),
            'bob' => $user($this->bob, 'bob'),
            'carol' => $user($this->carol, 'carol'),
            'finance' => $user('44444444-4444-4444-8444-444444444444', 'finance1', ['wallet-admin']),
            'new-access' => $user($this->alice, 'alice', ['wallet-admin']),
        ]));
    }

    protected function as(string $token): static
    {
        return $this->withHeader('Authorization', 'Bearer '.$token);
    }

    /** A wallet that accepts everything. Override single routes by calling Http::fake again with a more specific pattern first. */
    protected function fakeWallet(array $overrides = []): void
    {
        Http::fake($overrides + [
            '*/protocol/openid-connect/token' => Http::response(['access_token' => 'svc-token', 'expires_in' => 900]),
            '*/api/v1/internal/transfer-intents' => Http::response(['id' => 'intent-1', 'expiresAt' => now()->addMinutes(30)->toIso8601String()], 201),
            '*/api/v1/internal/orders/*/release' => Http::response(['id' => 'settlement-1']),
            '*/api/v1/internal/orders/*/refund' => Http::response(['id' => 'settlement-2']),
        ]);
    }

    protected function makeStore(array $attributes = []): Store
    {
        return Store::create($attributes + ['owner_user_id' => $this->bob, 'name' => "Bob's Shop", 'slug' => 'bobs-shop', 'status' => 'active']);
    }

    protected function makeProduct(Store $store, array $attributes = []): Product
    {
        static $n = 0;
        $n++;

        return Product::create($attributes + [
            'store_id' => $store->id, 'name' => "Product {$n}", 'slug' => "product-{$n}", 'price_minor' => 2500,
            'stock' => 10, 'status' => 'active', 'is_hot' => false, 'currency' => 'GMD',
        ]);
    }

    protected function makeUser(string $id, array $roles = []): User
    {
        return User::create(['id' => $id, 'name' => 'Test '.substr($id, 0, 4), 'username' => 'u'.substr($id, 0, 4), 'roles' => $roles]);
    }
}
