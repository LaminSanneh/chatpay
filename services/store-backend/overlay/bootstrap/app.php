<?php

use App\Http\Middleware\AuthenticateKeycloak;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Routing\Middleware\ThrottleRequests;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // `kc` = a valid Keycloak access token is required; `kc:optional` = identify the caller if a token is sent.
        $middleware->alias(['kc' => AuthenticateKeycloak::class]);
        // Identify the caller BEFORE rate limiting. Laravel would otherwise run the throttle first (it sorts known middleware by priority),
        // which makes anonymous requests use up the quota and stops limits from being per signed-in person.
        $middleware->prependToPriorityList(ThrottleRequests::class, AuthenticateKeycloak::class);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
