<?php

namespace App\Http\Middleware;

use App\Models\User;
use App\Services\AdminTokens;
use App\Services\KeycloakJwt;
use Closure;
use Filament\Facades\Filament;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * Back-office roles are copied from the token at sign-in. To make revocation real, whenever the short-lived access token
 * expires we refresh it with Keycloak (which refuses if the person was disabled or signed out), re-read their roles from
 * the new token, and re-check that they may still use this panel. At worst, access outlives a revocation by one token lifetime.
 */
class SyncBackOfficeAccess
{
    public function __construct(private AdminTokens $tokens, private KeycloakJwt $jwt) {}

    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();
        if (! $user instanceof User || ! $this->tokens->needsRefresh()) {
            return $next($request);
        }

        try {
            $claims = $this->jwt->verify($this->tokens->accessToken());   // refreshes with Keycloak when needed
        } catch (\Throwable) {
            Auth::logout();
            $request->session()->invalidate();

            return redirect()->route('keycloak.redirect');
        }

        $user->forceFill(['roles' => $claims['realm_access']['roles'] ?? []])->save();

        $panel = Filament::getCurrentPanel();
        if ($panel && ! $user->canAccessPanel($panel)) {
            abort(403, 'Your access to this panel was removed.');
        }

        return $next($request);
    }
}
