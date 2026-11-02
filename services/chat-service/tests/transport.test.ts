import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import {
  InMemoryInviteRepository, InMemoryMessageRepository, InMemoryRoomRepository, InMemoryUserRepository,
} from '../src/adapters/memory-store';
import { ChatService } from '../src/core/chat-service';
import type { TokenVerifier } from '../src/core/ports';
import { createHttpApp } from '../src/http/app';
import { attachSocketGateway } from '../src/ws/gateway';

/** Fake IdP: the token IS the user id ("alice"). Everything else is the real HTTP + Socket.IO stack. */
const verifier: TokenVerifier = {
  async verify(token) {
    if (!['alice', 'bob', 'carol'].includes(token)) throw new Error('bad token');
    return { userId: token, username: token, displayName: token[0].toUpperCase() + token.slice(1) };
  },
};

let base = '';
let close = () => {};
const sockets: Socket[] = [];

before(async () => {
  const chat = new ChatService(new InMemoryUserRepository(), new InMemoryRoomRepository(), new InMemoryMessageRepository(), new InMemoryInviteRepository());
  const server = createServer(createHttpApp({ chat, verifier, corsOrigins: ['http://localhost:3000'] }));
  attachSocketGateway(server, { chat, verifier, corsOrigins: ['http://localhost:3000'] });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => { sockets.forEach((s) => s.disconnect()); close(); });

const call = async (who: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/api${path}`, {
    method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const connect = async (who: string) => {
  const s = io(base, { auth: { token: who }, transports: ['websocket'] });
  sockets.push(s);
  await new Promise<void>((resolve, reject) => { s.on('connect', resolve); s.on('connect_error', reject); });
  return s;
};
const next = <T>(s: Socket, event: string) => new Promise<T>((resolve) => s.once(event, resolve));

test('REST: auth, groups with invites, invites, history, read', async () => {
  assert.equal((await fetch(`${base}/api/rooms`)).status, 401);
  assert.equal((await call('mallory', 'GET', '/rooms')).status, 401);
  for (const u of ['alice', 'bob', 'carol']) await call(u, 'GET', '/me');

  const created = await call('alice', 'POST', '/rooms', { name: 'Crew', visibility: 'private', inviteeIds: ['bob', 'carol'] });
  assert.equal(created.status, 201);
  const roomId = created.body.id as string;

  assert.equal((await call('bob', 'GET', '/rooms/public')).body.length, 0);          // private: hidden
  assert.equal((await call('bob', 'POST', `/rooms/${roomId}/join`)).status, 404);      // and not joinable

  const invites = (await call('bob', 'GET', '/invites')).body;
  assert.equal(invites.length, 1);
  assert.equal((await call('bob', 'POST', `/invites/${invites[0].id}/accept`)).status, 200);
  const cInv = (await call('carol', 'GET', '/invites')).body;
  assert.equal((await call('carol', 'POST', `/invites/${cInv[0].id}/decline`)).status, 204);

  const sent = await call('alice', 'POST', `/rooms/${roomId}/messages`, { text: 'welcome @bob', mentions: ['bob'] });
  assert.equal(sent.status, 201);
  const bobRooms = (await call('bob', 'GET', '/rooms')).body;
  assert.equal(bobRooms[0].unreadCount, 1);
  assert.equal(bobRooms[0].mentionCount, 1);
  assert.equal((await call('bob', 'POST', `/rooms/${roomId}/read`, {})).status, 204);
  assert.equal((await call('bob', 'GET', '/rooms')).body[0].unreadCount, 0);

  const hist = await call('bob', 'GET', `/rooms/${roomId}/messages?before=${sent.body.seq}&limit=10`);
  assert.equal(hist.status, 200);
  assert.equal(hist.body.length, 0);
  assert.equal((await call('alice', 'POST', `/rooms/${roomId}/messages`, { text: '' })).status, 400);
});

test('Socket.IO: message, mention, typing and room:read events reach the right people', async () => {
  const room = (await call('alice', 'POST', '/rooms/direct', { userId: 'bob' })).body;
  const alice = await connect('alice');
  const bob = await connect('bob');
  const carol = await connect('carol');
  let carolGotSomething = false;
  for (const ev of ['message:new', 'mention', 'typing']) carol.on(ev, () => { carolGotSomething = true; });

  const gotMessage = next<{ text: string }>(bob, 'message:new');
  const gotMention = next<{ roomName: string | null; sender: { id: string } }>(bob, 'mention');
  const ack = await alice.emitWithAck('message:send', { roomId: room.id, text: 'psst @bob', mentions: ['bob'] });
  assert.equal(ack.ok, true);
  assert.equal((await gotMessage).text, 'psst @bob');
  assert.equal((await gotMention).sender.id, 'alice');

  const gotTyping = next<{ roomId: string; userId: string }>(bob, 'typing');
  alice.emit('typing', { roomId: room.id });
  assert.deepEqual(await gotTyping, { roomId: room.id, userId: 'alice' });

  const bobOtherDevice = await connect('bob');
  const gotRead = next<{ roomId: string }>(bobOtherDevice, 'room:read');
  assert.equal((await bob.emitWithAck('room:read', { roomId: room.id })).ok, true);
  assert.equal((await gotRead).roomId, room.id);

  const denied = await carol.emitWithAck('message:send', { roomId: room.id, text: 'let me in' });
  assert.equal(denied.ok, false);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(carolGotSomething, false);
});
