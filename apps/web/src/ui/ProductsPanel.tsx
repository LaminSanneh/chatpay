'use client';
import { useEffect, useState } from 'react';
import { config } from '@/core/config';
import { formatMinor } from '@/core/money';
import type { StoreApi } from '@/core/storeApi';
import type { Product } from '@/core/types';

/** Search the store and buy without leaving the chat: for yourself, or as a gift for the person in this 1:1 chat. */
export function ProductsPanel({ api, giftTo, onBuy, onClose }: {
  api: StoreApi;
  /** The other person in a 1:1 chat, if any. */
  giftTo?: { id: string; name: string };
  onBuy: (product: Product, forUserId?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [hot, setHot] = useState<Product[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Product[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.hot().then(setHot).catch(() => setUnavailable(true)); }, [api]);

  useEffect(() => {
    if (!query.trim()) { setResults(null); return; }
    const t = setTimeout(() => {
      api.search(query.trim()).then((p) => setResults(p.items)).catch(() => setUnavailable(true));
    }, 300);
    return () => clearTimeout(t);
  }, [query, api]);

  async function buy(product: Product, forUserId?: string) {
    setBusyId(`${product.id}:${forUserId ?? 'me'}`); setError(null);
    try { await onBuy(product, forUserId); } catch (e) { setError((e as Error).message); } finally { setBusyId(null); }
  }

  const list = results ?? hot;
  return (
    <aside className="shop-panel">
      <div className="shop-head">
        <strong>Shop</strong>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      <input placeholder="Search products…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <a className="link" href={config.storeUrl} target="_blank" rel="noreferrer">Open the full store ↗</a>
      {unavailable && <p className="muted">The store is not reachable right now.</p>}
      {error && <p className="error">{error}</p>}
      {!unavailable && <div className="section">{results ? 'Results' : 'Hot right now'}</div>}
      {list?.map((p) => (
        <div key={p.id} className="product-row">
          <div className="product-thumb">{p.imageUrl ? <img src={p.imageUrl} alt="" /> : p.name[0]}</div>
          <div className="product-info">
            <div className="product-name">{p.name}</div>
            <div className="muted">{p.store?.name} · {formatMinor(p.priceMinor, p.currency)}</div>
            <div className="product-buttons">
              <button disabled={p.stock === 0 || busyId !== null} onClick={() => void buy(p)}>
                {busyId === `${p.id}:me` ? '…' : 'Buy for me'}
              </button>
              {giftTo && (
                <button disabled={p.stock === 0 || busyId !== null} onClick={() => void buy(p, giftTo.id)}>
                  {busyId === `${p.id}:${giftTo.id}` ? '…' : `Buy for ${giftTo.name}`}
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
      {list?.length === 0 && <p className="muted">Nothing found.</p>}
    </aside>
  );
}
