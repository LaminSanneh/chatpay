'use client';
import type { User } from 'oidc-client-ts';
import { useEffect, useState, type ReactNode } from 'react';
import { userManager } from '@/core/auth';

export function AuthGate({ children }: { children: (user: User) => ReactNode }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'anonymous' } | { status: 'ready'; user: User }>({ status: 'loading' });

  useEffect(() => {
    const um = userManager();
    um.getUser().then((u) => setState(u && !u.expired ? { status: 'ready', user: u } : { status: 'anonymous' }));
    const onLoaded = (u: User) => setState({ status: 'ready', user: u });
    const onUnloaded = () => setState({ status: 'anonymous' });
    um.events.addUserLoaded(onLoaded);
    um.events.addUserUnloaded(onUnloaded);
    return () => { um.events.removeUserLoaded(onLoaded); um.events.removeUserUnloaded(onUnloaded); };
  }, []);

  if (state.status === 'loading') return <p className="center">Loading…</p>;
  if (state.status === 'anonymous') {
    return (
      <div className="center">
        <h1>ChatPay</h1>
        <p>Chat and send money in one place.</p>
        <button className="primary" onClick={() => void userManager().signinRedirect()}>Sign in</button>
        <p className="muted">Dev users: alice / password, bob / password</p>
      </div>
    );
  }
  return <>{children(state.user)}</>;
}
