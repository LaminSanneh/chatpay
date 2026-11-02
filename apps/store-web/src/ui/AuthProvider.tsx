'use client';
import type { User } from 'oidc-client-ts';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { userManager } from '@/core/auth';

interface AuthState { user: User | null; ready: boolean; login: () => void; logout: () => void }
const Ctx = createContext<AuthState>({ user: null, ready: false, login: () => {}, logout: () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const um = userManager();
    um.getUser().then((u) => { setUser(u && !u.expired ? u : null); setReady(true); });
    const onLoaded = (u: User) => setUser(u);
    const onUnloaded = () => setUser(null);
    um.events.addUserLoaded(onLoaded);
    um.events.addUserUnloaded(onUnloaded);
    return () => { um.events.removeUserLoaded(onLoaded); um.events.removeUserUnloaded(onUnloaded); };
  }, []);

  const value = useMemo<AuthState>(() => ({
    user, ready,
    login: () => void userManager().signinRedirect({ state: window.location.pathname + window.location.search }),
    logout: () => void userManager().signoutRedirect(),
  }), [user, ready]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
