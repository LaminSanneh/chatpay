'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAccessToken } from '@/core/auth';
import { config } from '@/core/config';
import { formatMinor } from '@/core/money';
import { StoreApi } from '@/core/storeApi';
import type { Order } from '@/core/types';
import { WalletApi } from '@/core/walletApi';
import { useAuth } from '@/ui/AuthProvider';
import { PayOrderDialog } from '@/ui/PayOrderDialog';

const LABEL: Record<Order['status'], string> = {
  pending_payment: 'Waiting for payment', paid: 'Paid', shipped: 'Shipped', delivered: 'Delivered',
  completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded', payment_review: 'Under review',
};

export default function OrdersPage() {
  const { user, ready, login } = useAuth();
  const storeApi = useMemo(() => new StoreApi(config.storeApiUrl, getAccessToken), []);
  const walletApi = useMemo(() => new WalletApi(config.walletUrl, getAccessToken), []);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState<Order | null>(null);

  const load = useCallback(() => storeApi.myOrders().then((o) => { setOrders(o); setError(null); }).catch((e: Error) => setError(e.message)), [storeApi]);
  useEffect(() => { if (user) void load(); }, [user, load]);

  // A payment becomes "paid" a moment later, when the store backend receives the wallet's event: keep refreshing while it matters.
  const moving = orders?.some((o) => o.status === 'pending_payment' || o.status === 'paid' || o.status === 'shipped');
  useEffect(() => {
    if (!user || !moving) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [user, moving, load]);

  if (!ready) return null;
  if (!user) return <><h1>My orders</h1><p>Please <button className="link" onClick={login}>sign in</button> to see your orders.</p></>;

  return (
    <>
      <h1>My orders</h1>
      {error && <p className="error">{error}</p>}
      {orders?.length === 0 && <p className="muted">No orders yet.</p>}
      {orders?.map((o) => (
        <section key={o.id} className="cart-group">
          <div className="order-head">
            <strong>{o.store.name}</strong>
            <span className={`status ${o.status}`}>{LABEL[o.status]}</span>
          </div>
          <div className="muted">{new Date(o.createdAt).toLocaleString()} · Order {o.id.slice(0, 8)}{o.giftFor ? ' · gift' : ''}</div>
          <ul>{o.items.map((i, n) => <li key={n}>{i.quantity} × {i.name} <span className="muted">{formatMinor(i.unitPriceMinor, o.currency)}</span></li>)}</ul>
          <div className="cart-total">
            <strong>{formatMinor(o.totalMinor, o.currency)}</strong>
            {o.status === 'pending_payment' && o.payment.intentId && <button className="primary" onClick={() => setPaying(o)}>Pay now</button>}
          </div>
        </section>
      ))}

      {paying?.payment.intentId && (
        <PayOrderDialog
          api={walletApi}
          intentId={paying.payment.intentId}
          title={`Pay ${paying.store.name}`}
          details={<div className="muted">{paying.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</div>}
          onPaid={() => { setPaying(null); void load(); }}
          onCancelled={() => { void storeApi.cancelOrder(paying.id).then(load).catch(() => undefined); }}
          onClose={() => setPaying(null)}
        />
      )}
    </>
  );
}
