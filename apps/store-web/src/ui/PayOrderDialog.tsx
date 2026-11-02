'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '@/core/http';
import { formatMinor } from '@/core/money';
import type { TransferIntent } from '@/core/types';
import { isDefinitiveRejection, type WalletApi } from '@/core/walletApi';

/**
 * Review and confirm a payment that the STORE BACKEND created for an order (server-computed price).
 * The numbers shown come from the wallet, never from the page. Same recovery rules as person-to-person payments:
 * confirming twice cannot pay twice, and if a response is lost we ask the server what happened instead of guessing.
 * (Duplicated in apps/web until the shared client package exists. See CHECKLIST.)
 */
export function PayOrderDialog({ api, intentId, title, details, onPaid, onClose, onCancelled }: {
  api: WalletApi; intentId: string; title: string; details?: ReactNode;
  onPaid: () => void; onClose: () => void; onCancelled?: () => void;
}) {
  const [intent, setIntent] = useState<TransferIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    api.getIntent(intentId)
      .then((i) => {
        if (cancelled) return;
        if (i.status === 'COMPLETED') { onPaid(); return; }
        setIntent(i);
        if (i.status !== 'CREATED') setError(`This payment is ${i.status.toLowerCase()}.`);
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [api, intentId]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const remaining = intent ? Math.max(0, Math.floor((Date.parse(intent.expiresAt) - now) / 1000)) : 0;
  const usable = intent?.status === 'CREATED' && remaining > 0;

  async function confirm() {
    setBusy(true); setError(null);
    try {
      await api.confirmIntent(intentId);                       // 200 only when COMPLETED
      onPaid();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code.startsWith('INTENT_')) {
        setError(e.code === 'INTENT_EXPIRED' ? 'This payment expired. Please start again.' : 'This payment was cancelled.');
      } else if (isDefinitiveRejection(e)) {
        setError(e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS'
          ? 'Not enough money in your wallet. Add funds, then confirm again.' : (e as Error).message);
      } else {
        await resolveUnknown();                                // network/5xx: ask the server, do not guess
      }
    } finally { setBusy(false); }
  }

  async function resolveUnknown() {
    try {
      const fresh = await api.getIntent(intentId);
      if (fresh.status === 'COMPLETED') { onPaid(); return; }
      setIntent(fresh);
      setError(fresh.status === 'CREATED' ? 'We could not complete the payment. You have not been charged. You can try again.' : `This payment is ${fresh.status.toLowerCase()}.`);
    } catch {
      setError('Cannot reach the server, so we do not know if the payment went through. Confirming again is safe and cannot pay twice.');
    }
  }

  async function cancel() {
    setBusy(true); setError(null);
    try { await api.cancelIntent(intentId); onCancelled?.(); onClose(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {!intent && !error && <p className="muted">Loading…</p>}
        {intent && (
          <div className="review">
            <div className="review-amount">{formatMinor(intent.amountMinor, intent.currency)}</div>
            {details}
            <div className="muted">{usable ? `Pay within ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Expired'}</div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={onClose} disabled={busy}>Close</button>
          {intent && intent.status === 'CREATED' && <button onClick={() => void cancel()} disabled={busy}>Cancel payment</button>}
          {usable && <button className="primary" onClick={() => void confirm()} disabled={busy}>{busy ? 'Paying…' : 'Confirm & pay'}</button>}
        </div>
      </div>
    </div>
  );
}
