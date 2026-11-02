import type {
  Identity, Invite, InviteStatus, MemberRole, Message, Room, RoomId, RoomKind, RoomMember, StoreRef, UserId,
  UserProfile, Visibility,
} from './types';

/**
 * PORTS: the only things the chat core needs from the outside world.
 * Shipped adapters: in-memory (tests, quick dev) and Postgres. Write your own for any other store.
 */
export interface UserRepository {
  upsert(identity: Identity): Promise<UserProfile>;
  get(id: UserId): Promise<UserProfile | null>;
  getMany(ids: UserId[]): Promise<UserProfile[]>;
  search(query: string, limit: number, excludeId?: UserId): Promise<UserProfile[]>;
  /** Pass null to clear. Works even if the user has never opened the chat. */
  setStore(userId: UserId, store: StoreRef | null): Promise<void>;
}

export interface NewRoom {
  kind: RoomKind;
  name: string | null;
  visibility: Visibility;
  createdBy: UserId;
  directKey?: string;
  members: RoomMember[];
}

export interface RoomRepository {
  create(room: NewRoom): Promise<Room>;
  get(id: RoomId): Promise<Room | null>;
  findDirect(directKey: string): Promise<Room | null>;
  listForUser(userId: UserId): Promise<Room[]>;
  listPublicGroups(query: string, limit: number): Promise<Room[]>;
  addMember(roomId: RoomId, member: RoomMember): Promise<Room>;
  removeMember(roomId: RoomId, userId: UserId): Promise<Room>;
  setRole(roomId: RoomId, userId: UserId, role: MemberRole): Promise<Room>;
  /** Read cursors (message seq) of every room the user is in. Missing = 0. */
  readCursors(userId: UserId): Promise<Map<RoomId, number>>;
  /** Never moves a cursor backwards. */
  setReadCursor(roomId: RoomId, userId: UserId, seq: number): Promise<void>;
}

export type NewMessage = Omit<Message, 'id' | 'seq' | 'createdAt'>;

export interface MessageRepository {
  append(message: NewMessage): Promise<Message>;
  /** Oldest -> newest. `before` is a message seq cursor. */
  list(roomId: RoomId, opts: { before?: number; limit: number }): Promise<Message[]>;
  findByTransferId(transferId: string): Promise<Message | null>;
  findByOrderId(orderId: string): Promise<Message | null>;
  lastMessages(roomIds: RoomId[]): Promise<Map<RoomId, Message>>;
  latestSeq(roomId: RoomId): Promise<number>;
  /** Per room: messages after the cursor that were not sent by the user, and how many of them mention the user. */
  unreadBatch(userId: UserId, cursors: Map<RoomId, number>): Promise<Map<RoomId, { unread: number; mentions: number }>>;
}

export interface InviteRepository {
  /** Idempotent: returns the existing pending invite for the same room + invitee. */
  create(roomId: RoomId, inviteeId: UserId, inviterId: UserId): Promise<Invite>;
  get(id: string): Promise<Invite | null>;
  listPendingFor(userId: UserId): Promise<Invite[]>;
  setStatus(id: string, status: InviteStatus): Promise<Invite>;
}

/** Verifies a bearer token and says who it belongs to. Swap Keycloak for anything else here. */
export interface TokenVerifier {
  verify(token: string): Promise<Identity>;
}
