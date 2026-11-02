import type { Pool } from 'pg';
import type {
  InviteRepository, MessageRepository, NewMessage, NewRoom, RoomRepository, UserRepository,
} from '../../core/ports';
import type {
  Identity, Invite, InviteStatus, MemberRole, Message, Room, RoomId, RoomMember, StoreRef, UserId, UserProfile,
} from '../../core/types';

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

// ---------------------------------------------------------------- users
const USER_SELECT = `select u.id, u.username, u.display_name, u.last_seen_at, s.store_id, s.store_name, s.store_slug
                       from users u left join user_stores s on s.user_id = u.id`;

function toUser(r: any): UserProfile {
  return {
    id: r.id, username: r.username, displayName: r.display_name, lastSeenAt: iso(r.last_seen_at),
    store: r.store_id ? { id: r.store_id, name: r.store_name, slug: r.store_slug } : null,
  };
}

export class PgUserRepository implements UserRepository {
  constructor(private pool: Pool) {}

  async upsert(i: Identity) {
    await this.pool.query(
      `insert into users (id, username, display_name) values ($1, $2, $3)
       on conflict (id) do update set username = excluded.username, display_name = excluded.display_name, last_seen_at = now()`,
      [i.userId, i.username, i.displayName]);
    return (await this.get(i.userId))!;
  }
  async get(id: UserId) {
    const { rows } = await this.pool.query(`${USER_SELECT} where u.id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }
  async getMany(ids: UserId[]) {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query(`${USER_SELECT} where u.id = any($1::text[])`, [ids]);
    return rows.map(toUser);
  }
  async search(query: string, limit: number, excludeId?: UserId) {
    const like = `%${query.trim().replace(/[%_\\]/g, '\\$&')}%`;
    const { rows } = await this.pool.query(
      `${USER_SELECT} where ($3::text is null or u.id <> $3) and (u.username ilike $1 or u.display_name ilike $1)
       order by u.display_name limit $2`, [like, limit, excludeId ?? null]);
    return rows.map(toUser);
  }
  async setStore(userId: UserId, store: StoreRef | null) {
    if (!store) { await this.pool.query('delete from user_stores where user_id = $1', [userId]); return; }
    await this.pool.query(
      `insert into user_stores (user_id, store_id, store_name, store_slug) values ($1, $2, $3, $4)
       on conflict (user_id) do update set store_id = excluded.store_id, store_name = excluded.store_name, store_slug = excluded.store_slug`,
      [userId, store.id, store.name, store.slug]);
  }
}

// ---------------------------------------------------------------- rooms
export class PgRoomRepository implements RoomRepository {
  constructor(private pool: Pool) {}

  private async load(ids: RoomId[]): Promise<Room[]> {
    if (ids.length === 0) return [];
    const rooms = await this.pool.query('select * from rooms where id = any($1::uuid[])', [ids]);
    const members = await this.pool.query(
      'select room_id, user_id, role from room_members where room_id = any($1::uuid[]) order by joined_at, user_id', [ids]);
    const byRoom = new Map<string, RoomMember[]>();
    for (const m of members.rows) {
      const list = byRoom.get(m.room_id) ?? [];
      list.push({ userId: m.user_id, role: m.role as MemberRole });
      byRoom.set(m.room_id, list);
    }
    return rooms.rows.map((r) => ({
      id: r.id, kind: r.kind, name: r.name, visibility: r.visibility, createdBy: r.created_by,
      createdAt: iso(r.created_at), directKey: r.direct_key ?? undefined, members: byRoom.get(r.id) ?? [],
    }));
  }
  private async loadOne(id: RoomId) { return (await this.load([id]))[0] ?? null; }

  async create(input: NewRoom) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `insert into rooms (kind, name, visibility, direct_key, created_by) values ($1, $2, $3, $4, $5) returning id`,
        [input.kind, input.name, input.visibility, input.directKey ?? null, input.createdBy]);
      for (const m of input.members) {
        await client.query('insert into room_members (room_id, user_id, role) values ($1, $2, $3)', [rows[0].id, m.userId, m.role]);
      }
      await client.query('commit');
      return (await this.loadOne(rows[0].id))!;
    } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  }
  get(id: RoomId) { return this.loadOne(id); }
  async findDirect(directKey: string) {
    const { rows } = await this.pool.query('select id from rooms where direct_key = $1', [directKey]);
    return rows[0] ? this.loadOne(rows[0].id) : null;
  }
  async listForUser(userId: UserId) {
    const { rows } = await this.pool.query('select room_id from room_members where user_id = $1', [userId]);
    return this.load(rows.map((r) => r.room_id));
  }
  async listPublicGroups(query: string, limit: number) {
    const like = `%${query.replace(/[%_\\]/g, '\\$&')}%`;
    const { rows } = await this.pool.query(
      `select id from rooms where kind = 'group' and visibility = 'public' and name ilike $1 order by created_at desc limit $2`, [like, limit]);
    return this.load(rows.map((r) => r.id));
  }
  async addMember(roomId: RoomId, member: RoomMember) {
    await this.pool.query(
      'insert into room_members (room_id, user_id, role) values ($1, $2, $3) on conflict do nothing', [roomId, member.userId, member.role]);
    return (await this.loadOne(roomId))!;
  }
  async removeMember(roomId: RoomId, userId: UserId) {
    await this.pool.query('delete from room_members where room_id = $1 and user_id = $2', [roomId, userId]);
    return (await this.loadOne(roomId))!;
  }
  async setRole(roomId: RoomId, userId: UserId, role: MemberRole) {
    await this.pool.query('update room_members set role = $3 where room_id = $1 and user_id = $2', [roomId, userId, role]);
    return (await this.loadOne(roomId))!;
  }
  async readCursors(userId: UserId) {
    const { rows } = await this.pool.query('select room_id, last_read_seq from room_members where user_id = $1', [userId]);
    return new Map<RoomId, number>(rows.map((r) => [r.room_id, Number(r.last_read_seq)]));
  }
  async setReadCursor(roomId: RoomId, userId: UserId, seq: number) {
    await this.pool.query(
      'update room_members set last_read_seq = greatest(last_read_seq, $3) where room_id = $1 and user_id = $2', [roomId, userId, seq]);
  }
}

// ---------------------------------------------------------------- messages
function toMessage(r: any): Message {
  return {
    id: r.id, seq: Number(r.seq), roomId: r.room_id, senderId: r.sender_id, kind: r.kind, text: r.text,
    payment: r.payment ?? null, order: r.order_data ?? null, mentions: r.mentions ?? [], createdAt: iso(r.created_at),
  };
}

export class PgMessageRepository implements MessageRepository {
  constructor(private pool: Pool) {}

  async append(m: NewMessage) {
    const cols = [m.roomId, m.senderId, m.kind, m.text, m.payment ? JSON.stringify(m.payment) : null,
      m.order ? JSON.stringify(m.order) : null, m.mentions];
    // ON CONFLICT DO NOTHING covers both unique indexes (one bubble per transfer, one per order).
    const { rows } = await this.pool.query(
      `insert into messages (room_id, sender_id, kind, text, payment, order_data, mentions)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::text[]) on conflict do nothing returning *`, cols);
    if (rows[0]) return toMessage(rows[0]);
    // Lost a race on a unique index: return the message that won.
    return (m.payment ? await this.findByTransferId(m.payment.transferId) : await this.findByOrderId(m.order!.orderId))!;
  }
  async list(roomId: RoomId, opts: { before?: number; limit: number }) {
    const { rows } = await this.pool.query(
      `select * from messages where room_id = $1 and ($2::bigint is null or seq < $2) order by seq desc limit $3`,
      [roomId, opts.before ?? null, opts.limit]);
    return rows.reverse().map(toMessage);
  }
  async findByTransferId(transferId: string) {
    const { rows } = await this.pool.query(`select * from messages where payment ->> 'transferId' = $1`, [transferId]);
    return rows[0] ? toMessage(rows[0]) : null;
  }
  async findByOrderId(orderId: string) {
    const { rows } = await this.pool.query(`select * from messages where order_data ->> 'orderId' = $1`, [orderId]);
    return rows[0] ? toMessage(rows[0]) : null;
  }
  async lastMessages(roomIds: RoomId[]) {
    const out = new Map<RoomId, Message>();
    if (roomIds.length === 0) return out;
    const { rows } = await this.pool.query(
      `select distinct on (room_id) * from messages where room_id = any($1::uuid[]) order by room_id, seq desc`, [roomIds]);
    for (const r of rows) out.set(r.room_id, toMessage(r));
    return out;
  }
  async latestSeq(roomId: RoomId) {
    const { rows } = await this.pool.query('select coalesce(max(seq), 0) as s from messages where room_id = $1', [roomId]);
    return Number(rows[0].s);
  }
  async unreadBatch(userId: UserId, cursors: Map<RoomId, number>) {
    const out = new Map<RoomId, { unread: number; mentions: number }>();
    if (cursors.size === 0) return out;
    const { rows } = await this.pool.query(
      `select m.room_id,
              count(*) as unread,
              count(*) filter (where $1 = any(m.mentions)) as mentions
         from messages m
         join unnest($2::uuid[], $3::bigint[]) as c(room_id, seq) on c.room_id = m.room_id
        where m.seq > c.seq and m.sender_id <> $1
        group by m.room_id`,
      [userId, [...cursors.keys()], [...cursors.values()]]);
    for (const r of rows) out.set(r.room_id, { unread: Number(r.unread), mentions: Number(r.mentions) });
    return out;
  }
}

// ---------------------------------------------------------------- invites
function toInvite(r: any): Invite {
  return { id: r.id, roomId: r.room_id, inviteeId: r.invitee_id, inviterId: r.inviter_id, status: r.status, createdAt: iso(r.created_at) };
}

export class PgInviteRepository implements InviteRepository {
  constructor(private pool: Pool) {}

  async create(roomId: RoomId, inviteeId: UserId, inviterId: UserId) {
    const ins = await this.pool.query(
      `insert into room_invites (room_id, invitee_id, inviter_id) values ($1, $2, $3)
       on conflict (room_id, invitee_id) where status = 'pending' do nothing returning *`, [roomId, inviteeId, inviterId]);
    if (ins.rows[0]) return toInvite(ins.rows[0]);
    const { rows } = await this.pool.query(
      `select * from room_invites where room_id = $1 and invitee_id = $2 and status = 'pending'`, [roomId, inviteeId]);
    return toInvite(rows[0]);
  }
  async get(id: string) {
    const { rows } = await this.pool.query('select * from room_invites where id = $1::uuid', [id]).catch(() => ({ rows: [] as any[] }));
    return rows[0] ? toInvite(rows[0]) : null;
  }
  async listPendingFor(userId: UserId) {
    const { rows } = await this.pool.query(
      `select * from room_invites where invitee_id = $1 and status = 'pending' order by created_at desc`, [userId]);
    return rows.map(toInvite);
  }
  async setStatus(id: string, status: InviteStatus) {
    const { rows } = await this.pool.query(
      'update room_invites set status = $2, responded_at = now() where id = $1 returning *', [id, status]);
    return toInvite(rows[0]);
  }
}
