'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAccessToken } from '@/core/auth';
import { config } from '@/core/config';
import { StoreApi } from '@/core/storeApi';
import type { MyStore } from '@/core/types';
import { useAuth } from '@/ui/AuthProvider';

/** Apply to open a store. An admin approves it in the back office; only then does it appear to shoppers and in chat. */
export default function SellPage() {
  const { user, ready, login } = useAuth();
  const api = useMemo(() => new StoreApi(config.storeApiUrl, getAccessToken), []);
  const [store, setStore] = useState<MyStore | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.myStore().then((r) => setStore(r.store)).catch((e: Error) => { setError(e.message); setStore(null); }), [api]);
  useEffect(() => { if (user) void load(); }, [user, load]);

  async function apply() {
    setBusy(true); setError(null);
    try { setStore(await api.applyForStore({ name: name.trim(), description: description.trim() || undefined })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!ready) return null;
  if (!user) return <><h1>Sell on ChatPay</h1><p>Please <button className="link" onClick={login}>sign in</button> to open a store.</p></>;
  if (store === undefined) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>Sell on ChatPay</h1>
      {error && <p className="error">{error}</p>}

      {store === null && (
        <section className="cart-group form">
          <p>Tell us about your store. A platform admin reviews every application.</p>
          <input placeholder="Store name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          <textarea placeholder="What do you sell? (optional)" maxLength={500} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          <button className="primary" disabled={busy || name.trim().length < 3} onClick={() => void apply()}>{busy ? 'Sending…' : 'Apply for a store'}</button>
        </section>
      )}

      {store?.status === 'pending' && <section className="cart-group"><strong>{store.name}</strong><p className="notice">Your application is waiting for approval. Check back soon.</p></section>}
      {store?.status === 'active' && (
        <section className="cart-group">
          <strong>{store.name}</strong>
          <p>Your store is open. Manage products and orders in your back office.</p>
          <a className="chip on" href={`${config.backOfficeUrl}/vendor`} target="_blank" rel="noreferrer">Open my back office ↗</a>
        </section>
      )}
      {(store?.status === 'suspended' || store?.status === 'closed') && <section className="cart-group"><strong>{store.name}</strong><p className="error">This store is {store.status}. Contact the platform team.</p></section>}
    </>
  );
}
