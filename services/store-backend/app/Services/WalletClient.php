<?php

namespace App\Services;

use App\Support\Correlation;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

/**
 * The store backend talking to the wallet AS ITSELF (service account, client credentials, role wallet-merchant).
 * It never moves a buyer's money directly: it creates a payment intent with the price it computed, and the buyer
 * confirms it with their own token. Later it releases or refunds what the wallet is holding in escrow.
 */
class WalletClient
{
    /** Create the payment for an order. The amount comes from OUR database, never from the client. */
    public function createOrderIntent(string $payerUserId, string $storeId, string $orderId, int $amountMinor, ?string $note = null): array
    {
        return $this->post('/api/v1/internal/transfer-intents', [
            'payerUserId' => $payerUserId, 'storeId' => $storeId, 'orderId' => $orderId, 'amountMinor' => $amountMinor, 'note' => $note,
        ]);
    }

    /** Pay the store (minus our commission). Idempotent per key: repeating the call returns the same settlement. */
    public function release(string $orderId, int $commissionMinor, string $idempotencyKey): array
    {
        return $this->post("/api/v1/internal/orders/{$orderId}/release", ['commissionMinor' => $commissionMinor], $idempotencyKey);
    }

    /** Give what is still held for the order back to the buyer. Idempotent per key. */
    public function refund(string $orderId, string $idempotencyKey): array
    {
        return $this->post("/api/v1/internal/orders/{$orderId}/refund", new \stdClass(), $idempotencyKey);
    }

    private function post(string $path, array|\stdClass $json, ?string $idempotencyKey = null): array
    {
        $response = $this->send($path, $json, $idempotencyKey);
        if ($response->status() === 401) {          // cached token expired or revoked: get a fresh one once
            Cache::forget('wallet.service_token');
            $response = $this->send($path, $json, $idempotencyKey);
        }
        if ($response->failed()) {
            throw new WalletException($response->status(), (string) ($response->json('code') ?? 'WALLET_ERROR'),
                (string) ($response->json('message') ?? 'Wallet request failed'));
        }

        return $response->json() ?? [];
    }

    private function send(string $path, array|\stdClass $json, ?string $idempotencyKey): Response
    {
        $request = Http::withToken($this->token())->acceptJson()->timeout(10)
            ->withHeaders([Correlation::HEADER => Correlation::currentOrNew()]);     // the wallet logs and publishes under the same id
        if ($idempotencyKey !== null) {
            $request = $request->withHeaders(['Idempotency-Key' => $idempotencyKey]);
        }

        return $request->post(rtrim(config('store.wallet.url'), '/').$path, $json);
    }

    private function token(): string
    {
        return Cache::remember('wallet.service_token', 600, function () {
            $response = Http::asForm()->timeout(10)->post(config('store.oidc.issuer').'/protocol/openid-connect/token', [
                'grant_type' => 'client_credentials',
                'client_id' => config('store.wallet.client_id'),
                'client_secret' => config('store.wallet.client_secret'),
            ])->throw();

            return $response->json('access_token');
        });
    }
}
