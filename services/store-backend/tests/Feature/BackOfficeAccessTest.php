<?php

namespace Tests\Feature;

use App\Http\Middleware\SyncBackOfficeAccess;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Route;
use Tests\Support\StoreFixtures;
use Tests\TestCase;

/** Roles are copied from the token at sign-in; this proves they are re-read (and access can be lost) when the token expires. */
class BackOfficeAccessTest extends TestCase
{
    use RefreshDatabase, StoreFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->fakeLogins();
        Route::middleware(['web', SyncBackOfficeAccess::class])->get('/_test/office', fn () => 'in');
    }

    private function getSession(int $expiresIn): array
    {
        return ['kc' => ['access' => 'old-access', 'refresh' => 'refresh-1', 'id' => 'id-1', 'expires_at' => time() + $expiresIn]];
    }

    public function test_a_still_valid_token_means_no_call_to_keycloak(): void
    {
        Http::fake();
        $user = $this->makeUser($this->alice, ['catalog-admin']);

        $this->actingAs($user)->withSession($this->getSession(600))->get('/_test/office')->assertOk();

        Http::assertNothingSent();
        $this->assertSame(['catalog-admin'], $user->fresh()->roles);
    }

    public function test_an_expired_token_is_refreshed_and_the_roles_are_re_read(): void
    {
        Http::fake(['*/protocol/openid-connect/token' => Http::response(['access_token' => 'new-access', 'refresh_token' => 'refresh-2', 'expires_in' => 900])]);
        $user = $this->makeUser($this->alice, ['catalog-admin']);

        $this->actingAs($user)->withSession($this->getSession(-10))->get('/_test/office')->assertOk();

        $this->assertSame(['wallet-admin'], $user->fresh()->roles);   // what Keycloak says now, not what it said at sign-in
    }

    public function test_if_keycloak_refuses_to_refresh_the_person_is_signed_out(): void
    {
        Http::fake(['*/protocol/openid-connect/token' => Http::response(['error' => 'invalid_grant'], 400)]);
        $user = $this->makeUser($this->alice, ['catalog-admin']);

        $this->actingAs($user)->withSession($this->getSession(-10))->get('/_test/office')
            ->assertRedirect(route('keycloak.redirect'));

        $this->assertGuest();
    }
}
