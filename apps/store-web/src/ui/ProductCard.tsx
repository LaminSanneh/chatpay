import Link from 'next/link';
import { formatMinor } from '@/core/money';
import type { Product } from '@/core/types';

export function ProductCard({ product }: { product: Product }) {
  return (
    <Link href={`/products/${product.slug}`} className="card">
      <div className="thumb">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} /> : <span>{product.name[0]}</span>}</div>
      <div className="card-body">
        <div className="card-title">{product.name}</div>
        <div className="muted">{product.store?.name}</div>
        <div className="price">{formatMinor(product.priceMinor, product.currency)}</div>
        {product.stock === 0 && <div className="error">Sold out</div>}
      </div>
    </Link>
  );
}
