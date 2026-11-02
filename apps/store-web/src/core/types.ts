export interface StoreRef { id: number; name: string; slug: string }
export interface Category { id: number; name: string; slug: string }

export interface Product {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  stock: number;
  imageUrl: string | null;
  isHot: boolean;
  category: Category | null;
  store: StoreRef | null;
}

export interface ProductPage { items: Product[]; page: number; perPage: number; total: number }

export interface OrderItem { productId: number | null; name: string; quantity: number; unitPriceMinor: number; imageUrl: string | null }

export interface Order {
  id: string;
  status: 'pending_payment' | 'paid' | 'shipped' | 'delivered' | 'completed' | 'cancelled' | 'refunded' | 'payment_review';
  totalMinor: number;
  currency: string;
  store: StoreRef;
  items: OrderItem[];
  buyerUserId: string;
  giftFor: string | null;
  chatContext: { type: string; roomId: string } | null;
  payment: { intentId: string | null; expiresAt: string | null };
  createdAt: string;
  paidAt: string | null;
}

export interface CreateOrderInput {
  items: { productId: number; quantity: number }[];
  giftFor?: string;
  context?: { type: 'chat'; roomId: string };
}

export type IntentStatus = 'CREATED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

/** The wallet's payment attempt. The server is the only source of truth about whether it was paid. */
export interface TransferIntent {
  id: string;
  kind: 'P2P' | 'ORDER';
  status: IntentStatus;
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
  currency: string;
  note: string | null;
  referenceType: string | null;
  referenceId: string | null;
  transferId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface MyStore { id: number; name: string; slug: string; description: string | null; status: 'pending' | 'active' | 'suspended' | 'closed' }
