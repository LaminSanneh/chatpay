import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatMinor } from '@/core/money';
import { serverGet } from '@/core/storeApi';
import type { Product } from '@/core/types';
import { AddToCart } from '@/ui/AddToCart';

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await serverGet<Product>(`/products/${slug}`);
  if (!product) notFound();
  return (
    <div className="detail">
      <div className="thumb big">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} /> : <span>{product.name[0]}</span>}</div>
      <div>
        <h1>{product.name}</h1>
        {product.store && <p className="muted">Sold by <Link href={`/stores/${product.store.slug}`}>{product.store.name}</Link></p>}
        <div className="price big">{formatMinor(product.priceMinor, product.currency)}</div>
        <p>{product.description}</p>
        <p className="muted">{product.stock > 0 ? `${product.stock} in stock` : 'Sold out'}</p>
        <AddToCart product={product} />
      </div>
    </div>
  );
}
