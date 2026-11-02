import { ApiError, request, type TokenProvider } from './http';
import type { TransferIntent } from './types';

/** Only what checkout needs: look at, confirm or cancel a payment that the store backend created for an order. */
export class WalletApi {
  constructor(private baseUrl: string, private getToken: TokenProvider) {}
  private r<T>(path: string, init?: RequestInit) { return request<T>(`${this.baseUrl}/api/v1${path}`, this.getToken, init); }

  getIntent(id: string) { return this.r<TransferIntent>(`/transfer-intents/${id}`); }
  /** Idempotent: resolves (200) only if the payment is COMPLETED, however many times it is called. */
  confirmIntent(id: string) { return this.r<TransferIntent>(`/transfer-intents/${id}/confirm`, { method: 'POST' }); }
  cancelIntent(id: string) { return this.r<TransferIntent>(`/transfer-intents/${id}/cancel`, { method: 'POST' }); }
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
