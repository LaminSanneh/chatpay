<?php

namespace App\Providers\Filament;

use Filament\Http\Middleware\DisableBladeIconComponents;
use Filament\Http\Middleware\DispatchServingFilamentEvent;
use Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Routing\Middleware\SubstituteBindings;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\View\Middleware\ShareErrorsFromSession;

trait PanelDefaults
{
    /** The standard Filament web middleware stack (no password-hash session check: our users have no passwords). */
    protected function baseMiddleware(): array
    {
        // The CSRF middleware class was renamed in newer Laravel versions; use whichever exists.
        $csrf = class_exists(\Illuminate\Foundation\Http\Middleware\PreventRequestForgery::class)
            ? \Illuminate\Foundation\Http\Middleware\PreventRequestForgery::class
            : \Illuminate\Foundation\Http\Middleware\VerifyCsrfToken::class;

        return [
            EncryptCookies::class,
            AddQueuedCookiesToResponse::class,
            StartSession::class,
            ShareErrorsFromSession::class,
            $csrf,
            SubstituteBindings::class,
            DisableBladeIconComponents::class,
            DispatchServingFilamentEvent::class,
        ];
    }
}
