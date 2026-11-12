import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import { ChatError } from '../core/errors';
import type { TokenVerifier } from '../core/ports';
import type { ChatService } from '../core/chat-service';
import type { Identity } from '../core/types';
import { isDependencyOutage } from '../messaging/retry-policy';

const userChannel = (userId: string) => `user:${userId}`;

const SendPayload = z.object({ roomId: z.string().min(1), text: z.string(), mentions: z.array(z.string()).max(50).optional() });
const RoomPayload = z.object({ roomId: z.string().min(1) });
const ReadPayload = z.object({ roomId: z.string().min(1), upTo: z.number().int().nonnegative().optional() });

/**
 * Delivery model: every socket joins ONE personal channel, `user:<id>`.
 * The core says "this event is for these user ids" and we emit to their channels.
 * No per-room socket bookkeeping, so new rooms/members work instantly and the same
 * pattern scales to multiple instances later (Socket.IO Redis adapter).
 *
 * Auth: the access token is checked on connect. Short-lived tokens expire, so the
 * client passes `auth` as a function and gets a fresh token on every reconnect.
 */
export function attachSocketGateway(
  httpServer: HttpServer,
  deps: { chat: ChatService; verifier: TokenVerifier; corsOrigins: string[] },
) {
  const { chat, verifier, corsOrigins } = deps;
  const io = new Server(httpServer, { cors: { origin: corsOrigins } });

  io.use(async (socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token ?? '');
      const identity = await verifier.verify(token);
      await chat.touchUser(identity);
      socket.data.identity = identity;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    const me = socket.data.identity as Identity;
    void socket.join(userChannel(me.userId));

    socket.on('message:send', async (raw: unknown, ack?: (r: unknown) => void) => {
      try {
        const { roomId, text, mentions } = SendPayload.parse(raw);
        const message = await chat.sendText(me.userId, roomId, text, mentions);   // delivery happens via chat.subscribe below
        ack?.({ ok: true, message });
      } catch (err) {
        ack?.({ ok: false, ...toWireError(err) });
      }
    });

    socket.on('typing', async (raw: unknown) => {
      try { await chat.typing(me.userId, RoomPayload.parse(raw).roomId); } catch { /* ignore */ }
    });

    socket.on('room:read', async (raw: unknown, ack?: (r: unknown) => void) => {
      try {
        const { roomId, upTo } = ReadPayload.parse(raw);
        await chat.markRead(me.userId, roomId, upTo);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, ...toWireError(err) });
      }
    });
  });

  const to = (ids: string[], event: string, payload: unknown) => { for (const id of ids) io.to(userChannel(id)).emit(event, payload); };

  chat.subscribe((e) => {
    switch (e.type) {
      case 'message:new': to(e.memberIds, 'message:new', e.message); break;
      case 'mention': to(e.userIds, 'mention', { message: e.message, roomName: e.roomName, sender: e.sender }); break;
      case 'room:new': to(e.userIds, 'room:new', e.room); break;
      case 'room:updated': to(e.room.memberIds, 'room:updated', e.room); break;
      case 'invite:new': to([e.userId], 'invite:new', e.invite); break;
      case 'room:read': to([e.userId], 'room:read', { roomId: e.roomId }); break;   // the user's other devices
      case 'typing': to(e.memberIds.filter((id) => id !== e.userId), 'typing', { roomId: e.roomId, userId: e.userId }); break;
    }
  });

  return io;
}

function toWireError(err: unknown) {
  if (err instanceof ChatError) return { code: err.code, message: err.message };
  if (err instanceof z.ZodError) return { code: 'VALIDATION_FAILED', message: err.issues[0]?.message ?? 'invalid payload' };
  if (isDependencyOutage(err)) return { code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable, please retry shortly' };
  console.error('[ws] unhandled', err);
  return { code: 'INTERNAL', message: 'Internal error' };
}
