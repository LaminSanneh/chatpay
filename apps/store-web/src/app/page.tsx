import Link from 'next/link';
import { serverGet } from '@/core/storeApi';
import type { Category, Product } from '@/core/types';
import { ProductCard } from '@/ui/ProductCard';

export default async function Home() {
  const [hot, categories] = await Promise.all([serverGet<Product[]>('/products/hot'), serverGet<Category[]>('/categories')]);
  if (!hot) return <p className="muted">The store is temporarily unavailable. Please try again shortly.</p>;
  return (
    <>
      <section className="hero"><h1>Shop, then chat about it.</h1><p>Anyone can browse. Sign in to order.</p></section>
      {categories && categories.length > 0 && (
        <div className="chips">{categories.map((c) => <Link key={c.id} href={`/products?category=${c.slug}`} className="chip">{c.name}</Link>)}</div>
      )}
      <h2>Hot right now</h2>
      <div className="grid">{hot.map((p) => <ProductCard key={p.id} product={p} />)}</div>
      {hot.length === 0 && <p className="muted">No products yet.</p>}
    </>
  );
}
