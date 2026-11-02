<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;

/**
 * The signed-in admin's own Keycloak tokens, kept in the session. The back office calls the wallet with THIS token
 * (never a shared super token), so the wallet attributes every action to a real person and enforces their roles.
 */
class AdminTokens
{
    public function store(array $token): void
    {
        session(['kc' => [
            'access' => $token['access_token'],
            'refresh' => $token['refresh_token'] ?? null,
            'id' => $token['id_token'] ?? null,
            'expires_at' => time() + (int) ($token['expires_in'] ?? 60),
        ]]);
    }

    /** True when the access token is (nearly) expired, i.e. it is time to ask Keycloak again who this person is and what they may do. */
    public function needsRefresh(): bool
    {
        $kc = session('kc');

        return ! $kc || $kc['expires_at'] - 30 <= time();
    }

    public function idToken(): ?string
    {
        return session('kc.id');
    }

    public function accessToken(): string
    {
        $kc = session('kc');
        if (! $kc) {
            abort(401, 'Not signed in');
        }
        if ($kc['expires_at'] - 30 > time()) {
            return $kc['access'];
        }
        if (! $kc['refresh']) {
            abort(401, 'Session expired');
        }

        $response = Http::asForm()->timeout(10)->post(config('store.oidc.issuer').'/protocol/openid-connect/token', [
            'grant_type' => 'refresh_token',
            'refresh_token' => $kc['refresh'],
            'client_id' => config('store.admin_login.client_id'),
            'client_secret' => config('store.admin_login.client_secret'),
        ]);
        if ($response->failed()) {
            abort(401, 'Session expired');
        }
        $this->store($response->json());

        return session('kc.access');
    }
}
