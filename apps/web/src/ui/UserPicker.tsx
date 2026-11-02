'use client';
import { useEffect, useState } from 'react';
import type { ChatApi } from '@/core/chatApi';
import type { UserProfile } from '@/core/types';
import { UserLabel } from './StoreBadge';

/** Search users and pick several. Used to invite people to a new or existing group. */
export function UserPicker({ api, selected, onChange, excludeIds = [] }: {
  api: ChatApi; selected: UserProfile[]; onChange: (users: UserProfile[]) => void; excludeIds?: string[];
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserProfile[]>([]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api.searchUsers(q).then((r) => { if (!cancelled) setResults(r); }).catch(() => undefined);
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, api]);

  const chosen = new Set(selected.map((u) => u.id));
  const available = results.filter((u) => !chosen.has(u.id) && !excludeIds.includes(u.id));

  return (
    <div className="picker">
      {selected.length > 0 && (
        <div className="chips">
          {selected.map((u) => (
            <button key={u.id} type="button" className="chip" onClick={() => onChange(selected.filter((x) => x.id !== u.id))}>
              {u.displayName} ✕
            </button>
          ))}
        </div>
      )}
      <input placeholder="Search people to invite…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-results">
        {available.map((u) => (
          <button key={u.id} type="button" className="item" onClick={() => onChange([...selected, u])}>
            + <UserLabel user={u} /> <span className="muted">@{u.username}</span>
          </button>
        ))}
        {available.length === 0 && <p className="muted">No one else found.</p>}
      </div>
    </div>
  );
}
