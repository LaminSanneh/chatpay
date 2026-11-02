import { useCallback, useEffect, useState } from 'react';
import type { WalletApi } from '@/core/walletApi';
import type { Wallet } from '@/core/types';

export function useWallet(api: WalletApi) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setWallet(await api.wallet()); setError(null); } catch (e) { setError((e as Error).message); }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);
  return { wallet, error, refresh };
}
