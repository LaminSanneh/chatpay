import { ApiError, request, type TokenProvider } from './http';
import type { EntriesPage, TransferIntent, Wallet } from './types';

export interface CreateIntentInput {
  toUserId: string;
  amountMinor: number;
  note?: string;
  /** Opaque to the wallet. For chat payments: { type: 'chat', id: roomId } */
  reference?: { type: string; id: string };
}

export class WalletApi {
  constructor(private baseUrl: string, private getToken: TokenProvider) {}
  private r<T>(path: string, init?: RequestInit) { return request<T>(`${this.baseUrl}/api/v1${path}`, this.getToken, init); }

  wallet() { return this.r<Wallet>('/wallet'); }
  /** Statement, newest first. Pass `nextBefore` from the previous page to load older entries. */
  entries(before?: number, limit = 30) {
    return this.r<EntriesPage>(`/wallet/entries?limit=${limit}${before ? `&before=${before}` : ''}`);
  }

  // ---- payments are a 2-step, server-tracked flow: create an intent, then confirm it ----
  /** Step 1. Nothing is paid yet. Safe to repeat; unconfirmed intents simply expire. */
  createIntent(input: CreateIntentInput) {
    return this.r<TransferIntent>('/transfer-intents', { method: 'POST', body: JSON.stringify(input) });
  }
  /** Step 2. Idempotent: resolves successfully (200) only if the payment is COMPLETED, however many times it is called. */
  confirmIntent(id: string) { return this.r<TransferIntent>(`/transfer-intents/${id}/confirm`, { method: 'POST' }); }
  cancelIntent(id: string) { return this.r<TransferIntent>(`/transfer-intents/${id}/cancel`, { method: 'POST' }); }
  /** Recovery: ask the server what happened to an attempt. */
  getIntent(id: string) { return this.r<TransferIntent>(`/transfer-intents/${id}`); }
  /** Recovery after a refresh or device switch: payments still waiting for confirmation. */
  openIntents() { return this.r<TransferIntent[]>('/transfer-intents?open=true'); }

  devTopUp(amountMinor: number) {
    return this.r<{ balanceMinor: number }>('/dev/topup', { method: 'POST', body: JSON.stringify({ amountMinor }) });
  }
}

/**
 * True when the server clearly refused the request, so nothing was changed by it.
 * Anything else (network failure, timeout, 5xx, 429, or a "retry" conflict) means the outcome is UNKNOWN.
 */
export function isDefinitiveRejection(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 409 && e.code === 'CONFLICT_RETRY') return false;
  if (e.status === 408 || e.status === 429) return false;
  return e.status >= 400 && e.status < 500;
}
