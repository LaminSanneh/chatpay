import { request, type TokenProvider } from './http';
import { config } from './config';
import type { Category, CreateOrderInput, MyStore, Order, Product, ProductPage } from './types';

/** Public catalog calls need no login. Orders need the buyer's Keycloak token. */
export class StoreApi {
  constructor(private baseUrl: string = config.storeApiUrl, private getToken?: TokenProvider) {}

  private async pub<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Store request failed (${res.status})`);
    return res.json() as Promise<T>;
  }
  private auth<T>(path: string, init?: RequestInit) {
    if (!this.getToken) throw new Error('Sign in first');
    return request<T>(`${this.baseUrl}${path}`, this.getToken, init);
  }

  categories() { return this.pub<Category[]>('/categories'); }
  products(params: { search?: string; category?: string; store?: string; page?: number } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    return this.pub<ProductPage>(`/products?${q}`);
  }
  hot() { return this.pub<Product[]>('/products/hot'); }

  /** Checkout: prices come from the store's database. The answer carries `payment.intentId` to confirm in the wallet. */
  createOrder(input: CreateOrderInput) { return this.auth<Order>('/orders', { method: 'POST', body: JSON.stringify(input) }); }
  myOrders() { return this.auth<Order[]>('/orders'); }
  /** Selling: apply for a store (it starts `pending`; a platform admin approves it), and look at your own. */
  myStore() { return this.auth<{ store: MyStore | null }>('/me/store'); }
  applyForStore(input: { name: string; description?: string }) { return this.auth<MyStore>('/stores', { method: 'POST', body: JSON.stringify(input) }); }
  cancelOrder(id: string) { return this.auth<Order>(`/orders/${id}/cancel`, { method: 'POST' }); }
}

/** Server-side fetch for catalog pages (SSR). Uses STORE_API_URL so the browser-facing URL can differ. */
export async function serverGet<T>(path: string): Promise<T | null> {
  const base = process.env.STORE_API_URL ?? config.storeApiUrl;
  try {
    const res = await fetch(`${base}${path}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;   // store backend unreachable: pages show a friendly message
  }
}
