import { UserManager, type User } from 'oidc-client-ts';
import { config } from './config';

let manager: UserManager | null = null;

/** Browser OIDC (Authorization Code + PKCE, public client `store-web`). Same Keycloak realm as the chat app, so a
 *  login there is a login here without a password prompt (Keycloak's own session cookie does the single sign-on). */
export function userManager(): UserManager {
  if (!manager) {
    manager = new UserManager({
      authority: config.issuer,
      client_id: config.clientId,
      redirect_uri: `${window.location.origin}/callback`,
      post_logout_redirect_uri: window.location.origin,
      response_type: 'code',
      scope: 'openid profile',
      automaticSilentRenew: true,
    });
  }
  return manager;
}

export async function getAccessToken(): Promise<string> {
  const um = userManager();
  let user: User | null = await um.getUser();
  if (!user || user.expired) user = await um.signinSilent();
  if (!user) throw new Error('Not authenticated');
  return user.access_token;
}
