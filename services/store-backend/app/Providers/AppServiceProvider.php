<?php

namespace App\Providers;

use App\Models\Category;
use App\Models\Product;
use App\Models\Store;
use App\Observers\AuditObserver;
use App\Observers\StoreObserver;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
        // Limits are per signed-in person (Keycloak user id) and fall back to the IP for anonymous callers.
        $who = fn (Request $r) => $r->attributes->get('user_id') ?: $r->ip();
        RateLimiter::for('catalog', fn (Request $r) => Limit::perMinute(120)->by($r->ip()));
        RateLimiter::for('store-api', fn (Request $r) => Limit::perMinute(60)->by($who($r)));
        RateLimiter::for('store-apply', fn (Request $r) => Limit::perHour(5)->by($who($r)));

        Store::observe(StoreObserver::class);

        foreach ([Product::class, Category::class, Store::class] as $model) {
            $model::observe(AuditObserver::class);
        }
    }
}
