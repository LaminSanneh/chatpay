<?php

namespace App\Http\Middleware;

use App\Support\Correlation;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Takes X-Correlation-Id from the request (or makes one), makes it the current id for logging and for everything this request calls or
 * publishes (the wallet, the outbox), and returns it on the response. Error responses get it too (see bootstrap/app.php).
 */
class AssignCorrelationId
{
    public function handle(Request $request, Closure $next): Response
    {
        $id = Correlation::sanitize($request->header(Correlation::HEADER)) ?? Correlation::generate();
        Correlation::set($id);
        $request->attributes->set('correlation_id', $id);

        $response = $next($request);
        $response->headers->set(Correlation::HEADER, $id);

        return $response;
    }

    /** A long-lived worker (php artisan serve) must not carry this request's id into the next one. */
    public function terminate(Request $request, Response $response): void
    {
        Correlation::set(null);
    }
}
