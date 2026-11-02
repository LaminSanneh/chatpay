<?php

namespace App\Http\Middleware;

use App\Services\KeycloakJwt;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** `kc` requires a valid bearer token; `kc:optional` identifies the caller when one is sent and lets anonymous calls through. */
class AuthenticateKeycloak
{
    public function __construct(private KeycloakJwt $jwt) {}

    public function handle(Request $request, Closure $next, ?string $mode = null): Response
    {
        $header = (string) $request->header('Authorization', '');
        $token = str_starts_with($header, 'Bearer ') ? substr($header, 7) : '';

        if ($token === '') {
            return $mode === 'optional' ? $next($request) : $this->deny('Missing bearer token');
        }

        try {
            $claims = $this->jwt->verify($token);
        } catch (\Throwable) {
            return $this->deny('Invalid or expired token');
        }

        $request->attributes->set('kc_claims', $claims);
        $request->attributes->set('user_id', $claims['sub']);

        return $next($request);
    }

    private function deny(string $message): Response
    {
        return response()->json(['code' => 'UNAUTHENTICATED', 'message' => $message], 401);
    }
}
