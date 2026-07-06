// Google OAuth plumbing. The app sends a serverAuthCode from GoogleSignIn;
// we exchange it (web client id + secret) for tokens, keep the refresh token
// encrypted at rest, and mint short-lived access tokens on demand.
//
// The id_token here comes directly from Google's token endpoint over TLS —
// not from the client — so per Google's guidance we validate claims (iss,
// aud, exp) without re-verifying the signature.

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  idClaims: { sub: string; email: string };
}

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_grant' | 'other' = 'other',
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = String(body.error ?? 'unknown');
    throw new GoogleAuthError(
      `Google token endpoint ${res.status}: ${err}`,
      err === 'invalid_grant' ? 'invalid_grant' : 'other',
    );
  }
  return body;
}

export async function exchangeAuthCode(
  serverAuthCode: string,
  clientId: string,
  clientSecret: string,
): Promise<GoogleTokens> {
  const body = await tokenRequest({
    code: serverAuthCode,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    // Server auth codes from the iOS GoogleSignIn SDK are exchanged without
    // a redirect; Google expects the parameter present but empty.
    redirect_uri: '',
  });

  const idToken = String(body.id_token ?? '');
  const claims = parseIdTokenClaims(idToken, clientId);
  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    idClaims: claims,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const body = await tokenRequest({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });
  return String(body.access_token);
}

export async function revokeToken(refreshToken: string): Promise<void> {
  // Best-effort: Google returns 200 for valid tokens, 400 for already-revoked.
  await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(refreshToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

export function parseIdTokenClaims(
  idToken: string,
  expectedAud: string,
): { sub: string; email: string } {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleAuthError('Malformed id_token');
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'));
  } catch {
    throw new GoogleAuthError('Malformed id_token claims');
  }
  const iss = String(claims.iss ?? '');
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
    throw new GoogleAuthError(`Unexpected id_token issuer: ${iss}`);
  }
  if (claims.aud !== expectedAud) {
    throw new GoogleAuthError('id_token audience mismatch');
  }
  if (typeof claims.exp === 'number' && claims.exp < Date.now() / 1000) {
    throw new GoogleAuthError('id_token expired');
  }
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') {
    throw new GoogleAuthError('id_token missing sub/email');
  }
  return { sub: claims.sub, email: claims.email };
}
