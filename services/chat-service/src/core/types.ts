export type UserId = string;
export type RoomId = string;

/** Who the caller is, as proven by the token. Produced by a TokenVerifier. */
export interface Identity {
  userId: UserId;
  username: string;
  displayName: string;
}

/** Projection of a user's store, fed by `store.*` events from the ecommerce side. */
export interface StoreRef {
  id: string;
  name: string;
  slug: string;
}

export interface UserProfile {
  id: UserId;
  username: string;
  displayName: string;
  lastSeenAt: string;
  store: StoreRef | null;
}

export type RoomKind = 'direct' | 'group';
export type Visibility = 'public' | 'private';
export type MemberRole = 'owner' | 'admin' | 'member';

export interface RoomMember {
  userId: UserId;
  role: MemberRole;
}

export interface Room {
  id: RoomId;
  kind: RoomKind;
  name: string | null;
  visibility: Visibility;
  createdBy: UserId;
  createdAt: string;
  /** Only for direct rooms: the two user ids sorted and joined, to guarantee one DM per pair. */
  directKey?: string;
  /** In join order. */
  members: RoomMember[];
}

/** Viewer-independent description of a room (safe to broadcast to every member). */
export interface RoomSummary {
  id: RoomId;
  kind: RoomKind;
  name: string | null;
  visibility: Visibility;
  createdBy: UserId;
  createdAt: string;
  memberIds: UserId[];
  roles: Record<UserId, MemberRole>;
  members: UserProfile[];
}

/** What one user sees in their room list. */
export interface RoomView extends RoomSummary {
  unreadCount: number;
  mentionCount: number;
  lastMessage: Message | null;
}

export type MessageKind = 'text' | 'payment' | 'order';

export interface PaymentPayload {
  transferId: string;
  /** The confirmed transfer intent this payment came from. */
  intentId: string | null;
  fromUserId: UserId;
  toUserId: UserId;
  amountMinor: number;
  currency: string;
  note: string | null;
  status: 'completed';
}

export interface OrderItemSnapshot { name: string; quantity: number; unitPriceMinor: number; imageUrl: string | null }

/** Snapshot of a paid order shown as a chat bubble (the order itself lives in the store backend). */
export interface OrderPayload {
  orderId: string;
  storeId: string;
  storeName: string;
  buyerId: UserId;
  recipientId: UserId;
  totalMinor: number;
  currency: string;
  items: OrderItemSnapshot[];
}

export interface Message {
  id: string;
  /** Strictly increasing across all rooms. Used as the history cursor and for read state. */
  seq: number;
  roomId: RoomId;
  senderId: UserId;
  kind: MessageKind;
  text: string | null;
  payment: PaymentPayload | null;
  order: OrderPayload | null;
  mentions: UserId[];
  createdAt: string;
}

export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

export interface Invite {
  id: string;
  roomId: RoomId;
  inviteeId: UserId;
  inviterId: UserId;
  status: InviteStatus;
  createdAt: string;
}

export interface InviteView {
  id: string;
  status: InviteStatus;
  createdAt: string;
  room: { id: RoomId; name: string | null; visibility: Visibility; memberCount: number };
  inviter: UserProfile | null;
}

/** `transfer.completed` from the wallet (v1). Unknown extra fields are ignored. */
export interface TransferCompletedEvent {
  version?: number;
  transferId: string;
  intentId?: string | null;
  /** P2P for person-to-person payments; ORDER_PAYMENT for ecommerce (not a chat concern). */
  kind?: string | null;
  fromUserId: UserId;
  toUserId: UserId;
  amountMinor: number;
  currency: string;
  note?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  occurredAt?: string;
}

/** `order.paid` from the store backend. Only gift orders placed from a chat produce a bubble. */
export interface OrderPaidEvent {
  version?: number;
  orderId: string;
  storeId: string;
  storeName: string;
  buyerUserId: UserId;
  recipientUserId?: UserId | null;
  totalMinor: number;
  currency: string;
  items: OrderItemSnapshot[];
  context?: { type: string; roomId: string } | null;
  occurredAt?: string;
}

/** `store.opened` / `store.closed` from the ecommerce side. */
export interface StoreOpenedEvent { ownerUserId: UserId; storeId: string; name: string; slug: string }
export interface StoreClosedEvent { ownerUserId: UserId; storeId: string }

export type ChatEvent =
  | { type: 'message:new'; message: Message; memberIds: UserId[] }
  | { type: 'mention'; message: Message; userIds: UserId[]; roomName: string | null; sender: UserProfile | null }
  | { type: 'room:new'; room: RoomSummary; userIds: UserId[] }
  | { type: 'room:updated'; room: RoomSummary }
  | { type: 'invite:new'; invite: InviteView; userId: UserId }
  | { type: 'room:read'; userId: UserId; roomId: RoomId }
  | { type: 'typing'; roomId: RoomId; userId: UserId; memberIds: UserId[] };
