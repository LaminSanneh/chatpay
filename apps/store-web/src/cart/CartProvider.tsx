'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Product } from '@/core/types';

export interface CartLine {
  productId: number; slug: string; name: string; priceMinor: number; currency: string;
  imageUrl: string | null; storeId: number; storeName: string; quantity: number;
}

interface CartState {
  lines: CartLine[];
  count: number;
  add: (p: Product, quantity?: number) => void;
  setQuantity: (productId: number, quantity: number) => void;
  remove: (productId: number) => void;
  clearStore: (storeId: number) => void;
}

const KEY = 'storeweb.cart.v1';
const Ctx = createContext<CartState | null>(null);
export function useCart(): CartState {
  const c = useContext(Ctx);
  if (!c) throw new Error('CartProvider is missing');
  return c;
}

/** The cart lives in the browser, so anonymous shoppers can fill it. Prices shown here are only a preview:
 *  the order is priced by the store backend at checkout. */
export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try { setLines(JSON.parse(localStorage.getItem(KEY) ?? '[]')); } catch { /* ignore */ }
    setLoaded(true);
  }, []);
  useEffect(() => { if (loaded) try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* ignore */ } }, [lines, loaded]);

  const add = useCallback((p: Product, quantity = 1) => {
    if (!p.store) return;
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === p.id);
      if (existing) return prev.map((l) => (l.productId === p.id ? { ...l, quantity: Math.min(l.quantity + quantity, 99) } : l));
      return [...prev, {
        productId: p.id, slug: p.slug, name: p.name, priceMinor: p.priceMinor, currency: p.currency, imageUrl: p.imageUrl,
        storeId: p.store!.id, storeName: p.store!.name, quantity,
      }];
    });
  }, []);
  const setQuantity = useCallback((id: number, q: number) =>
    setLines((prev) => prev.map((l) => (l.productId === id ? { ...l, quantity: Math.max(1, Math.min(q, 99)) } : l))), []);
  const remove = useCallback((id: number) => setLines((prev) => prev.filter((l) => l.productId !== id)), []);
  const clearStore = useCallback((storeId: number) => setLines((prev) => prev.filter((l) => l.storeId !== storeId)), []);

  const value = useMemo(() => ({
    lines, count: lines.reduce((n, l) => n + l.quantity, 0), add, setQuantity, remove, clearStore,
  }), [lines, add, setQuantity, remove, clearStore]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
