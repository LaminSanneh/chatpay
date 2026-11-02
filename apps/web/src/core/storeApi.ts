import { config } from './config';
import { request, type TokenProvider } from './http';
import type { CreateOrderInput, Product, ProductPage, StoreOrder } from './types';

/**
 * The chat's window into the store. Browsing is public; buying uses the same Keycloak token as the rest of the chat.
 * The chat never needs the store to be up: callers treat every failure as "store unavailable" and hide the shop.
 */
export class StoreApi {
  constructor(private getToken: TokenProvider, private baseUrl: string = config.storeApiUrl) {}

  private async pub<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Store request failed (${res.status})`);
    return res.json() as Promise<T>;
  }

  hot() { return this.pub<Product[]>('/products/hot'); }
  search(q: string) { return this.pub<ProductPage>(`/products?search=${encodeURIComponent(q)}&per_page=12`); }

  /** The store prices the order and answers with `payment.intentId`, which the buyer then confirms in the wallet. */
  createOrder(input: CreateOrderInput) {
    return request<StoreOrder>(`${this.baseUrl}/orders`, this.getToken, { method: 'POST', body: JSON.stringify(input) });
  }
  cancelOrder(id: string) { return request<StoreOrder>(`${this.baseUrl}/orders/${id}/cancel`, this.getToken, { method: 'POST' }); }
}
