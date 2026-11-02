'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { type CartLine, useCart } from '@/cart/CartProvider';
import { getAccessToken } from '@/core/auth';
import { config } from '@/core/config';
import { formatMinor } from '@/core/money';
import { StoreApi } from '@/core/storeApi';
import type { Order } from '@/core/types';
import { WalletApi } from '@/core/walletApi';
import { useAuth } from '@/ui/AuthProvider';
import { PayOrderDialog } from '@/ui/PayOrderDialog';

export default function CartPage() {
  const router = useRouter();
  const { lines, setQuantity, remove, clearStore } = useCart();
  const { user, ready, login } = useAuth();
  const storeApi = useMemo(() => new StoreApi(config.storeApiUrl, getAccessToken), []);
  const walletApi = useMemo(() => new WalletApi(config.walletUrl, getAccessToken), []);

  const [paying, setPaying] = useState<{ order: Order; storeId: number } | null>(null);
  const [busyStore, setBusyStore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One order per store: a cart with products from two stores becomes two orders, paid one after the other.
  const groups = useMemo(() => {
    const byStore = new Map<number, CartLine[]>();
    for (const l of lines) byStore.set(l.storeId, [...(byStore.get(l.storeId) ?? []), l]);
    return [...byStore.entries()];
  }, [lines]);

  async function checkout(storeId: number, storeLines: CartLine[]) {
    if (!user) return login();
    setBusyStore(storeId); setError(null);
    try {
      const order = await storeApi.createOrder({ items: storeLines.map((l) => ({ productId: l.productId, quantity: l.quantity })) });
      setPaying({ order, storeId });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusyStore(null); }
  }

  if (lines.length === 0) return <><h1>Your cart</h1><p className="muted">Your cart is empty. <Link href="/products">Browse products</Link></p></>;

  return (
    <>
      <h1>Your cart</h1>
      {!ready ? null : !user && <p className="notice">You can fill your cart without an account. Sign in when you are ready to order.</p>}
      {error && <p className="error">{error}</p>}

      {groups.map(([storeId, storeLines]) => {
        const total = storeLines.reduce((n, l) => n + l.priceMinor * l.quantity, 0);
        return (
          <section key={storeId} className="cart-group">
            <h3>{storeLines[0].storeName}</h3>
            {storeLines.map((l) => (
              <div key={l.productId} className="cart-line">
                <Link href={`/products/${l.slug}`}>{l.name}</Link>
                <input type="number" min={1} max={99} value={l.quantity} onChange={(e) => setQuantity(l.productId, Number(e.target.value) || 1)} />
                <span>{formatMinor(l.priceMinor * l.quantity, l.currency)}</span>
                <button onClick={() => remove(l.productId)}>Remove</button>
              </div>
            ))}
            <div className="cart-total">
              <strong>Total {formatMinor(total, storeLines[0].currency)}</strong>
              <button className="primary" disabled={busyStore === storeId} onClick={() => void checkout(storeId, storeLines)}>
                {user ? (busyStore === storeId ? 'Creating order…' : 'Checkout') : 'Sign in to checkout'}
              </button>
            </div>
            <p className="muted">The final price is set by the store when you check out.</p>
          </section>
        );
      })}

      {paying && paying.order.payment.intentId && (
        <PayOrderDialog
          api={walletApi}
          intentId={paying.order.payment.intentId}
          title={`Pay ${paying.order.store.name}`}
          details={<div className="muted">{paying.order.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</div>}
          onPaid={() => { clearStore(paying.storeId); setPaying(null); router.push('/orders'); }}
          onCancelled={() => { void storeApi.cancelOrder(paying.order.id).catch(() => undefined); }}
          onClose={() => setPaying(null)}
        />
      )}
    </>
  );
}
