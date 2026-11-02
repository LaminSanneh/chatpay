'use client';
import type { User } from 'oidc-client-ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getAccessToken, userManager } from '@/core/auth';
import { ChatApi } from '@/core/chatApi';
import { config } from '@/core/config';
import { formatMinor } from '@/core/money';
import { StoreApi } from '@/core/storeApi';
import type { Product, RoomSummary, RoomView, StoreOrder, UserProfile } from '@/core/types';
import { WalletApi } from '@/core/walletApi';
import { useChat } from '@/hooks/useChat';
import { useWallet } from '@/hooks/useWallet';
import { InviteDialog, NewGroupDialog } from './GroupDialogs';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { PayOrderDialog } from './PayOrderDialog';
import { ProductsPanel } from './ProductsPanel';
import { SendMoneyDialog } from './SendMoneyDialog';
import { StoreBadge, UserLabel } from './StoreBadge';
import { TransactionsView } from './TransactionsView';

function otherMember(room: RoomView, meId: string) {
  return room.kind === 'direct' ? room.members.find((m) => m.id !== meId) : undefined;
}
function roomTitle(room: RoomView, meId: string) {
  return room.kind === 'group' ? room.name ?? 'Group' : otherMember(room, meId)?.displayName ?? 'Direct chat';
}
function preview(room: RoomView, meId: string) {
  const m = room.lastMessage;
  if (!m) return '';
  if (m.kind === 'payment') return '💸 Payment';
  if (m.kind === 'order') return '🎁 Gift';
  return `${m.senderId === meId ? 'You: ' : ''}${m.text ?? ''}`;
}

export function ChatApp({ user }: { user: User }) {
  const meId = user.profile.sub;
  const chatApi = useMemo(() => new ChatApi(config.chatUrl, getAccessToken), []);
  const walletApi = useMemo(() => new WalletApi(config.walletUrl, getAccessToken), []);
  const storeApi = useMemo(() => new StoreApi(getAccessToken), []);
  const { wallet, error: walletError, refresh } = useWallet(walletApi);
  const chat = useChat(chatApi, config.chatUrl, getAccessToken, meId, refresh);

  const [view, setView] = useState<'chat' | 'wallet'>('chat');
  const [dialog, setDialog] = useState<null | 'newGroup' | 'invite' | 'send'>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<UserProfile[]>([]);
  const [showPublic, setShowPublic] = useState(false);
  const [publicGroups, setPublicGroups] = useState<RoomSummary[]>([]);
  const [hasOpenPayment, setHasOpenPayment] = useState(false);
  const [notifPerm, setNotifPerm] = useState<string>('unsupported');
  const [storeAvailable, setStoreAvailable] = useState(false);
  const [shopOpen, setShopOpen] = useState(false);
  const [buying, setBuying] = useState<{ order: StoreOrder; label: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = chat.rooms.find((r) => r.id === chat.activeId) ?? null;
  const activeMessages = (chat.activeId && chat.messages[chat.activeId]) || [];
  const other = active ? otherMember(active, meId) : undefined;
  const canInvite = !!active && active.kind === 'group' && (active.visibility === 'public' || ['owner', 'admin'].includes(active.roles[meId]));
  const typingNames = active
    ? Object.keys(chat.typing[active.id] ?? {}).filter((id) => id !== meId)
        .map((id) => active.members.find((m) => m.id === id)?.displayName ?? 'Someone')
    : [];

  // The shop is optional: if the store backend is down, the button simply does not appear and chat carries on.
  useEffect(() => { storeApi.hot().then(() => setStoreAvailable(true)).catch(() => setStoreAvailable(false)); }, [storeApi]);

  async function buyProduct(product: Product, forUserId?: string) {
    const order = await storeApi.createOrder({
      items: [{ productId: product.id, quantity: 1 }],
      giftFor: forUserId,
      context: active ? { type: 'chat', roomId: active.id } : undefined,
    });
    setBuying({ order, label: forUserId ? `Gift: ${product.name}` : product.name });
  }

  useEffect(() => { if ('Notification' in window) setNotifPerm(Notification.permission); }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [activeMessages.length, chat.activeId, typingNames.length]);

  useEffect(() => {
    if (!query.trim()) { setFound([]); return; }
    const t = setTimeout(() => chatApi.searchUsers(query).then(setFound).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [query, chatApi]);

  useEffect(() => {
    if (!showPublic) return;
    chatApi.publicRooms().then(setPublicGroups).catch(() => undefined);
  }, [showPublic, chatApi, chat.rooms.length]);

  // Does the server hold an unconfirmed payment for this chat? (survives refreshes and device switches)
  useEffect(() => {
    if (!active || active.kind !== 'direct') { setHasOpenPayment(false); return; }
    let cancelled = false;
    walletApi.openIntents()
      .then((list) => { if (!cancelled) setHasOpenPayment(list.some((i) => i.referenceType === 'chat' && i.referenceId === active.id)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [walletApi, active?.id, active?.kind, dialog]);  // eslint-disable-line react-hooks/exhaustive-deps

  const joinable = publicGroups.filter((g) => !chat.rooms.some((r) => r.id === g.id));
  const totalUnread = chat.rooms.reduce((n, r) => n + r.unreadCount, 0);
  useEffect(() => { document.title = totalUnread > 0 ? `(${totalUnread}) ChatPay` : 'ChatPay'; }, [totalUnread]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="me">
          <strong>{user.profile.name ?? user.profile.preferred_username}</strong>
          <span className={chat.connected ? 'dot on' : 'dot'} title={chat.connected ? 'connected' : 'offline'} />
          <button className="link" onClick={() => void userManager().signoutRedirect()}>Sign out</button>
        </div>

        <div className="wallet">
          <div className="muted">Wallet</div>
          <div className="balance">{wallet ? formatMinor(wallet.balanceMinor, wallet.currency) : walletError ? 'unavailable' : '…'}</div>
          <button className="link" onClick={() => setView('wallet')}>Transactions</button>
          {' · '}
          <button className="link" onClick={() => void walletApi.devTopUp(10000).then(refresh)}>+ D100 test funds (dev)</button>
        </div>

        {notifPerm === 'default' && (
          <button className="link" onClick={() => void Notification.requestPermission().then(setNotifPerm)}>Enable desktop notifications</button>
        )}

        <input placeholder="Find a user to chat with…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {found.map((u) => (
          <button key={u.id} className="item" onClick={() => { void chat.openDirect(u.id); setView('chat'); setQuery(''); }}>
            + <UserLabel user={u} /> <span className="muted">@{u.username}</span>
          </button>
        ))}

        {chat.invites.length > 0 && <div className="section">Invitations</div>}
        {chat.invites.map((inv) => (
          <div key={inv.id} className="invite">
            <div><strong>{inv.room.name ?? 'Group'}</strong> {inv.room.visibility === 'private' ? '🔒' : ''}</div>
            <div className="muted">from {inv.inviter?.displayName ?? 'someone'} · {inv.room.memberCount} members</div>
            <div className="actions">
              <button onClick={() => void chat.declineInvite(inv.id)}>Decline</button>
              <button className="primary" onClick={() => { void chat.acceptInvite(inv.id); setView('chat'); }}>Join</button>
            </div>
          </div>
        ))}

        <div className="section">Chats</div>
        {chat.rooms.map((r) => {
          const unread = r.unreadCount > 0;
          return (
            <button key={r.id} className={`item room ${r.id === chat.activeId && view === 'chat' ? 'active' : ''} ${unread ? 'unread' : ''}`}
              onClick={() => { chat.selectRoom(r.id); setView('chat'); }}>
              <div className="room-line">
                <span className="room-name">
                  {r.kind === 'group' ? (r.visibility === 'private' ? '🔒 ' : '# ') : ''}{roomTitle(r, meId)}
                  {r.kind === 'direct' && otherMember(r, meId) && <StoreBadge user={otherMember(r, meId)!} />}
                </span>
                {r.mentionCount > 0 && <span className="badge mention-badge" title="You were mentioned">@</span>}
                {unread && <span className="badge">{r.unreadCount > 99 ? '99+' : r.unreadCount}</span>}
              </div>
              <div className="muted ellipsis">{preview(r, meId)}</div>
            </button>
          );
        })}

        <div className="side-actions">
          <button onClick={() => setDialog('newGroup')}>+ New group</button>
          <button onClick={() => setShowPublic((v) => !v)}>{showPublic ? 'Hide' : 'Browse'} public groups</button>
        </div>
        {showPublic && (joinable.length === 0
          ? <p className="muted">No public groups to join.</p>
          : joinable.map((g) => (
            <button key={g.id} className="item" onClick={() => { void chat.joinGroup(g.id); setView('chat'); }}>
              Join # {g.name} <span className="muted">({g.memberIds.length})</span>
            </button>
          )))}
      </aside>

      {view === 'wallet' ? (
        <TransactionsView api={walletApi} wallet={wallet} onBack={() => setView('chat')} />
      ) : (
        <main className="main">
          {!active ? (
            <p className="center muted">Select or start a chat</p>
          ) : (
            <>
              <header className="header">
                <div>
                  <strong>
                    {active.kind === 'group' ? (active.visibility === 'private' ? '🔒 ' : '# ') : ''}{roomTitle(active, meId)}
                    {other && <StoreBadge user={other} />}
                  </strong>
                  {active.kind === 'group' && (
                    <div className="muted ellipsis">{active.members.map((m) => m.displayName).join(', ')}</div>
                  )}
                </div>
                <div className="actions">
                  {storeAvailable && <button onClick={() => setShopOpen((v) => !v)}>{shopOpen ? 'Hide shop' : 'Shop'}</button>}
                  {canInvite && <button onClick={() => setDialog('invite')}>Invite</button>}
                  {active.kind === 'group' && (
                    <button onClick={() => { if (confirm('Leave this group?')) void chat.leaveGroup(active.id); }}>Leave</button>
                  )}
                  {/* Money can only be sent in one-to-one chats. */}
                  {other && wallet && (
                    <button className="primary" onClick={() => setDialog('send')}>{hasOpenPayment ? 'Resume payment' : 'Send money'}</button>
                  )}
                </div>
              </header>

              <div className="messages">
                {activeMessages.map((m) => <MessageBubble key={m.id} message={m} meId={meId} members={active.members} />)}
                <div ref={bottomRef} />
              </div>
              <div className="typing">
                {typingNames.length > 0 && `${typingNames.slice(0, 2).join(' and ')}${typingNames.length > 2 ? ' and others' : ''} ${typingNames.length === 1 ? 'is' : 'are'} typing…`}
              </div>
              <Composer key={active.id} members={active.members} meId={meId}
                onSend={(text, mentions) => chat.sendText(active.id, text, mentions)}
                onTyping={() => chat.notifyTyping(active.id)} />

              {dialog === 'send' && other && wallet && (
                <SendMoneyDialog api={walletApi} roomId={active.id} toUserId={other.id} toName={other.displayName}
                  currency={wallet.currency} onClose={() => setDialog(null)} onDone={() => void refresh()} />
              )}
              {dialog === 'invite' && (
                <InviteDialog api={chatApi} existingIds={active.memberIds} onClose={() => setDialog(null)}
                  onInvite={(ids) => chat.inviteUsers(active.id, ids)} />
              )}
            </>
          )}
        </main>
      )}

      {shopOpen && storeAvailable && (
        <ProductsPanel api={storeApi} onClose={() => setShopOpen(false)} onBuy={buyProduct}
          giftTo={other ? { id: other.id, name: other.displayName } : undefined} />
      )}

      {buying?.order.payment.intentId && (
        <PayOrderDialog
          api={walletApi}
          intentId={buying.order.payment.intentId}
          title={`Pay: ${buying.label}`}
          details={<div className="muted">{buying.order.store.name}</div>}
          onPaid={() => { setBuying(null); void refresh(); }}
          onCancelled={() => { void storeApi.cancelOrder(buying.order.id).catch(() => undefined); }}
          onClose={() => setBuying(null)}
        />
      )}

      {dialog === 'newGroup' && (
        <NewGroupDialog api={chatApi} onClose={() => setDialog(null)} onCreate={async (input) => { await chat.createGroup(input); setView('chat'); }} />
      )}

      <div className="toasts">
        {chat.toasts.map((t) => (
          <div key={t.id} className="toast" onClick={() => chat.dismissToast(t.id)}>
            <strong>{t.title}</strong>
            <div>{t.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
