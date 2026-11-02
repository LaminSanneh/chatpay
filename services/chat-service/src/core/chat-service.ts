import { ChatError } from './errors';
import type { InviteRepository, MessageRepository, RoomRepository, UserRepository } from './ports';
import type {
  ChatEvent, Identity, Invite, InviteView, MemberRole, Message, OrderPaidEvent, Room, RoomId, RoomSummary, RoomView,
  StoreClosedEvent, StoreOpenedEvent, TransferCompletedEvent, UserId, UserProfile, Visibility,
} from './types';

export interface ChatServiceOptions {
  maxMessageLength?: number;
  maxInvitesPerCall?: number;
}

const unique = <T>(xs: T[]) => [...new Set(xs)];

/**
 * All chat business rules live here. No HTTP, no sockets, no broker.
 * Plain class + constructor injection => trivially wrapped as a NestJS provider later.
 */
export class ChatService {
  private listeners = new Set<(e: ChatEvent) => void>();
  private readonly maxLen: number;
  private readonly maxInvites: number;

  constructor(
    private readonly users: UserRepository,
    private readonly rooms: RoomRepository,
    private readonly messages: MessageRepository,
    private readonly invites: InviteRepository,
    opts: ChatServiceOptions = {},
  ) {
    this.maxLen = opts.maxMessageLength ?? 4000;
    this.maxInvites = opts.maxInvitesPerCall ?? 50;
  }

  /** Transport adapters (Socket.IO, SSE, push...) subscribe here to deliver events. */
  subscribe(listener: (e: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ChatEvent) {
    for (const l of this.listeners) {
      try { l(event); } catch (err) { console.error('[chat] listener failed', err); }
    }
  }

  // ---- users ---------------------------------------------------------------
  touchUser(identity: Identity): Promise<UserProfile> {
    return this.users.upsert(identity);
  }

  searchUsers(query: string, requesterId: UserId, limit = 10): Promise<UserProfile[]> {
    return this.users.search(query, limit, requesterId);
  }

  async applyStoreOpened(evt: StoreOpenedEvent): Promise<void> {
    await this.users.setStore(evt.ownerUserId, { id: evt.storeId, name: evt.name, slug: evt.slug });
  }

  async applyStoreClosed(evt: StoreClosedEvent): Promise<void> {
    await this.users.setStore(evt.ownerUserId, null);
  }

  // ---- rooms ---------------------------------------------------------------
  async listRooms(userId: UserId): Promise<RoomView[]> {
    return this.toViews(userId, await this.rooms.listForUser(userId));
  }

  /** Public groups anyone may browse and join. Private groups never appear here. */
  async listPublicGroups(query = '', limit = 50): Promise<RoomSummary[]> {
    const rooms = await this.rooms.listPublicGroups(query.trim(), Math.min(limit, 100));
    return this.summaries(rooms);
  }

  async createGroup(
    userId: UserId,
    input: { name: string; visibility?: Visibility; inviteeIds?: UserId[] },
  ): Promise<RoomView> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 80) throw ChatError.badRequest('INVALID_NAME', 'Room name must be 1-80 characters');
    const visibility = input.visibility ?? 'public';
    if (visibility !== 'public' && visibility !== 'private') throw ChatError.badRequest('INVALID_VISIBILITY', 'Visibility must be public or private');

    const room = await this.rooms.create({
      kind: 'group', name, visibility, createdBy: userId, members: [{ userId, role: 'owner' }],
    });
    const [summary] = await this.summaries([room]);
    this.emit({ type: 'room:new', room: summary, userIds: [userId] });
    if (input.inviteeIds?.length) await this.inviteMany(userId, room, input.inviteeIds);
    return { ...summary, unreadCount: 0, mentionCount: 0, lastMessage: null };
  }

  /** Owners/admins may invite to private groups; any member may invite to public ones. */
  async inviteToGroup(userId: UserId, roomId: RoomId, inviteeIds: UserId[]): Promise<{ invited: number }> {
    const room = await this.requireMember(userId, roomId);
    if (room.kind !== 'group') throw ChatError.badRequest('NOT_A_GROUP', 'Only groups have invites');
    const role = room.members.find((m) => m.userId === userId)!.role;
    if (room.visibility === 'private' && role === 'member') {
      throw ChatError.forbidden('NOT_ALLOWED', 'Only owners and admins can invite to a private group');
    }
    return { invited: await this.inviteMany(userId, room, inviteeIds) };
  }

  private async inviteMany(inviterId: UserId, room: Room, inviteeIds: UserId[]): Promise<number> {
    const ids = unique(inviteeIds).filter((id) => id !== inviterId);
    if (ids.length > this.maxInvites) throw ChatError.badRequest('TOO_MANY_INVITES', `Max ${this.maxInvites} invites at once`);
    const memberIds = new Set(room.members.map((m) => m.userId));
    const inviter = await this.users.get(inviterId);
    let count = 0;
    for (const id of ids) {
      if (memberIds.has(id) || !(await this.users.get(id))) continue;
      const invite = await this.invites.create(room.id, id, inviterId);
      this.emit({ type: 'invite:new', userId: id, invite: this.inviteView(invite, room, inviter) });
      count++;
    }
    return count;
  }

  async listInvites(userId: UserId): Promise<InviteView[]> {
    const pending = await this.invites.listPendingFor(userId);
    const views: InviteView[] = [];
    for (const invite of pending) {
      const room = await this.rooms.get(invite.roomId);
      if (!room) continue;
      views.push(this.inviteView(invite, room, await this.users.get(invite.inviterId)));
    }
    return views;
  }

  /** Returns the joined room, or null when declined. */
  async respondToInvite(userId: UserId, inviteId: string, accept: boolean): Promise<RoomView | null> {
    const invite = await this.invites.get(inviteId);
    if (!invite || invite.inviteeId !== userId) throw ChatError.notFound('INVITE_NOT_FOUND', 'Invite not found');
    if (invite.status !== 'pending') throw ChatError.conflict('INVITE_CLOSED', `Invite already ${invite.status}`);
    if (!accept) {
      await this.invites.setStatus(inviteId, 'declined');
      return null;
    }
    await this.invites.setStatus(inviteId, 'accepted');
    return this.addMemberAndAnnounce(userId, invite.roomId);
  }

  async joinGroup(userId: UserId, roomId: RoomId): Promise<RoomView> {
    const room = await this.rooms.get(roomId);
    // Private rooms answer exactly like missing ones, so their existence is not leaked.
    if (!room || room.kind !== 'group' || room.visibility !== 'public') throw ChatError.notFound('ROOM_NOT_FOUND', 'Room not found');
    return this.addMemberAndAnnounce(userId, roomId);
  }

  private async addMemberAndAnnounce(userId: UserId, roomId: RoomId): Promise<RoomView> {
    const before = await this.rooms.get(roomId);
    if (!before) throw ChatError.notFound('ROOM_NOT_FOUND', 'Room not found');
    const already = before.members.some((m) => m.userId === userId);
    const room = already ? before : await this.rooms.addMember(roomId, { userId, role: 'member' });
    const [summary] = await this.summaries([room]);
    if (!already) {
      this.emit({ type: 'room:new', room: summary, userIds: [userId] });
      this.emit({ type: 'room:updated', room: summary });
    }
    return (await this.toViews(userId, [room]))[0];
  }

  async leaveGroup(userId: UserId, roomId: RoomId): Promise<void> {
    const room = await this.requireMember(userId, roomId);
    if (room.kind !== 'group') throw ChatError.badRequest('NOT_A_GROUP', 'Direct chats cannot be left');
    const me = room.members.find((m) => m.userId === userId)!;
    let updated = await this.rooms.removeMember(roomId, userId);
    if (me.role === 'owner' && !updated.members.some((m) => m.role === 'owner') && updated.members.length > 0) {
      const successor = updated.members.find((m) => m.role === 'admin') ?? updated.members[0];
      updated = await this.rooms.setRole(roomId, successor.userId, 'owner');
    }
    if (updated.members.length > 0) {
      const [summary] = await this.summaries([updated]);
      this.emit({ type: 'room:updated', room: summary });
    }
  }

  async getOrCreateDirect(userId: UserId, otherId: UserId): Promise<RoomView> {
    if (userId === otherId) throw ChatError.badRequest('SELF_CHAT', 'Cannot start a chat with yourself');
    if (!(await this.users.get(otherId))) throw ChatError.notFound('USER_NOT_FOUND', 'User not found');
    const directKey = [userId, otherId].sort().join(':');
    const existing = await this.rooms.findDirect(directKey);
    if (existing) return (await this.toViews(userId, [existing]))[0];
    const members: { userId: UserId; role: MemberRole }[] = [{ userId, role: 'member' }, { userId: otherId, role: 'member' }];
    const room = await this.rooms.create({ kind: 'direct', name: null, visibility: 'private', createdBy: userId, directKey, members });
    const [summary] = await this.summaries([room]);
    this.emit({ type: 'room:new', room: summary, userIds: [userId, otherId] });
    return { ...summary, unreadCount: 0, mentionCount: 0, lastMessage: null };
  }

  // ---- messages ------------------------------------------------------------
  async sendText(userId: UserId, roomId: RoomId, text: string, mentionIds: UserId[] = []): Promise<Message> {
    const clean = text.trim();
    if (!clean) throw ChatError.badRequest('EMPTY_MESSAGE', 'Message is empty');
    if (clean.length > this.maxLen) throw ChatError.badRequest('MESSAGE_TOO_LONG', `Max ${this.maxLen} characters`);
    const room = await this.requireMember(userId, roomId);
    const memberIds = room.members.map((m) => m.userId);
    // Only real members of this room can be mentioned; ids come from the composer's picker, not from parsing text.
    const mentions = unique(mentionIds).filter((id) => id !== userId && memberIds.includes(id));

    const message = await this.messages.append({
      roomId, senderId: userId, kind: 'text', text: clean, payment: null, order: null, mentions,
    });
    await this.rooms.setReadCursor(roomId, userId, message.seq);   // your own message is never "unread" for you
    this.emit({ type: 'message:new', message, memberIds });
    if (mentions.length > 0) {
      this.emit({ type: 'mention', message, userIds: mentions, roomName: room.name, sender: await this.users.get(userId) });
    }
    return message;
  }

  async history(userId: UserId, roomId: RoomId, opts: { before?: number; limit?: number } = {}): Promise<Message[]> {
    await this.requireMember(userId, roomId);
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
    return this.messages.list(roomId, { before: opts.before, limit });
  }

  /** Moves the user's read cursor (never backwards) and tells their other devices. */
  async markRead(userId: UserId, roomId: RoomId, upTo?: number): Promise<void> {
    await this.requireMember(userId, roomId);
    const latest = await this.messages.latestSeq(roomId);
    const seq = upTo === undefined ? latest : Math.min(upTo, latest);
    await this.rooms.setReadCursor(roomId, userId, seq);
    this.emit({ type: 'room:read', userId, roomId });
  }

  async typing(userId: UserId, roomId: RoomId): Promise<void> {
    const room = await this.requireMember(userId, roomId);
    this.emit({ type: 'typing', roomId, userId, memberIds: room.members.map((m) => m.userId) });
  }

  // ---- payments (driven by wallet events, never by clients) ----------------
  /**
   * Turns a trusted wallet event into a payment message. Idempotent: the broker delivers
   * at-least-once, so the same transferId may arrive twice.
   * Returns null when the event is not for us or fails validation (caller just acks it).
   */
  async applyTransferCompleted(evt: TransferCompletedEvent): Promise<Message | null> {
    if (evt.referenceType !== 'chat' || !evt.referenceId) return null;
    if (evt.kind && evt.kind !== 'P2P') return null;               // order payments are not chat bubbles

    if (await this.messages.findByTransferId(evt.transferId)) return null;   // already applied

    const room = await this.rooms.get(evt.referenceId);
    if (!room || room.kind !== 'direct') {
      console.warn('[chat] transfer references unknown/non-direct room', evt.transferId, evt.referenceId);
      return null;
    }
    // The wallet only knows the room id as an opaque string. WE verify sender and recipient belong to it.
    const members = new Set(room.members.map((m) => m.userId));
    if (!members.has(evt.fromUserId) || !members.has(evt.toUserId)) {
      console.warn('[chat] transfer parties are not members of the referenced room', evt.transferId);
      return null;
    }

    const message = await this.messages.append({
      roomId: room.id,
      senderId: evt.fromUserId,
      kind: 'payment',
      text: null,
      mentions: [],
      order: null,
      payment: {
        transferId: evt.transferId,
        intentId: evt.intentId ?? null,
        fromUserId: evt.fromUserId,
        toUserId: evt.toUserId,
        amountMinor: evt.amountMinor,
        currency: evt.currency,
        note: evt.note ?? null,
        status: 'completed',
      },
    });
    await this.rooms.setReadCursor(room.id, evt.fromUserId, message.seq);
    this.emit({ type: 'message:new', message, memberIds: room.members.map((m) => m.userId) });
    return message;
  }

  // ---- gift orders (driven by store events, never by clients) -------------
  /**
   * `order.paid` with a chat context and a recipient becomes an order bubble in that 1:1 chat.
   * Idempotent per order. Self-purchases (no recipient) produce no bubble: nobody else needs to see them.
   */
  async applyOrderPaid(evt: OrderPaidEvent): Promise<Message | null> {
    if (evt.context?.type !== 'chat' || !evt.context.roomId || !evt.recipientUserId) return null;
    if (await this.messages.findByOrderId(evt.orderId)) return null;

    const room = await this.rooms.get(evt.context.roomId);
    if (!room || room.kind !== 'direct') return null;
    const members = new Set(room.members.map((m) => m.userId));
    if (!members.has(evt.buyerUserId) || !members.has(evt.recipientUserId)) {
      console.warn('[chat] order parties are not members of the referenced room', evt.orderId);
      return null;
    }

    const message = await this.messages.append({
      roomId: room.id, senderId: evt.buyerUserId, kind: 'order', text: null, payment: null, mentions: [],
      order: {
        orderId: evt.orderId, storeId: evt.storeId, storeName: evt.storeName, buyerId: evt.buyerUserId,
        recipientId: evt.recipientUserId, totalMinor: evt.totalMinor, currency: evt.currency, items: evt.items,
      },
    });
    await this.rooms.setReadCursor(room.id, evt.buyerUserId, message.seq);
    this.emit({ type: 'message:new', message, memberIds: room.members.map((m) => m.userId) });
    return message;
  }

  // ---- helpers -------------------------------------------------------------
  private async requireMember(userId: UserId, roomId: RoomId): Promise<Room> {
    const room = await this.rooms.get(roomId);
    if (!room || !room.members.some((m) => m.userId === userId)) {
      throw ChatError.notFound('ROOM_NOT_FOUND', 'Room not found');   // same answer for "missing" and "not yours"
    }
    return room;
  }

  private async summaries(rooms: Room[]): Promise<RoomSummary[]> {
    const ids = unique(rooms.flatMap((r) => r.members.map((m) => m.userId)));
    const profiles = new Map((await this.users.getMany(ids)).map((u) => [u.id, u]));
    return rooms.map((r) => ({
      id: r.id, kind: r.kind, name: r.name, visibility: r.visibility, createdBy: r.createdBy, createdAt: r.createdAt,
      memberIds: r.members.map((m) => m.userId),
      roles: Object.fromEntries(r.members.map((m) => [m.userId, m.role])),
      members: r.members.map((m) => profiles.get(m.userId)).filter((u): u is UserProfile => !!u),
    }));
  }

  private async toViews(userId: UserId, rooms: Room[]): Promise<RoomView[]> {
    if (rooms.length === 0) return [];
    const ids = rooms.map((r) => r.id);
    const [cursors, last, summaries] = await Promise.all([
      this.rooms.readCursors(userId), this.messages.lastMessages(ids), this.summaries(rooms),
    ]);
    const unread = await this.messages.unreadBatch(userId, new Map(ids.map((id) => [id, cursors.get(id) ?? 0])));
    return summaries
      .map((s) => ({
        ...s,
        unreadCount: unread.get(s.id)?.unread ?? 0,
        mentionCount: unread.get(s.id)?.mentions ?? 0,
        lastMessage: last.get(s.id) ?? null,
      }))
      .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt).localeCompare(a.lastMessage?.createdAt ?? a.createdAt));
  }

  private inviteView(invite: Invite, room: Room, inviter: UserProfile | null): InviteView {
    return {
      id: invite.id, status: invite.status, createdAt: invite.createdAt,
      room: { id: room.id, name: room.name, visibility: room.visibility, memberCount: room.members.length },
      inviter,
    };
  }
}
