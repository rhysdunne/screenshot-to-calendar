// POST /v1/auth/google — exchange a GoogleSignIn serverAuthCode for an app
// session token, storing the (encrypted) refresh token server-side.
//
// Sign-up is invite-only: a Google account with no user record gets one only
// when its verified email is on the allowlist in Parameter Store
// (/s2c/{stage}/signup-allowlist, managed with scripts/allowlist.sh).
// Existing users always sign in, whatever the list says.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { realDeps, type Deps } from './deps.js';
import { errorResponse, HttpError, json, parseBody, type ApiHandler } from '../lib/http.js';
import { exchangeAuthCode, revokeToken, type GoogleTokens, type IdClaims } from '../lib/google-auth.js';
import { encrypt } from '../lib/crypto.js';
import { signSession } from '../lib/jwt.js';
import type { UserRecord } from '../lib/ddb.js';
import { logger, safeError } from '../lib/logger.js';

interface AuthRequest {
  serverAuthCode: string;
}

/** Lower-cased emails from the allowlist parameter (comma- or newline-separated). */
export function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

/**
 * Why this Google account may not create a user, or null when it may. Fails
 * closed: an unreadable, missing or empty list refuses everyone.
 */
async function signupRefusal(
  deps: Deps,
  claims: IdClaims,
): Promise<'email_unverified' | 'allowlist_unavailable' | 'not_listed' | null> {
  if (!claims.emailVerified) return 'email_unverified';
  let allowlist: Set<string>;
  try {
    allowlist = parseAllowlist(await deps.getParameter('signup-allowlist'));
  } catch (e) {
    logger.warn('signup_allowlist_unavailable', { error: safeError(e) });
    return 'allowlist_unavailable';
  }
  return allowlist.has(claims.email.toLowerCase()) ? null : 'not_listed';
}

/**
 * Revoke the grant Google just issued to an account that gets no user record,
 * so the account is not left with calendar access to this app. Google then
 * asks for consent again on the next sign-in and returns a fresh refresh
 * token. Best-effort, like the revoke on account deletion.
 */
async function revokeUnusedGrant(tokens: GoogleTokens): Promise<void> {
  try {
    await revokeToken(tokens.refreshToken ?? tokens.accessToken);
  } catch (e) {
    logger.warn('google_revoke_failed', { error: safeError(e) });
  }
}

export function makeHandler(deps: Deps): ApiHandler {
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
        const refusal = await signupRefusal(deps, tokens.idClaims);
        if (refusal) {
          // No email in the log: the reason is enough to act on.
          logger.warn('signup_refused', { reason: refusal });
          await revokeUnusedGrant(tokens);
          throw new HttpError(
            403,
            'Sign-up is invite-only. Ask the owner to add your Google account.',
            'signup_closed',
          );
        }
        if (!tokens.refreshToken) {
          // A new user needs a refresh token, or the backend can never act on
          // the calendar. Google leaves it out when this Google account has
          // already granted the app access, for example after an account
          // deletion whose revoke failed. Nothing retries automatically: the
          // app shows this message in its sign-in alert. Revoking the grant
          // here makes Google ask for consent again on the next sign-in, and
          // return a refresh token then.
          await revokeUnusedGrant(tokens);
          throw new HttpError(
            400,
            'Google did not return a refresh token. Sign in again.',
            'no_refresh_token',
          );
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
      logger.error('auth_google_failed', { error: safeError(e) });
      return errorResponse(e);
    }
  };
}

export const handler = (event: APIGatewayProxyEventV2) =>
  makeHandler(realDeps())(event);
