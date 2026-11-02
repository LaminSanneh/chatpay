'use client';
import { useState } from 'react';
import type { ChatApi } from '@/core/chatApi';
import type { UserProfile, Visibility } from '@/core/types';
import { UserPicker } from './UserPicker';

export function NewGroupDialog({ api, onCreate, onClose }: {
  api: ChatApi;
  onCreate: (input: { name: string; visibility: Visibility; inviteeIds: string[] }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [invitees, setInvitees] = useState<UserProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setError(null);
    try { await onCreate({ name, visibility, inviteeIds: invitees.map((u) => u.id) }); onClose(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New group</h3>
        <input autoFocus placeholder="Group name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="segmented">
          <button type="button" className={visibility === 'private' ? 'on' : ''} onClick={() => setVisibility('private')}>🔒 Private</button>
          <button type="button" className={visibility === 'public' ? 'on' : ''} onClick={() => setVisibility('public')}>Public</button>
        </div>
        <p className="muted">{visibility === 'private' ? 'Hidden from search. People join only by invitation.' : 'Listed for everyone. Anyone can join.'}</p>
        <UserPicker api={api} selected={invitees} onChange={setInvitees} />
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {invitees.length ? `Create and invite ${invitees.length}` : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InviteDialog({ api, existingIds, onInvite, onClose }: {
  api: ChatApi; existingIds: string[]; onInvite: (userIds: string[]) => Promise<{ invited: number }>; onClose: () => void;
}) {
  const [picked, setPicked] = useState<UserProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    try {
      const { invited } = await onInvite(picked.map((u) => u.id));
      setMessage(`${invited} invitation${invited === 1 ? '' : 's'} sent.`);
      setPicked([]);
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Invite people</h3>
        <UserPicker api={api} selected={picked} onChange={setPicked} excludeIds={existingIds} />
        {message && <p className="muted">{message}</p>}
        <div className="actions">
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={busy || picked.length === 0} onClick={() => void submit()}>Send invites</button>
        </div>
      </div>
    </div>
  );
}
