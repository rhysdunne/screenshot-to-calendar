// API Gateway HTTP API (payload v2) helpers: JSON responses, body parsing,
// and JWT authentication. Revocation works by comparing the token's `ver`
// claim against the user's current tokenVersion — bumping the version (sign
// out everywhere, account deletion) invalidates all outstanding tokens.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { getSecret } from './config.js';
import { TokenError, verifySession } from './jwt.js';
import type { UserRecord } from './ddb.js';
import { logger, safeError } from './logger.js';

interface UserLookup {
  getUser(userId: string): Promise<UserRecord | null>;
}

/**
 * The shape of every API route handler: one event in, a response promise out.
 * Not `APIGatewayProxyHandlerV2`, which also allows the (event, context,
 * callback) form that the Node.js 24 Lambda runtime no longer supports.
 */
export type ApiHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

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
  // Anything else is a bug or an upstream failure, and was invisible until
  // logged here. safeError keeps the class name and code but drops the
  // message, so the upstream HTTP status (Google's, on a GoogleCalendarError)
  // and Google's machine reason are logged on their own: they tell a 403 from
  // a 503. Read structurally, so this file does not import the Google client.
  const upstream = (typeof e === 'object' && e !== null ? e : {}) as {
    status?: unknown;
    reason?: unknown;
  };
  logger.error('unhandled_error', {
    error: safeError(e),
    ...(typeof upstream.status === 'number' ? { status: upstream.status } : {}),
    ...(typeof upstream.reason === 'string' ? { reason: upstream.reason } : {}),
  });
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
  store: UserLookup,
  secrets: typeof getSecret,
): Promise<UserRecord> {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing bearer token', 'unauthorized');
  }
  const secret = await secrets('jwt-secret');
  const claims = verifySession(header.slice('Bearer '.length), secret);
  const user = await store.getUser(claims.sub);
  if (!user) throw new HttpError(401, 'Unknown user', 'unauthorized');
  if (user.tokenVersion !== claims.ver) {
    throw new HttpError(401, 'Session revoked', 'unauthorized');
  }
  return user;
}
