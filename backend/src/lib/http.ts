// API Gateway HTTP API (payload v2) helpers: JSON responses, body parsing,
// and JWT authentication. Revocation works by comparing the token's `ver`
// claim against the user's current tokenVersion — bumping the version (sign
// out everywhere, account deletion) invalidates all outstanding tokens.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSecret } from './config.js';
import { TokenError, verifySession } from './jwt.js';
import type { DdbStore, UserRecord } from './ddb.js';

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function errorResponse(e: unknown): APIGatewayProxyResultV2 {
  if (e instanceof HttpError) {
    return json(e.statusCode, { error: e.message, code: e.code });
  }
  if (e instanceof TokenError) {
    return json(401, { error: e.message, code: 'unauthorized' });
  }
  return json(500, { error: 'Internal error' });
}

export function parseBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) throw new HttpError(400, 'Missing request body');
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/**
 * Verify the Bearer token and load the user. Throws HttpError(401) on any
 * failure, including a stale tokenVersion (revoked session).
 */
export async function authenticate(
  event: APIGatewayProxyEventV2,
  store: DdbStore,
): Promise<UserRecord> {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing bearer token', 'unauthorized');
  }
  const secret = await getSecret('jwt-secret');
  const claims = verifySession(header.slice('Bearer '.length), secret);
  const user = await store.getUser(claims.sub);
  if (!user) throw new HttpError(401, 'Unknown user', 'unauthorized');
  if (user.tokenVersion !== claims.ver) {
    throw new HttpError(401, 'Session revoked', 'unauthorized');
  }
  return user;
}
