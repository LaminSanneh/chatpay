<?php

return [
    'currency' => env('STORE_CURRENCY', 'GMD'),

    // Platform commission on each release, in basis points (1000 = 10%). A store can override it.
    'commission_bps' => (int) env('STORE_COMMISSION_BPS', 1000),
    // How long after delivery the money stays in escrow before it is released to the store (0 = right away).
    'return_window_days' => (int) env('STORE_RETURN_WINDOW_DAYS', 0),
    // Unpaid orders give their stock back after this long (keep it equal to the wallet's order-intent-ttl-seconds).
    'unpaid_order_ttl_minutes' => (int) env('STORE_UNPAID_TTL_MINUTES', 30),

    'oidc' => [
        'issuer' => env('OIDC_ISSUER', 'http://localhost:8080/realms/chatpay'),
        'jwks_uri' => env('OIDC_JWKS_URI', env('OIDC_ISSUER', 'http://localhost:8080/realms/chatpay').'/protocol/openid-connect/certs'),
    ],

    // Back office login (authorization code flow, confidential client)
    'admin_login' => [
        'client_id' => env('KEYCLOAK_ADMIN_CLIENT_ID', 'laravel-admin'),
        'client_secret' => env('KEYCLOAK_ADMIN_CLIENT_SECRET', 'dev-laravel-admin-secret'),
        'redirect' => env('APP_URL', 'http://localhost:8000').'/auth/keycloak/callback',
    ],

    // Service account for server-to-server calls to the wallet
    'wallet' => [
        'url' => env('WALLET_URL', 'http://localhost:8081'),
        'client_id' => env('WALLET_CLIENT_ID', 'laravel-service'),
        'client_secret' => env('WALLET_CLIENT_SECRET', 'dev-laravel-secret'),
    ],

    'amqp' => [
        'host' => env('AMQP_HOST', '127.0.0.1'),
        'port' => (int) env('AMQP_PORT', 5672),
        'user' => env('AMQP_USER', 'chatpay'),
        'password' => env('AMQP_PASSWORD', 'chatpay'),
        'wallet_exchange' => 'wallet.events',
        'store_exchange' => 'store.events',
        'wallet_queue' => 'store.wallet-events',
        'dead_letter_exchange' => 'store.dlx',
    ],

    // Failed events are retried with exponential backoff (2s, 4s, 8s, 16s, 30s), then dead-lettered. See app/Messaging.
    'retry' => [
        'initial_delay_ms' => (int) env('STORE_RETRY_INITIAL_MS', 2000),
        'multiplier' => (float) env('STORE_RETRY_MULTIPLIER', 2),
        'max_delay_ms' => (int) env('STORE_RETRY_MAX_MS', 30000),
        'max_attempts' => (int) env('STORE_RETRY_MAX_ATTEMPTS', 5),
    ],

    'storefront_url' => env('STORE_WEB_URL', 'http://localhost:3001'),
];
