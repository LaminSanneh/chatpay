<?php

namespace App\Services;

use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;

/** Finance operations, called with the signed-in admin's own token. The wallet decides what that admin may do. */
class WalletAdminClient
{
    public function __construct(private AdminTokens $tokens) {}

    public function wallet(string $userId): array { return $this->get("/api/v1/admin/users/{$userId}/wallet"); }
    public function transfers(string $userId, int $limit = 20): array { return $this->get("/api/v1/admin/users/{$userId}/transfers", ['limit' => $limit]); }
    public function entries(string $accountId, int $limit = 20): array { return $this->get("/api/v1/admin/accounts/{$accountId}/entries", ['limit' => $limit]); }
    public function reconciliation(): array { return $this->get('/api/v1/admin/reconciliation'); }
    public function actions(string $status): array { return $this->get('/api/v1/admin/actions', ['status' => $status]); }

    public function requestAdjustment(array $body): array { return $this->post('/api/v1/admin/adjustments', $body); }
    public function requestReversal(string $transferId, array $body): array { return $this->post("/api/v1/admin/transfers/{$transferId}/reversal", $body); }
    public function approve(string $actionId, ?string $note): array { return $this->post("/api/v1/admin/actions/{$actionId}/approve", ['note' => $note]); }
    public function reject(string $actionId, ?string $note): array { return $this->post("/api/v1/admin/actions/{$actionId}/reject", ['note' => $note]); }

    /** For modals: never throws, returns an error string instead. */
    public function lookup(string $userId): array
    {
        try {
            $wallet = $this->wallet($userId);

            return ['wallet' => $wallet, 'transfers' => $this->transfers($userId), 'entries' => $this->entries($wallet['accountId']), 'error' => null];
        } catch (WalletException $e) {
            return ['wallet' => null, 'transfers' => [], 'entries' => ['items' => []], 'error' => $e->getMessage()];
        }
    }

    private function get(string $path, array $query = []): array
    {
        return $this->handle(Http::withToken($this->tokens->accessToken())->acceptJson()->timeout(10)->get($this->url($path), $query));
    }

    private function post(string $path, array $json): array
    {
        return $this->handle(Http::withToken($this->tokens->accessToken())->acceptJson()->timeout(10)->post($this->url($path), $json));
    }

    private function url(string $path): string
    {
        return rtrim(config('store.wallet.url'), '/').$path;
    }

    private function handle(Response $response): array
    {
        if ($response->failed()) {
            throw new WalletException($response->status(), (string) ($response->json('code') ?? 'WALLET_ERROR'),
                (string) ($response->json('message') ?? 'Wallet request failed'));
        }

        return $response->json() ?? [];
    }
}
