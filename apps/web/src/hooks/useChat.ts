import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ChatApi } from '@/core/chatApi';
import type { TokenProvider } from '@/core/http';
import { connectChatSocket, sendOverSocket } from '@/core/socket';
import type { InviteView, Message, RoomSummary, RoomView, UserProfile, Visibility } from '@/core/types';

export interface Toast { id: number; title: string; body: string }

const TYPING_TTL_MS = 4000;
const TYPING_SEND_EVERY_MS = 2000;

const appendUnique = (list: Message[], m: Message) => (list.some((x) => x.id === m.id) ? list : [...list, m]);
const lastActivity = (r: RoomView) => r.lastMessage?.createdAt ?? r.createdAt;
const sortRooms = (rooms: RoomView[]) => [...rooms].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));

/** Merge a viewer-independent summary into the list, keeping this user's own unread counts. */
function mergeSummary(rooms: RoomView[], s: RoomSummary): RoomView[] {
  const existing = rooms.find((r) => r.id === s.id);
  if (!existing) return sortRooms([{ ...s, unreadCount: 0, mentionCount: 0, lastMessage: null }, ...rooms]);
  return rooms.map((r) => (r.id === s.id ? { ...r, ...s } : r));
}

function desktopNotify(title: string, body: string) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (document.visibilityState === 'hidden' && Notification.permission === 'granted') new Notification(title, { body });
}

export function useChat(api: ChatApi, chatUrl: string, getToken: TokenProvider, meId: string, onPayment?: () => void) {
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [typing, setTyping] = useState<Record<string, Record<string, number>>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connected, setConnected] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const loaded = useRef(new Set<string>());
  const activeRef = useRef<string | null>(null);
  const roomsRef = useRef<RoomView[]>([]);
  const lastTypingSent = useRef(0);
  const toastSeq = useRef(0);
  const onPaymentRef = useRef(onPayment);
  onPaymentRef.current = onPayment;
  activeRef.current = activeId;
  roomsRef.current = rooms;

  const pushToast = useCallback((title: string, body: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  /** Zero the counts locally, then tell the server (which tells this user's other devices). */
  const markRead = useCallback((roomId: string) => {
    const room = roomsRef.current.find((r) => r.id === roomId);
    if (!room || (room.unreadCount === 0 && room.mentionCount === 0)) return;
    setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, unreadCount: 0, mentionCount: 0 } : r)));
    api.markRead(roomId).catch(() => undefined);
  }, [api]);

  const loadHistory = useCallback(async (roomId: string) => {
    if (loaded.current.has(roomId)) return;
    loaded.current.add(roomId);
    const list = await api.history(roomId);
    setMessages((prev) => ({ ...prev, [roomId]: list.reduce(appendUnique, prev[roomId] ?? []) }));
  }, [api]);

  useEffect(() => {
    api.listRooms().then(setRooms).catch(console.error);
    api.invites().then(setInvites).catch(console.error);
    const socket = connectChatSocket(chatUrl, getToken);
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('message:new', (m: Message) => {
      if (!roomsRef.current.some((r) => r.id === m.roomId)) {   // a room we have not heard of yet
        api.listRooms().then(setRooms).catch(() => undefined);
        return;
      }
      if (loaded.current.has(m.roomId)) setMessages((prev) => ({ ...prev, [m.roomId]: appendUnique(prev[m.roomId] ?? [], m) }));
      const mine = m.senderId === meId;
      const viewing = activeRef.current === m.roomId && document.visibilityState === 'visible';
      setRooms((prev) => sortRooms(prev.map((r) => (r.id !== m.roomId ? r : {
        ...r,
        lastMessage: m,
        unreadCount: r.unreadCount + (mine || viewing ? 0 : 1),
        mentionCount: r.mentionCount + (!mine && !viewing && m.mentions.includes(meId) ? 1 : 0),
      }))));
      if (viewing && !mine) api.markRead(m.roomId).catch(() => undefined);
      if (m.kind === 'payment') onPaymentRef.current?.();
    });

    socket.on('mention', (e: { message: Message; roomName: string | null; sender: UserProfile | null }) => {
      const who = e.sender?.displayName ?? 'Someone';
      const title = `${who} mentioned you`;
      const body = `${e.roomName ?? 'Direct chat'}: ${e.message.text ?? ''}`;
      if (activeRef.current !== e.message.roomId || document.visibilityState !== 'visible') pushToast(title, body);
      desktopNotify(title, body);
    });

    socket.on('room:new', (room: RoomSummary) => setRooms((prev) => mergeSummary(prev, room)));
    socket.on('room:updated', (room: RoomSummary) => setRooms((prev) => mergeSummary(prev, room)));
    socket.on('room:read', (e: { roomId: string }) =>
      setRooms((prev) => prev.map((r) => (r.id === e.roomId ? { ...r, unreadCount: 0, mentionCount: 0 } : r))));

    socket.on('invite:new', (invite: InviteView) => {
      setInvites((prev) => [invite, ...prev.filter((i) => i.id !== invite.id)]);
      const title = `${invite.inviter?.displayName ?? 'Someone'} invited you`;
      const body = `Join "${invite.room.name ?? 'a group'}"`;
      pushToast(title, body);
      desktopNotify(title, body);
    });

    socket.on('typing', (e: { roomId: string; userId: string }) =>
      setTyping((prev) => ({ ...prev, [e.roomId]: { ...(prev[e.roomId] ?? {}), [e.userId]: Date.now() } })));

    const prune = setInterval(() => {
      setTyping((prev) => {
        const now = Date.now();
        let changed = false;
        const next: typeof prev = {};
        for (const [roomId, users] of Object.entries(prev)) {
          const alive = Object.fromEntries(Object.entries(users).filter(([, t]) => now - t < TYPING_TTL_MS));
          if (Object.keys(alive).length !== Object.keys(users).length) changed = true;
          if (Object.keys(alive).length) next[roomId] = alive;
        }
        return changed ? next : prev;
      });
    }, 1000);

    const onVisible = () => { if (document.visibilityState === 'visible' && activeRef.current) markRead(activeRef.current); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(prune);
      document.removeEventListener('visibilitychange', onVisible);
      socket.disconnect();
    };
  }, [api, chatUrl, getToken, meId, markRead, pushToast]);

  const selectRoom = useCallback((id: string) => {
    setActiveId(id);
    markRead(id);
    void loadHistory(id);
  }, [loadHistory, markRead]);

  const sendText = useCallback(async (roomId: string, text: string, mentions: string[]) => {
    if (!socketRef.current) throw new Error('Not connected');
    await sendOverSocket(socketRef.current, roomId, text, mentions);
  }, []);

  /** Throttled: at most one `typing` event every 2 seconds while the user keeps typing. */
  const notifyTyping = useCallback((roomId: string) => {
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_SEND_EVERY_MS) return;
    lastTypingSent.current = now;
    socketRef.current?.emit('typing', { roomId });
  }, []);

  const adopt = useCallback((room: RoomView) => {
    setRooms((prev) => sortRooms(prev.some((r) => r.id === room.id) ? prev.map((r) => (r.id === room.id ? room : r)) : [room, ...prev]));
    selectRoom(room.id);
  }, [selectRoom]);

  const openDirect = useCallback(async (userId: string) => adopt(await api.openDirect(userId)), [api, adopt]);
  const createGroup = useCallback(
    async (input: { name: string; visibility: Visibility; inviteeIds: string[] }) => adopt(await api.createGroup(input)), [api, adopt]);
  const joinGroup = useCallback(async (roomId: string) => adopt(await api.joinGroup(roomId)), [api, adopt]);
  const acceptInvite = useCallback(async (inviteId: string) => {
    const room = await api.acceptInvite(inviteId);
    setInvites((prev) => prev.filter((i) => i.id !== inviteId));
    if (room) adopt(room);
  }, [api, adopt]);
  const declineInvite = useCallback(async (inviteId: string) => {
    await api.declineInvite(inviteId);
    setInvites((prev) => prev.filter((i) => i.id !== inviteId));
  }, [api]);
  const leaveGroup = useCallback(async (roomId: string) => {
    await api.leaveGroup(roomId);
    setRooms((prev) => prev.filter((r) => r.id !== roomId));
    setActiveId((cur) => (cur === roomId ? null : cur));
  }, [api]);
  const inviteUsers = useCallback((roomId: string, userIds: string[]) => api.invite(roomId, userIds), [api]);

  return {
    rooms, invites, activeId, messages, typing, toasts, connected,
    selectRoom, sendText, notifyTyping, openDirect, createGroup, joinGroup, leaveGroup, inviteUsers,
    acceptInvite, declineInvite, dismissToast,
  };
}
