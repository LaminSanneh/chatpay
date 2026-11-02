'use client';
import { useCallback, useEffect, useState } from 'react';
import { formatMinor } from '@/core/money';
import type { LedgerEntry, Wallet } from '@/core/types';
import type { WalletApi } from '@/core/walletApi';

type Filter = 'all' | 'payments' | 'orders' | 'topups' | 'other';

function categoryOf(e: LedgerEntry): Filter {
  if (e.kind === 'TRANSFER') return 'payments';
  if (e.kind === 'ORDER_PAYMENT' || e.kind === 'SETTLEMENT' || e.kind === 'REFUND') return 'orders';
  if (e.kind === 'TOPUP') return 'topups';
  return 'other';
}

function labelOf(e: LedgerEntry): string {
  const credit = e.direction === 'CREDIT';
  switch (e.kind) {
    case 'TRANSFER': return credit ? 'Received' : 'Sent';
    case 'TOPUP': return 'Top-up';
    case 'ORDER_PAYMENT': return 'Order payment';
    case 'SETTLEMENT': return 'Sale proceeds';
    case 'REFUND': return 'Refund';
    case 'REVERSAL': return credit ? 'Payment returned' : 'Payment reversed';
    case 'ADJUSTMENT': return 'Adjustment';
    default: return e.kind;
  }
}

export function TransactionsView({ api, wallet, onBack }: { api: WalletApi; wallet: Wallet | null; onBack: () => void }) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before?: number) => {
    setLoading(true); setError(null);
    try {
      const page = await api.entries(before);
      setEntries((prev) => (before ? [...prev, ...page.items] : page.items));
      setNext(page.nextBefore);
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const shown = entries.filter((e) => filter === 'all' || categoryOf(e) === filter);
  const filters: [Filter, string][] = [['all', 'All'], ['payments', 'Payments'], ['orders', 'Orders'], ['topups', 'Top-ups'], ['other', 'Other']];

  return (
    <div className="main">
      <header className="header">
        <strong>Wallet</strong>
        <button onClick={onBack}>Back to chat</button>
      </header>
      <div className="statement">
        <div className="wallet">
          <div className="muted">Balance</div>
          <div className="balance">{wallet ? formatMinor(wallet.balanceMinor, wallet.currency) : '…'}</div>
        </div>
        <div className="segmented">
          {filters.map(([f, label]) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{label}</button>)}
        </div>
        {error && <p className="error">{error}</p>}
        <table className="entries">
          <tbody>
            {shown.map((e) => (
              <tr key={e.id}>
                <td>
                  <div>{labelOf(e)}</div>
                  <div className="muted">{e.description ?? ''} {new Date(e.createdAt).toLocaleString()}</div>
                </td>
                <td className={`amount ${e.direction === 'CREDIT' ? 'in' : 'out'}`}>
                  {e.direction === 'CREDIT' ? '+' : '−'}{formatMinor(e.amountMinor, e.currency)}
                  {e.balanceAfter !== null && <div className="muted">bal {formatMinor(e.balanceAfter, e.currency)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && shown.length === 0 && <p className="muted">No transactions yet.</p>}
        {next !== null && <button onClick={() => void load(next)} disabled={loading}>{loading ? 'Loading…' : 'Load older'}</button>}
      </div>
    </div>
  );
}
