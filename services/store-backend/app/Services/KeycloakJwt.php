<?php

namespace App\Services;

use Firebase\JWT\JWK;
use Firebase\JWT\JWT;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use UnexpectedValueException;

/** Validates Keycloak access tokens locally: signature (JWKS, cached), expiry and issuer. Keycloak is not called per request. */
class KeycloakJwt
{
    public function __construct()
    {
        JWT::$leeway = 30;
    }

    /** @return array<string, mixed> the token's claims */
    public function verify(string $token): array
    {
        try {
            $decoded = JWT::decode($token, $this->keys(false));
        } catch (UnexpectedValueException $e) {
            if (! str_contains($e->getMessage(), 'kid')) {
                throw $e;
            }
            $decoded = JWT::decode($token, $this->keys(true));   // keys rotated: refresh the JWKS once
        }

        $claims = json_decode(json_encode($decoded), true);
        if (($claims['iss'] ?? null) !== config('store.oidc.issuer')) {
            throw new UnexpectedValueException('Wrong token issuer');
        }

        return $claims;
    }

    private function keys(bool $refresh): array
    {
        if ($refresh) {
            Cache::forget('oidc.jwks');
        }
        $jwks = Cache::remember('oidc.jwks', 600, fn () => Http::timeout(5)->get(config('store.oidc.jwks_uri'))->throw()->json());

        return JWK::parseKeySet($jwks);
    }
}
