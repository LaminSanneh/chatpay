'use client';
import { useState } from 'react';
import { useCart } from '@/cart/CartProvider';
import type { Product } from '@/core/types';

export function AddToCart({ product }: { product: Product }) {
  const { add } = useCart();
  const [added, setAdded] = useState(false);
  return (
    <button className="primary" disabled={product.stock === 0} onClick={() => { add(product); setAdded(true); setTimeout(() => setAdded(false), 1500); }}>
      {product.stock === 0 ? 'Sold out' : added ? 'Added ✓' : 'Add to cart'}
    </button>
  );
}
