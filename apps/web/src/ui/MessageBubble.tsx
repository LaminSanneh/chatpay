import { formatMinor } from '@/core/money';
import type { Message, UserProfile } from '@/core/types';

function renderWithMentions(text: string, members: UserProfile[], meId: string) {
  return text.split(/(@[\w.-]+)/g).map((part, i) => {
    if (!part.startsWith('@')) return part;
    const member = members.find((m) => m.username === part.slice(1));
    if (!member) return part;
    return <span key={i} className={`mention ${member.id === meId ? 'me' : ''}`}>{part}</span>;
  });
}

export function MessageBubble({ message, meId, members }: { message: Message; meId: string; members: UserProfile[] }) {
  const mine = message.senderId === meId;
  const nameOf = (id: string) => (id === meId ? 'You' : members.find((m) => m.id === id)?.displayName ?? 'Someone');
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (message.kind === 'payment' && message.payment) {
    const p = message.payment;
    return (
      <div className={`row ${mine ? 'mine' : ''}`}>
        <div className="bubble payment">
          <div className="payment-title">{nameOf(p.fromUserId)} sent {nameOf(p.toUserId)}</div>
          <div className="payment-amount">{formatMinor(p.amountMinor, p.currency)}</div>
          {p.note && <div className="payment-note">{p.note}</div>}
          <div className="meta">Payment completed · {time}</div>
        </div>
      </div>
    );
  }

  if (message.kind === 'order' && message.order) {
    const o = message.order;
    return (
      <div className={`row ${mine ? 'mine' : ''}`}>
        <div className="bubble order">
          <div className="order-title">🎁 {nameOf(o.buyerId)} bought {nameOf(o.recipientId)} a gift</div>
          <ul className="order-items">{o.items.map((i, n) => <li key={n}>{i.quantity} × {i.name}</li>)}</ul>
          <div className="muted">From {o.storeName} · {formatMinor(o.totalMinor, o.currency)}</div>
          <div className="meta">{time}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`row ${mine ? 'mine' : ''}`}>
      <div className="bubble">
        {!mine && <div className="sender">{nameOf(message.senderId)}</div>}
        <div>{renderWithMentions(message.text ?? '', members, meId)}</div>
        <div className="meta">{time}</div>
      </div>
    </div>
  );
}
