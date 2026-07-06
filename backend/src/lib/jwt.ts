// Minimal HS256 JWT — sign/verify with node:crypto, no dependency. Claims:
// sub (userId), ver (tokenVersion — bumping it on the user record revokes all
// outstanding tokens), iat, exp.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionClaims {
  sub: string;
  ver: number;
  iat: number;
  exp: number;
}

const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signSession(
  userId: string,
  tokenVersion: number,
  secret: string,
  ttlSeconds = 30 * 24 * 3600,
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = { sub: userId, ver: tokenVersion, iat: now, exp: now + ttlSeconds };
  const body = `${HEADER}.${b64url(JSON.stringify(claims))}`;
  return `${body}.${hmac(body, secret)}`;
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

export function verifySession(token: string, secret: string): SessionClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('Malformed token');
  const [header, payload, sig] = parts as [string, string, string];
  const expected = hmac(`${header}.${payload}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new TokenError('Bad signature');

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('Malformed claims');
  }
  if (typeof claims.sub !== 'string' || typeof claims.ver !== 'number') {
    throw new TokenError('Missing claims');
  }
  if (claims.exp < Math.floor(Date.now() / 1000)) throw new TokenError('Token expired');
  return claims;
}
