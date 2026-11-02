<?php

use App\Http\Controllers\Api\CatalogController;
use App\Http\Controllers\Api\OrderController;
use App\Http\Controllers\Api\StoreController;
use Illuminate\Support\Facades\Route;

Route::prefix('v1')->group(function () {
    // Public: anyone can browse.
    Route::middleware('throttle:catalog')->group(function () {
        Route::get('categories', [CatalogController::class, 'categories']);
        Route::get('products', [CatalogController::class, 'products']);
        Route::get('products/hot', [CatalogController::class, 'hot']);
        Route::get('products/{slug}', [CatalogController::class, 'product']);
        Route::get('stores/{slug}', [CatalogController::class, 'store']);
    });

    // Ordering and selling need a Keycloak login (from the storefront or from the chat app: same realm, same tokens).
    Route::middleware(['kc', 'throttle:store-api'])->group(function () {
        Route::post('orders', [OrderController::class, 'store']);
        Route::get('orders', [OrderController::class, 'index']);
        Route::get('orders/{order}', [OrderController::class, 'show']);
        Route::post('orders/{order}/cancel', [OrderController::class, 'cancel']);

        Route::get('me/store', [StoreController::class, 'mine']);
        Route::post('stores', [StoreController::class, 'apply'])->middleware('throttle:store-apply');
    });
});
