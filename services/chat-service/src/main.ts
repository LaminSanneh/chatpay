import { createServer } from 'node:http';
import { Pool } from 'pg';
import {
  InMemoryInviteRepository, InMemoryMessageRepository, InMemoryRoomRepository, InMemoryUserRepository,
} from './adapters/memory-store';
import { migrate } from './adapters/postgres/migrate';
import { PgInviteRepository, PgMessageRepository, PgRoomRepository, PgUserRepository } from './adapters/postgres/postgres-store';
import { JoseTokenVerifier } from './auth/jwt-verifier';
import { ChatService } from './core/chat-service';
import { createHttpApp } from './http/app';
import { startEventConsumers } from './messaging/consumers';
import { attachSocketGateway } from './ws/gateway';

/**
 * Composition root: the ONLY place that knows which adapters are plugged in.
 * DATABASE_URL set => Postgres adapters (migrations run on start). Otherwise in-memory (data lost on restart).
 * To embed the chat in another app, import ChatService + the adapters you need and skip this file.
 */
async function main() {
  const port = Number(process.env.PORT ?? 4000);
  const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim());
  const issuer = process.env.OIDC_ISSUER ?? 'http://localhost:8080/realms/chatpay';

  let chat: ChatService;
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const applied = await migrate(pool);
    if (applied.length) console.log('[db] applied migrations:', applied.join(', '));
    chat = new ChatService(new PgUserRepository(pool), new PgRoomRepository(pool), new PgMessageRepository(pool), new PgInviteRepository(pool));
    console.log('[db] using Postgres');
  } else {
    chat = new ChatService(new InMemoryUserRepository(), new InMemoryRoomRepository(), new InMemoryMessageRepository(), new InMemoryInviteRepository());
    console.warn('[db] DATABASE_URL not set: using in-memory storage (data is lost on restart)');
  }

  const verifier = new JoseTokenVerifier(issuer);
  const server = createServer(createHttpApp({ chat, verifier, corsOrigins }));
  attachSocketGateway(server, { chat, verifier, corsOrigins });

  if (process.env.AMQP_URL) {
    startEventConsumers({
      url: process.env.AMQP_URL,
      walletExchange: process.env.WALLET_EVENTS_EXCHANGE ?? 'wallet.events',
      walletQueue: process.env.CHAT_WALLET_QUEUE ?? 'chat.wallet-events',
      storeExchange: process.env.STORE_EVENTS_EXCHANGE ?? 'store.events',
      storeQueue: process.env.CHAT_STORE_QUEUE ?? 'chat.store-events',
    }, chat);
  }

  server.listen(port, () => console.log(`chat-service listening on :${port}`));
}

main().catch((err) => { console.error('fatal', err); process.exit(1); });
