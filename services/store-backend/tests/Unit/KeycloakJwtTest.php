<?php

namespace Tests\Unit;

use App\Services\KeycloakJwt;
use Firebase\JWT\JWT;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;
use UnexpectedValueException;

/** The real signature/issuer/expiry checks, with a throw-away RSA key and a fake JWKS endpoint (no Keycloak needed). */
class KeycloakJwtTest extends TestCase
{
    private const ISSUER = 'http://localhost:8080/realms/chatpay';

    private function keypair(): array
    {
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        openssl_pkey_export($key, $private);
        $rsa = openssl_pkey_get_details($key)['rsa'];
        $b64 = fn (string $bin) => rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');

        return [$private, ['kty' => 'RSA', 'use' => 'sig', 'alg' => 'RS256', 'n' => $b64($rsa['n']), 'e' => $b64($rsa['e'])]];
    }

    private function token(string $private, string $kid, array $claims = []): string
    {
        return JWT::encode($claims + ['iss' => self::ISSUER, 'sub' => 'user-1', 'iat' => time(), 'exp' => time() + 300], $private, 'RS256', $kid);
    }

    private function jwks(array ...$keys): void
    {
        Http::fake(['*/protocol/openid-connect/certs' => Http::response(['keys' => $keys])]);
    }

    public function test_a_valid_token_yields_its_claims(): void
    {
        [$private, $jwk] = $this->keypair();
        $this->jwks($jwk + ['kid' => 'k1']);

        $claims = (new KeycloakJwt())->verify($this->token($private, 'k1', ['preferred_username' => 'alice']));

        $this->assertSame('user-1', $claims['sub']);
        $this->assertSame('alice', $claims['preferred_username']);
    }

    public function test_expired_forged_and_wrong_issuer_tokens_are_rejected(): void
    {
        [$private, $jwk] = $this->keypair();
        [$otherPrivate] = $this->keypair();
        $this->jwks($jwk + ['kid' => 'k1']);
        $verifier = new KeycloakJwt();

        foreach ([
            'expired' => $this->token($private, 'k1', ['exp' => time() - 3600, 'iat' => time() - 7200]),
            'signed with another key' => $this->token($otherPrivate, 'k1'),
            'wrong issuer' => $this->token($private, 'k1', ['iss' => 'http://evil.example/realms/chatpay']),
        ] as $why => $token) {
            try {
                $verifier->verify($token);
                $this->fail("Accepted a token that is {$why}");
            } catch (\Throwable $e) {
                $this->assertInstanceOf(\Exception::class, $e, $why);
            }
        }
    }

    public function test_a_rotated_key_is_picked_up_by_refreshing_the_jwks_once(): void
    {
        [$oldPrivate, $oldJwk] = $this->keypair();
        [$newPrivate, $newJwk] = $this->keypair();
        $verifier = new KeycloakJwt();

        $this->jwks($oldJwk + ['kid' => 'old']);
        $verifier->verify($this->token($oldPrivate, 'old'));            // caches the old key set

        $this->jwks($oldJwk + ['kid' => 'old'], $newJwk + ['kid' => 'new']);
        $claims = $verifier->verify($this->token($newPrivate, 'new'));  // unknown kid: refetch the key set and retry

        $this->assertSame('user-1', $claims['sub']);
    }

    public function test_an_unknown_key_that_never_appears_is_rejected(): void
    {
        [$private] = $this->keypair();
        [, $someJwk] = $this->keypair();
        $this->jwks($someJwk + ['kid' => 'other']);

        $this->expectException(UnexpectedValueException::class);
        (new KeycloakJwt())->verify($this->token($private, 'missing'));
    }

    protected function setUp(): void
    {
        parent::setUp();
        Cache::flush();
    }
}
