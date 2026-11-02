import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { TokenVerifier } from '../core/ports';
import type { Identity } from '../core/types';

/**
 * Validates Keycloak (or any OIDC) access tokens: signature via the issuer's JWKS, plus issuer and expiry.
 * The user id is the `sub` claim, the same value the wallet uses as the user's external id.
 */
export class JoseTokenVerifier implements TokenVerifier {
  private readonly jwks;

  constructor(private readonly issuer: string, jwksUri?: string) {
    this.jwks = createRemoteJWKSet(new URL(jwksUri ?? `${issuer}/protocol/openid-connect/certs`));
  }

  async verify(token: string): Promise<Identity> {
    const { payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer });
    if (!payload.sub) throw new Error('token has no subject');
    const username = String(payload.preferred_username ?? payload.sub);
    return { userId: payload.sub, username, displayName: String(payload.name ?? username) };
  }
}
