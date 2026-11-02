import Link from 'next/link';
import { serverGet } from '@/core/storeApi';
import type { Category, ProductPage } from '@/core/types';
import { ProductCard } from '@/ui/ProductCard';

export default async function Products({ searchParams }: { searchParams: Promise<{ search?: string; category?: string; page?: string }> }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  if (sp.search) q.set('search', sp.search);
  if (sp.category) q.set('category', sp.category);
  if (sp.page) q.set('page', sp.page);
  const [data, categories] = await Promise.all([serverGet<ProductPage>(`/products?${q}`), serverGet<Category[]>('/categories')]);
  if (!data) return <p className="muted">The store is temporarily unavailable. Please try again shortly.</p>;

  const page = data.page;
  const pages = Math.max(1, Math.ceil(data.total / data.perPage));
  const link = (p: number) => `/products?${new URLSearchParams({ ...(sp.search ? { search: sp.search } : {}), ...(sp.category ? { category: sp.category } : {}), page: String(p) })}`;

  return (
    <>
      <form method="get" action="/products" className="search">
        <input name="search" defaultValue={sp.search ?? ''} placeholder="Search products…" />
        {sp.category && <input type="hidden" name="category" value={sp.category} />}
        <button className="primary" type="submit">Search</button>
      </form>
      <div className="chips">
        <Link href="/products" className={`chip ${!sp.category ? 'on' : ''}`}>All</Link>
        {categories?.map((c) => <Link key={c.id} href={`/products?category=${c.slug}`} className={`chip ${sp.category === c.slug ? 'on' : ''}`}>{c.name}</Link>)}
      </div>
      <div className="grid">{data.items.map((p) => <ProductCard key={p.id} product={p} />)}</div>
      {data.items.length === 0 && <p className="muted">Nothing found.</p>}
      {pages > 1 && (
        <div className="pager">
          {page > 1 && <Link href={link(page - 1)}>← Previous</Link>}
          <span>Page {page} of {pages}</span>
          {page < pages && <Link href={link(page + 1)}>Next →</Link>}
        </div>
      )}
    </>
  );
}
