import { config } from '@/core/config';
import type { UserProfile } from '@/core/types';

/** Shown next to a user who has a store (fed by store.* events). Links to the store; chat works without it. */
export function StoreBadge({ user }: { user: Pick<UserProfile, 'store'> }) {
  if (!user.store) return null;
  return (
    <a className="store-badge" href={`${config.storeUrl}/stores/${user.store.slug}`} target="_blank" rel="noreferrer"
      title={`Store: ${user.store.name}`} onClick={(e) => e.stopPropagation()}>🏪</a>
  );
}

export function UserLabel({ user }: { user: UserProfile }) {
  return <span>{user.displayName}<StoreBadge user={user} /></span>;
}
