'use client';
import { useMemo, useRef, useState } from 'react';
import type { UserProfile } from '@/core/types';

/** Message box with @mention autocomplete. Mentions travel as user ids picked from the list, not parsed from text. */
export function Composer({ members, meId, onSend, onTyping }: {
  members: UserProfile[]; meId: string;
  onSend: (text: string, mentions: string[]) => Promise<void>;
  onTyping: () => void;
}) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const picked = useRef(new Map<string, string>());   // username -> user id
  const inputRef = useRef<HTMLInputElement>(null);

  const trigger = useMemo(() => /(^|\s)@([\w.-]*)$/.exec(text.slice(0, caret)), [text, caret]);
  const suggestions = useMemo(() => {
    if (!trigger) return [];
    const q = trigger[2].toLowerCase();
    return members
      .filter((u) => u.id !== meId && (u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)))
      .slice(0, 5);
  }, [trigger, members, meId]);

  function pick(user: UserProfile) {
    if (!trigger) return;
    const atPos = caret - trigger[2].length - 1;
    const inserted = `@${user.username} `;
    const next = text.slice(0, atPos) + inserted + text.slice(caret);
    picked.current.set(user.username, user.id);
    setText(next);
    setHighlight(0);
    const pos = atPos + inserted.length;
    setCaret(pos);
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(pos, pos); }, 0);
  }

  async function submit() {
    const body = text.trim();
    if (!body) return;
    const mentions = [...picked.current.entries()].filter(([username]) => body.includes(`@${username}`)).map(([, id]) => id);
    setError(null);
    try {
      await onSend(body, mentions);
      setText(''); setCaret(0); picked.current.clear();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="composer-wrap">
      {suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((u, i) => (
            <button key={u.id} type="button" className={`item ${i === highlight ? 'active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(u); }}>
              {u.displayName} <span className="muted">@{u.username}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input ref={inputRef} placeholder="Message (type @ to mention)" value={text}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setHighlight(0); if (e.target.value) onTyping(); }}
          onKeyUp={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (suggestions.length === 0) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => (h + 1) % suggestions.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length); }
            else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(suggestions[highlight]); }
          }} />
        <button className="primary" type="submit">Send</button>
      </form>
    </div>
  );
}
