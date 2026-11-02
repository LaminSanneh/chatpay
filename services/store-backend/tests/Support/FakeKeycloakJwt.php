<?php

namespace Tests\Support;

use App\Services\KeycloakJwt;
use UnexpectedValueException;

/** Test double: the bearer token IS a key into a map of claims. Everything else (middleware, controllers) is real. */
class FakeKeycloakJwt extends KeycloakJwt
{
    /** @param array<string, array<string, mixed>> $users token => claims */
    public function __construct(private array $users = [])
    {
        parent::__construct();
    }

    public function verify(string $token): array
    {
        if (! isset($this->users[$token])) {
            throw new UnexpectedValueException('bad token');
        }

        return $this->users[$token] + ['iss' => config('store.oidc.issuer')];
    }
}
