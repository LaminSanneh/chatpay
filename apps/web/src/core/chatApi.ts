import { request, type TokenProvider } from './http';
import type { InviteView, Message, RoomSummary, RoomView, UserProfile, Visibility } from './types';

export class ChatApi {
  constructor(private baseUrl: string, private getToken: TokenProvider) {}
  private r<T>(path: string, init?: RequestInit) { return request<T>(`${this.baseUrl}/api${path}`, this.getToken, init); }
  private post<T>(path: string, body?: unknown) { return this.r<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }); }

  me() { return this.r<UserProfile>('/me'); }
  searchUsers(q: string) { return this.r<UserProfile[]>(`/users?q=${encodeURIComponent(q)}`); }

  listRooms() { return this.r<RoomView[]>('/rooms'); }
  publicRooms(q = '') { return this.r<RoomSummary[]>(`/rooms/public?q=${encodeURIComponent(q)}`); }
  createGroup(input: { name: string; visibility: Visibility; inviteeIds: string[] }) { return this.post<RoomView>('/rooms', input); }
  openDirect(userId: string) { return this.post<RoomView>('/rooms/direct', { userId }); }
  joinGroup(roomId: string) { return this.post<RoomView>(`/rooms/${roomId}/join`); }
  leaveGroup(roomId: string) { return this.post<void>(`/rooms/${roomId}/leave`); }
  invite(roomId: string, userIds: string[]) { return this.post<{ invited: number }>(`/rooms/${roomId}/invites`, { userIds }); }

  history(roomId: string, before?: number) {
    return this.r<Message[]>(`/rooms/${roomId}/messages${before ? `?before=${before}` : ''}`);
  }
  markRead(roomId: string, upTo?: number) { return this.post<void>(`/rooms/${roomId}/read`, upTo === undefined ? {} : { upTo }); }

  invites() { return this.r<InviteView[]>('/invites'); }
  acceptInvite(id: string) { return this.post<RoomView>(`/invites/${id}/accept`); }
  declineInvite(id: string) { return this.post<void>(`/invites/${id}/decline`); }
}
