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
import { exchangeAuthCode, type IdClaims } from '../lib/google-auth.js';
import { encrypt } from '../lib/crypto.js';
import { signSession } from '../lib/jwt.js';
import type { UserRecord } from '../lib/ddb.js';
import { logger, safeError } from '../lib/logger.js';

interface AuthRequest {
  serverAuthCode: string;
}

/**
 * The refusal for a sign-in that needs a refresh token but got none. Google
 * leaves the refresh token out when this Google account has already granted
 * the app access, so the user must remove that access in their Google Account
 * to make the next sign-in ask for consent again. The app shows the message in
 * its sign-in alert.
 */
function noRefreshTokenError(): HttpError {
  return new HttpError(
    400,
    'Google did not return a refresh token. Remove the access you gave this app in your Google Account settings, then sign in again.',
    'no_refresh_token',
  );
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
          throw new HttpError(
            403,
            'Sign-up is invite-only. Ask the owner to add your Google account.',
            'signup_closed',
          );
        }
        if (!tokens.refreshToken) {
          // A new user needs a refresh token, or the backend can never act on
          // the calendar. Google leaves it out when this Google account has
          // already granted the app access, for example after a refused
          // sign-up or an account deletion whose revoke failed. Nothing
          // retries automatically. This handler never revokes the grant
          // itself: staging and prod share one OAuth client, so a revoke here
          // would also cut off the refresh token the other stage holds for
          // the same Google account.
          throw noRefreshTokenError();
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
      } else if (tokens.refreshToken) {
        await deps.store.updateUser(user.userId, {
          email: tokens.idClaims.email,
          encRefreshToken: encrypt(tokens.refreshToken, encKey),
          needsReauth: false,
        });
      } else if (user.needsReauth) {
        // The stored refresh token is dead (Google answered invalid_grant, or
        // Calendar refused it), and Google sent no new one. Signing in with
        // the dead token would make Reconnect look successful while the next
        // calendar call fails again, so keep the flag and refuse.
        logger.warn('reauth_without_refresh_token', { userId: user.userId });
        throw noRefreshTokenError();
      } else {
        // Usual for a returning user: Google sends a refresh token only on
        // first consent, and the stored one still works.
        await deps.store.updateUser(user.userId, { email: tokens.idClaims.email });
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
