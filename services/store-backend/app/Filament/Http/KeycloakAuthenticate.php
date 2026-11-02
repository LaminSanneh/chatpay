<?php

namespace App\Filament\Http;

use Filament\Http\Middleware\Authenticate as FilamentAuthenticate;

/** Not signed in? Send the person to Keycloak instead of a Filament login form. */
class KeycloakAuthenticate extends FilamentAuthenticate
{
    protected function redirectTo($request): ?string
    {
        return route('keycloak.redirect');
    }
}
