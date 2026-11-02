import { Pool } from 'pg';
import {
  InMemoryInviteRepository, InMemoryMessageRepository, InMemoryRoomRepository, InMemoryUserRepository,
} from '../src/adapters/memory-store';
import { migrate } from '../src/adapters/postgres/migrate';
import { PgInviteRepository, PgMessageRepository, PgRoomRepository, PgUserRepository } from '../src/adapters/postgres/postgres-store';
import { ChatService } from '../src/core/chat-service';
import type { ChatEvent } from '../src/core/types';

export const pgUrl = process.env.TEST_DATABASE_URL;
let pool: Pool | null = null;

export async function closePool() { await pool?.end(); pool = null; }

/** Every scenario runs against the in-memory adapters, and against Postgres too when TEST_DATABASE_URL is set. */
export const adapters: { name: string; make: () => Promise<ChatService> }[] = [
  {
    name: 'memory',
    make: async () => new ChatService(
      new InMemoryUserRepository(), new InMemoryRoomRepository(), new InMemoryMessageRepository(), new InMemoryInviteRepository()),
  },
  ...(pgUrl ? [{
    name: 'postgres',
    make: async () => {
      pool ??= new Pool({ connectionString: pgUrl });
      await migrate(pool);
      await pool.query('truncate users, user_stores, rooms, room_members, room_invites, messages restart identity cascade');
      return new ChatService(new PgUserRepository(pool), new PgRoomRepository(pool), new PgMessageRepository(pool), new PgInviteRepository(pool));
    },
  }] : []),
];

export async function setup(make: () => Promise<ChatService>) {
  const chat = await make();
  for (const [id, name] of [['alice', 'Alice'], ['bob', 'Bob'], ['carol', 'Carol'], ['dave', 'Dave']]) {
    await chat.touchUser({ userId: id, username: id, displayName: name });
  }
  const events: ChatEvent[] = [];
  chat.subscribe((e) => events.push(e));
  return { chat, events };
}
