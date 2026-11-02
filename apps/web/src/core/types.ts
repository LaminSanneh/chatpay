// Mirrors services/chat-service/src/core/types.ts and the wallet API. Later: move into a shared `packages/contracts`.
export interface StoreRef { id: string; name: string; slug: string }
export interface UserProfile { id: string; username: string; displayName: string; lastSeenAt: string; store: StoreRef | null }

export type Visibility = 'public' | 'private';
export type MemberRole = 'owner' | 'admin' | 'member';

export interface RoomSummary {
  id: string;
  kind: 'direct' | 'group';
  name: string | null;
  visibility: Visibility;
  createdBy: string;
  createdAt: string;
  memberIds: string[];
  roles: Record<string, MemberRole>;
  members: UserProfile[];
}

export interface RoomView extends RoomSummary {
  unreadCount: number;
  mentionCount: number;
  lastMessage: Message | null;
}

export interface PaymentPayload {
  transferId: string;
  intentId: string | null;
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
  currency: string;
  note: string | null;
  status: 'completed';
}

export interface OrderBubbleItem { name: string; quantity: number; unitPriceMinor: number; imageUrl: string | null }

/** Snapshot of a paid gift order shown as a chat bubble (the order itself lives in the store backend). */
export interface OrderPayload {
  orderId: string;
  storeId: string;
  storeName: string;
  buyerId: string;
  recipientId: string;
  totalMinor: number;
  currency: string;
  items: OrderBubbleItem[];
}

export interface Message {
  id: string;
  seq: number;
  roomId: string;
  senderId: string;
  kind: 'text' | 'payment' | 'order';
  text: string | null;
  payment: PaymentPayload | null;
  order: OrderPayload | null;
  mentions: string[];
  createdAt: string;
}

export interface InviteView {
  id: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  createdAt: string;
  room: { id: string; name: string | null; visibility: Visibility; memberCount: number };
  inviter: UserProfile | null;
}

export interface Wallet { accountId: string; userId: string; currency: string; balanceMinor: number }

export type IntentStatus = 'CREATED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

/** A server-side payment attempt. The server is the only source of truth about whether it was paid. */
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

/** One line of the wallet statement (a ledger entry from this wallet's point of view). */
export interface LedgerEntry {
  id: string;
  seq: number;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: number;
  currency: string;
  kind: string;
  description: string | null;
  referenceType: string | null;
  referenceId: string | null;
  balanceAfter: number | null;
  createdAt: string;
}

export interface EntriesPage { items: LedgerEntry[]; nextBefore: number | null }

// ---- store (ecommerce) types, used by the in-chat shop ----
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
  store: { id: number; name: string; slug: string } | null;
}

export interface ProductPage { items: Product[]; page: number; perPage: number; total: number }

export interface StoreOrder {
  id: string;
  status: string;
  totalMinor: number;
  currency: string;
  store: { id: number; name: string; slug: string };
  items: { productId: number | null; name: string; quantity: number; unitPriceMinor: number; imageUrl: string | null }[];
  giftFor: string | null;
  payment: { intentId: string | null; expiresAt: string | null };
}

export interface CreateOrderInput {
  items: { productId: number; quantity: number }[];
  giftFor?: string;
  context?: { type: 'chat'; roomId: string };
}
