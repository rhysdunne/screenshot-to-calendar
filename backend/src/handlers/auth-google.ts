// POST /v1/auth/google — exchange a GoogleSignIn serverAuthCode for an app
// session token, storing the (encrypted) refresh token server-side.
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { realDeps, type Deps } from './deps.js';
import { errorResponse, HttpError, json, parseBody } from '../lib/http.js';
import { exchangeAuthCode } from '../lib/google-auth.js';
import { encrypt } from '../lib/crypto.js';
import { signSession } from '../lib/jwt.js';
import type { UserRecord } from '../lib/ddb.js';
import { logger } from '../lib/logger.js';

interface AuthRequest {
  serverAuthCode: string;
}

export function makeHandler(deps: Deps): APIGatewayProxyHandlerV2 {
  return async (event) => {
    try {
      const { serverAuthCode } = parseBody<AuthRequest>(event);
      if (!serverAuthCode) throw new HttpError(400, 'serverAuthCode is required');

      const clientSecret = await deps.getSecret('google-oauth-client-secret');
      const tokens = await exchangeAuthCode(
        serverAuthCode,
        deps.config.googleClientId,
        clientSecret,
      );

      let user = await deps.store.getUserByGoogleSub(tokens.idClaims.sub);
      const encKey = await deps.getSecret('token-enc-key');

      if (!user) {
        if (!tokens.refreshToken) {
          // First sign-in must yield a refresh token; without it the backend
          // can never act on the calendar. The app retries with consent.
          throw new HttpError(400, 'Google did not return a refresh token', 'no_refresh_token');
        }
        user = {
          userId: ulid(),
          email: tokens.idClaims.email,
          googleSub: tokens.idClaims.sub,
          encRefreshToken: encrypt(tokens.refreshToken, encKey),
          tokenVersion: 1,
          settings: { calendarId: null, timezone: 'Europe/London', consentEvalUse: false },
          createdAt: new Date().toISOString(),
        } satisfies UserRecord;
        await deps.store.putUser(user);
        logger.info('user_created', { userId: user.userId });
      } else {
        const updates: Partial<UserRecord> = {
          email: tokens.idClaims.email,
          needsReauth: false,
        };
        if (tokens.refreshToken) {
          updates.encRefreshToken = encrypt(tokens.refreshToken, encKey);
        }
        await deps.store.updateUser(user.userId, updates);
      }

      const jwtSecret = await deps.getSecret('jwt-secret');
      const token = signSession(user.userId, user.tokenVersion, jwtSecret);
      return json(200, {
        token,
        user: {
          id: user.userId,
          email: user.email,
          settings: user.settings,
        },
      });
    } catch (e) {
      logger.error('auth_google_failed', { error: String(e) });
      return errorResponse(e);
    }
  };
}

export const handler: APIGatewayProxyHandlerV2 = (event, context, callback) =>
  makeHandler(realDeps())(event, context, callback);
