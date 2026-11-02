<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Services\AdminTokens;
use App\Services\KeycloakJwt;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/** Back-office sign-in with Keycloak (authorization code flow, confidential client). Filament never handles passwords. */
class KeycloakController extends Controller
{
    public function redirect(Request $request)
    {
        $state = Str::random(40);
        $request->session()->put('kc_state', $state);

        return redirect(config('store.oidc.issuer').'/protocol/openid-connect/auth?'.http_build_query([
            'client_id' => config('store.admin_login.client_id'),
            'redirect_uri' => config('store.admin_login.redirect'),
            'response_type' => 'code',
            'scope' => 'openid profile email',
            'state' => $state,
        ]));
    }

    public function callback(Request $request, KeycloakJwt $jwt, AdminTokens $tokens)
    {
        abort_unless(hash_equals((string) $request->session()->pull('kc_state', ''), (string) $request->query('state', '')), 400, 'Invalid sign-in state');
        abort_if($request->query('error'), 403, 'Sign-in was refused');

        $response = Http::asForm()->timeout(10)->post(config('store.oidc.issuer').'/protocol/openid-connect/token', [
            'grant_type' => 'authorization_code',
            'code' => $request->query('code'),
            'redirect_uri' => config('store.admin_login.redirect'),
            'client_id' => config('store.admin_login.client_id'),
            'client_secret' => config('store.admin_login.client_secret'),
        ]);
        abort_if($response->failed(), 403, 'Sign-in failed');

        $token = $response->json();
        $claims = $jwt->verify($token['access_token']);

        $user = User::updateOrCreate(['id' => $claims['sub']], [
            'name' => $claims['name'] ?? $claims['preferred_username'] ?? null,
            'username' => $claims['preferred_username'] ?? null,
            'email' => $claims['email'] ?? null,
            'roles' => $claims['realm_access']['roles'] ?? [],
        ]);

        $target = ($user->hasRole('catalog-admin') || $user->hasRole('wallet-admin')) ? '/admin'
            : ($user->store()->whereIn('status', ['active', 'suspended'])->exists() ? '/vendor' : null);
        abort_if($target === null, 403, 'Your account has no back-office access. If you applied for a store, an admin still has to approve it.');

        Auth::login($user);
        $request->session()->regenerate();
        $tokens->store($token);

        return redirect($target);
    }

    public function logout(Request $request, AdminTokens $tokens)
    {
        $idToken = $tokens->idToken();
        Auth::logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return redirect(config('store.oidc.issuer').'/protocol/openid-connect/logout?'.http_build_query(array_filter([
            'client_id' => config('store.admin_login.client_id'),
            'post_logout_redirect_uri' => url('/'),
            'id_token_hint' => $idToken,
        ])));
    }
}
