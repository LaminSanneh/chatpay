import { randomUUID } from 'node:crypto';
import type {
  InviteRepository, MessageRepository, NewMessage, NewRoom, RoomRepository, UserRepository,
} from '../core/ports';
import type {
  Identity, Invite, InviteStatus, MemberRole, Message, Room, RoomId, RoomMember, StoreRef, UserId, UserProfile,
} from '../core/types';

/** Default adapters for tests and quick dev: zero infrastructure, data is lost on restart. */

export class InMemoryUserRepository implements UserRepository {
  private users = new Map<UserId, Omit<UserProfile, 'store'>>();
  private stores = new Map<UserId, StoreRef>();

  private view(u: Omit<UserProfile, 'store'>): UserProfile { return { ...u, store: this.stores.get(u.id) ?? null }; }

  async upsert(i: Identity) {
    const profile = { id: i.userId, username: i.username, displayName: i.displayName, lastSeenAt: new Date().toISOString() };
    this.users.set(i.userId, profile);
    return this.view(profile);
  }
  async get(id: UserId) { const u = this.users.get(id); return u ? this.view(u) : null; }
  async getMany(ids: UserId[]) { return ids.map((id) => this.users.get(id)).filter((u) => !!u).map((u) => this.view(u!)); }
  async search(query: string, limit: number, excludeId?: UserId) {
    const q = query.trim().toLowerCase();
    return [...this.users.values()]
      .filter((u) => u.id !== excludeId && (!q || u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)))
      .slice(0, limit).map((u) => this.view(u));
  }
  async setStore(userId: UserId, store: StoreRef | null) {
    if (store) this.stores.set(userId, store); else this.stores.delete(userId);
  }
}

export class InMemoryRoomRepository implements RoomRepository {
  private rooms = new Map<RoomId, Room>();
  private cursors = new Map<string, number>();   // `${roomId}|${userId}` -> seq

  private copy(r: Room): Room { return { ...r, members: r.members.map((m) => ({ ...m })) }; }
  private must(id: RoomId): Room { const r = this.rooms.get(id); if (!r) throw new Error('room not found'); return r; }

  async create(input: NewRoom) {
    const room: Room = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), members: input.members.map((m) => ({ ...m })) };
    this.rooms.set(room.id, room);
    return this.copy(room);
  }
  async get(id: RoomId) { const r = this.rooms.get(id); return r ? this.copy(r) : null; }
  async findDirect(directKey: string) {
    const r = [...this.rooms.values()].find((x) => x.directKey === directKey);
    return r ? this.copy(r) : null;
  }
  async listForUser(userId: UserId) {
    return [...this.rooms.values()].filter((r) => r.members.some((m) => m.userId === userId)).map((r) => this.copy(r));
  }
  async listPublicGroups(query: string, limit: number) {
    const q = query.toLowerCase();
    return [...this.rooms.values()]
      .filter((r) => r.kind === 'group' && r.visibility === 'public' && (!q || (r.name ?? '').toLowerCase().includes(q)))
      .slice(0, limit).map((r) => this.copy(r));
  }
  async addMember(roomId: RoomId, member: RoomMember) {
    const room = this.must(roomId);
    if (!room.members.some((m) => m.userId === member.userId)) room.members.push({ ...member });
    return this.copy(room);
  }
  async removeMember(roomId: RoomId, userId: UserId) {
    const room = this.must(roomId);
    room.members = room.members.filter((m) => m.userId !== userId);
    this.cursors.delete(`${roomId}|${userId}`);
    return this.copy(room);
  }
  async setRole(roomId: RoomId, userId: UserId, role: MemberRole) {
    const room = this.must(roomId);
    const m = room.members.find((x) => x.userId === userId);
    if (m) m.role = role;
    return this.copy(room);
  }
  async readCursors(userId: UserId) {
    const out = new Map<RoomId, number>();
    for (const r of this.rooms.values()) {
      if (r.members.some((m) => m.userId === userId)) out.set(r.id, this.cursors.get(`${r.id}|${userId}`) ?? 0);
    }
    return out;
  }
  async setReadCursor(roomId: RoomId, userId: UserId, seq: number) {
    const key = `${roomId}|${userId}`;
    this.cursors.set(key, Math.max(this.cursors.get(key) ?? 0, seq));
  }
}

export class InMemoryMessageRepository implements MessageRepository {
  private byRoom = new Map<RoomId, Message[]>();
  private byTransfer = new Map<string, Message>();
  private byOrder = new Map<string, Message>();
  private seq = 0;

  async append(input: NewMessage) {
    const message: Message = { ...input, id: randomUUID(), seq: ++this.seq, createdAt: new Date().toISOString() };
    const list = this.byRoom.get(input.roomId) ?? [];
    list.push(message);
    this.byRoom.set(input.roomId, list);
    if (message.payment) this.byTransfer.set(message.payment.transferId, message);
    if (message.order) this.byOrder.set(message.order.orderId, message);
    return message;
  }
  async list(roomId: RoomId, opts: { before?: number; limit: number }) {
    const all = this.byRoom.get(roomId) ?? [];
    const filtered = opts.before !== undefined ? all.filter((m) => m.seq < opts.before!) : all;
    return filtered.slice(-opts.limit);
  }
  async findByTransferId(transferId: string) { return this.byTransfer.get(transferId) ?? null; }
  async findByOrderId(orderId: string) { return this.byOrder.get(orderId) ?? null; }
  async lastMessages(roomIds: RoomId[]) {
    const out = new Map<RoomId, Message>();
    for (const id of roomIds) { const l = this.byRoom.get(id); if (l?.length) out.set(id, l[l.length - 1]); }
    return out;
  }
  async latestSeq(roomId: RoomId) { const l = this.byRoom.get(roomId); return l?.length ? l[l.length - 1].seq : 0; }
  async unreadBatch(userId: UserId, cursors: Map<RoomId, number>) {
    const out = new Map<RoomId, { unread: number; mentions: number }>();
    for (const [roomId, after] of cursors) {
      const msgs = (this.byRoom.get(roomId) ?? []).filter((m) => m.seq > after && m.senderId !== userId);
      if (msgs.length) out.set(roomId, { unread: msgs.length, mentions: msgs.filter((m) => m.mentions.includes(userId)).length });
    }
    return out;
  }
}

export class InMemoryInviteRepository implements InviteRepository {
  private invites = new Map<string, Invite>();

  async create(roomId: RoomId, inviteeId: UserId, inviterId: UserId) {
    const existing = [...this.invites.values()].find((i) => i.roomId === roomId && i.inviteeId === inviteeId && i.status === 'pending');
    if (existing) return { ...existing };
    const invite: Invite = { id: randomUUID(), roomId, inviteeId, inviterId, status: 'pending', createdAt: new Date().toISOString() };
    this.invites.set(invite.id, invite);
    return { ...invite };
  }
  async get(id: string) { const i = this.invites.get(id); return i ? { ...i } : null; }
  async listPendingFor(userId: UserId) {
    return [...this.invites.values()].filter((i) => i.inviteeId === userId && i.status === 'pending').map((i) => ({ ...i }));
  }
  async setStatus(id: string, status: InviteStatus) {
    const i = this.invites.get(id);
    if (!i) throw new Error('invite not found');
    i.status = status;
    return { ...i };
  }
}
