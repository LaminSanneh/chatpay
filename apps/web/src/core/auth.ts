import { UserManager, type User } from 'oidc-client-ts';
import { config } from './config';

let manager: UserManager | null = null;

/** Browser OIDC (Authorization Code + PKCE, public client). In React Native replace this file
 *  with expo-auth-session / react-native-app-auth; everything else keeps calling getAccessToken(). */
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
