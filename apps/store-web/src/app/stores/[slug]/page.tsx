import { notFound } from 'next/navigation';
import { serverGet } from '@/core/storeApi';
import type { Product } from '@/core/types';
import { ProductCard } from '@/ui/ProductCard';

interface StorePage { id: number; name: string; slug: string; description: string | null; products: Product[] }

export default async function Store({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const store = await serverGet<StorePage>(`/stores/${slug}`);
  if (!store) notFound();
  return (
    <>
      <h1>{store.name}</h1>
      <p className="muted">{store.description}</p>
      <div className="grid">{store.products.map((p) => <ProductCard key={p.id} product={p} />)}</div>
    </>
  );
}
