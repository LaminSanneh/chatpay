import { io, type Socket } from 'socket.io-client';
import type { TokenProvider } from './http';

/** `auth` is a function so every (re)connect fetches a fresh access token. */
export function connectChatSocket(url: string, getToken: TokenProvider): Socket {
  return io(url, {
    auth: (cb) => { getToken().then((token) => cb({ token })).catch(() => cb({ token: '' })); },
  });
}

export function sendOverSocket(socket: Socket, roomId: string, text: string, mentions: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit('message:send', { roomId, text, mentions }, (err: Error | null, res: { ok: boolean; message?: string }) => {
      if (err) return reject(err);
      return res?.ok ? resolve() : reject(new Error(res?.message ?? 'send failed'));
    });
  });
}
