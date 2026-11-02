'use client';
import { useEffect, useState } from 'react';
import { ApiError } from '@/core/http';
import { formatMinor, parseToMinor } from '@/core/money';
import type { TransferIntent } from '@/core/types';
import { isDefinitiveRejection, type WalletApi } from '@/core/walletApi';

type Phase = { kind: 'loading' } | { kind: 'form' } | { kind: 'review'; intent: TransferIntent; resumed: boolean };

/**
 * Payment flow backed by SERVER-ISSUED INTENTS:
 *   form -> [create intent] -> review ("Send D20 to Bob?") -> [confirm] -> done
 * The browser never invents or stores payment identity. If it crashes, refreshes, or you switch device,
 * reopening this dialog asks the server for open intents and resumes the review step. If a confirm's
 * response is lost, we ask the server what happened instead of guessing. Confirming twice cannot pay twice.
 */
export function SendMoneyDialog({ api, roomId, toUserId, toName, currency, onClose, onDone }: {
  api: WalletApi; roomId: string; toUserId: string; toName: string; currency: string;
  onClose: () => void; onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Recovery: is there already an unconfirmed payment to this person in this chat?
  useEffect(() => {
    let cancelled = false;
    api.openIntents()
      .then((list) => {
        if (cancelled) return;
        const mine = list.find((i) => i.referenceType === 'chat' && i.referenceId === roomId && i.toUserId === toUserId);
        setPhase(mine ? { kind: 'review', intent: mine, resumed: true } : { kind: 'form' });
      })
      .catch(() => { if (!cancelled) setPhase({ kind: 'form' }); });
    return () => { cancelled = true; };
  }, [api, roomId, toUserId]);

  // Countdown while reviewing
  useEffect(() => {
    if (phase.kind !== 'review') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase.kind]);

  const minor = parseToMinor(amount);

  async function createIntent() {
    if (!minor) return setError('Enter a valid amount, e.g. 25 or 12.50');
    setBusy(true); setError(null);
    try {
      const intent = await api.createIntent({
        toUserId, amountMinor: minor, note: note.trim() || undefined, reference: { type: 'chat', id: roomId },
      });
      setPhase({ kind: 'review', intent, resumed: false });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  async function confirm(intent: TransferIntent) {
    setBusy(true); setError(null);
    try {
      await api.confirmIntent(intent.id);          // 200 only when COMPLETED
      onDone(); onClose();                         // the payment bubble arrives via the chat socket
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code.startsWith('INTENT_')) {
        setError(e.code === 'INTENT_EXPIRED' ? 'This payment expired. Please start again.' : 'This payment was cancelled.');
        setPhase({ kind: 'form' });
      } else if (isDefinitiveRejection(e)) {
        setError((e as Error).message);            // e.g. insufficient funds: stay here, top up, confirm again
      } else {
        await resolveUnknownOutcome(intent);       // network/5xx: do not guess, ask the server
      }
    } finally { setBusy(false); }
  }

  async function resolveUnknownOutcome(intent: TransferIntent) {
    try {
      const fresh = await api.getIntent(intent.id);
      if (fresh.status === 'COMPLETED') { onDone(); onClose(); return; }
      if (fresh.status === 'CREATED') {
        setPhase({ kind: 'review', intent: fresh, resumed: true });
        setError('We could not complete the payment. You have not been charged. You can try again.');
      } else {
        setPhase({ kind: 'form' });
        setError(`This payment is ${fresh.status.toLowerCase()}. Please start again.`);
      }
    } catch {
      setError('Cannot reach the server, so we do not know if the payment went through. Check the chat for a payment message; confirming again is safe and cannot pay twice.');
    }
  }

  async function cancel(intent: TransferIntent) {
    setBusy(true); setError(null);
    try { await api.cancelIntent(intent.id); setPhase({ kind: 'form' }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const remainingSec = phase.kind === 'review' ? Math.max(0, Math.floor((Date.parse(phase.intent.expiresAt) - now) / 1000)) : 0;
  const mmss = `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, '0')}`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Send money to {toName}</h3>

        {phase.kind === 'loading' && <p className="muted">Checking for an unfinished payment…</p>}

        {phase.kind === 'form' && (
          <>
            <input autoFocus inputMode="decimal" placeholder={`Amount (${currency})`} value={amount}
              disabled={busy} onChange={(e) => setAmount(e.target.value)} />
            <input placeholder="Note (optional)" maxLength={100} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
            {error && <p className="error">{error}</p>}
            <div className="actions">
              <button onClick={onClose} disabled={busy}>Cancel</button>
              <button className="primary" onClick={() => void createIntent()} disabled={busy || !minor}>
                {busy ? 'Please wait…' : 'Review'}
              </button>
            </div>
          </>
        )}

        {phase.kind === 'review' && (
          <>
            {phase.resumed && <p className="notice">You have an unconfirmed payment. Review it and confirm, or cancel it.</p>}
            <div className="review">
              <div className="review-amount">{formatMinor(phase.intent.amountMinor, phase.intent.currency)}</div>
              <div>to <strong>{toName}</strong></div>
              {phase.intent.note && <div className="muted">“{phase.intent.note}”</div>}
              <div className="muted">{remainingSec > 0 ? `Expires in ${mmss}` : 'Expired'}</div>
            </div>
            {error && <p className="error">{error}</p>}
            <div className="actions">
              <button onClick={() => void cancel(phase.intent)} disabled={busy}>Cancel payment</button>
              {remainingSec > 0
                ? <button className="primary" onClick={() => void confirm(phase.intent)} disabled={busy}>{busy ? 'Sending…' : 'Confirm & send'}</button>
                : <button className="primary" onClick={() => { setPhase({ kind: 'form' }); setError(null); }}>Start over</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
