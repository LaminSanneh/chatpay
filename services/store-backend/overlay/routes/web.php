<?php

use App\Http\Controllers\Auth\KeycloakController;
use Illuminate\Support\Facades\Route;

Route::get('/', fn () => redirect('/admin'));

// Back office sign-in: Keycloak (authorization code flow). Filament never sees a password.
Route::get('/auth/keycloak/redirect', [KeycloakController::class, 'redirect'])->name('keycloak.redirect');
Route::get('/auth/keycloak/callback', [KeycloakController::class, 'callback'])->name('keycloak.callback');
Route::get('/auth/logout', [KeycloakController::class, 'logout'])->name('keycloak.logout');
