// Sign-in and the invite-only sign-up gate: a new Google account gets a user
// record only when its verified email is on the allowlist, existing users are
// never checked, and every refusal fails closed without logging the email.
// Also the new-user sign-in where Google returns no refresh token.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { makeHandler, parseAllowlist } from '../../src/handlers/auth-google.js';
import { logger } from '../../src/lib/logger.js';
import { makeFakeDeps, testUser } from '../helpers/fake-deps.js';

const CLIENT_ID = 'client-id.apps.googleusercontent.com'; // matches fake-deps config

function idToken(claims: { sub: string; email: string; email_verified: boolean }): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const payload = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  };
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

/** Stub Google's token and revoke endpoints; returns the revoked tokens. */
function stubGoogle(opts: {
  sub?: string;
  email: string;
  emailVerified?: boolean;
  refreshToken?: string | null;
}): string[] {
  const revoked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
        revoked.push(new URL(url).searchParams.get('token') ?? '');
        return new Response('{}', { status: 200 });
      }
      return new Response(
        JSON.stringify({
          access_token: 'access-1',
          ...(opts.refreshToken === null ? {} : { refresh_token: opts.refreshToken ?? 'refresh-1' }),
          id_token: idToken({
            sub: opts.sub ?? 'gsub-new',
            email: opts.email,
            email_verified: opts.emailVerified ?? true,
          }),
        }),
        { status: 200 },
      );
    }),
  );
  return revoked;
}

function signInEvent(): APIGatewayProxyEventV2 {
  return {
    headers: {},
    body: JSON.stringify({ serverAuthCode: 'code-1' }),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

async function signIn(fake: ReturnType<typeof makeFakeDeps>) {
  const result = (await makeHandler(fake.deps)(signInEvent())) as APIGatewayProxyStructuredResultV2;
  return {
    statusCode: result.statusCode ?? 0,
    body: JSON.parse(result.body ?? '{}') as Record<string, unknown>,
  };
}

function silenceLogs() {
  return {
    info: vi.spyOn(logger, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(logger, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(logger, 'error').mockImplementation(() => {}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('auth-google sign-up allowlist', () => {
  it('refuses a new user who is not on the allowlist, revokes the grant, and logs no email', async () => {
    const logs = silenceLogs();
    const revoked = stubGoogle({ email: 'stranger@example.com' });
    const fake = makeFakeDeps({ signupAllowlist: 'owner@example.com' });

    const res = await signIn(fake);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: 'Sign-up is invite-only. Ask the owner to add your Google account.',
      code: 'signup_closed',
    });
    expect(fake.store.users.size).toBe(0);
    expect(revoked).toEqual(['refresh-1']);
    expect(logs.warn).toHaveBeenCalledWith('signup_refused', { reason: 'not_listed' });
    const logged = JSON.stringify([logs.info.mock.calls, logs.warn.mock.calls, logs.error.mock.calls]);
    expect(logged).not.toContain('stranger');
  });

  it('creates a new user whose verified email is on the list, ignoring case and separators', async () => {
    silenceLogs();
    stubGoogle({ email: 'friend@example.com' });
    const fake = makeFakeDeps({ signupAllowlist: 'owner@example.com,\n Friend@Example.com\n' });

    const res = await signIn(fake);

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.token).toBe('string');
    const [user] = [...fake.store.users.values()];
    expect(user?.email).toBe('friend@example.com');
    expect(user?.googleSub).toBe('gsub-new');
  });

  it('never checks the allowlist for an existing user', async () => {
    silenceLogs();
    stubGoogle({ sub: 'gsub-1', email: 'test@example.com' });
    const fake = makeFakeDeps(); // no allowlist parameter at all
    await fake.store.putUser(testUser());
    const getParameter = vi.spyOn(fake.deps, 'getParameter');

    const res = await signIn(fake);

    expect(res.statusCode).toBe(200);
    expect(getParameter).not.toHaveBeenCalled();
  });

  it('refuses new users when the allowlist parameter is missing', async () => {
    const logs = silenceLogs();
    stubGoogle({ email: 'owner@example.com' });
    const fake = makeFakeDeps(); // getParameter throws, as for ParameterNotFound

    const res = await signIn(fake);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('signup_closed');
    expect(fake.store.users.size).toBe(0);
    expect(logs.warn).toHaveBeenCalledWith('signup_refused', { reason: 'allowlist_unavailable' });
  });

  it('refuses new users when the allowlist holds no emails', async () => {
    silenceLogs();
    stubGoogle({ email: 'owner@example.com' });
    const fake = makeFakeDeps({ signupAllowlist: ' , \n' });

    const res = await signIn(fake);

    expect(res.statusCode).toBe(403);
    expect(fake.store.users.size).toBe(0);
  });

  it('refuses a listed email that Google has not verified', async () => {
    const logs = silenceLogs();
    stubGoogle({ email: 'owner@example.com', emailVerified: false });
    const fake = makeFakeDeps({ signupAllowlist: 'owner@example.com' });

    const res = await signIn(fake);

    expect(res.statusCode).toBe(403);
    expect(fake.store.users.size).toBe(0);
    expect(logs.warn).toHaveBeenCalledWith('signup_refused', { reason: 'email_unverified' });
  });
});

describe('auth-google without a refresh token', () => {
  it('refuses a new user, revokes the existing grant so the next sign-in gets one, and says to sign in again', async () => {
    silenceLogs();
    const revoked = stubGoogle({ email: 'owner@example.com', refreshToken: null });
    const fake = makeFakeDeps({ signupAllowlist: 'owner@example.com' });

    const res = await signIn(fake);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Google did not return a refresh token. Sign in again.',
      code: 'no_refresh_token',
    });
    expect(fake.store.users.size).toBe(0);
    expect(revoked).toEqual(['access-1']);
  });

  it('signs an existing user in and keeps their stored refresh token', async () => {
    silenceLogs();
    const revoked = stubGoogle({ sub: 'gsub-1', email: 'test@example.com', refreshToken: null });
    const fake = makeFakeDeps();
    const stored = testUser();
    await fake.store.putUser(stored);

    const res = await signIn(fake);

    expect(res.statusCode).toBe(200);
    expect(fake.store.users.get('user-1')?.encRefreshToken).toEqual(stored.encRefreshToken);
    expect(revoked).toEqual([]);
  });
});

describe('parseAllowlist', () => {
  it('splits on commas and whitespace, lower-cases, and drops blanks', () => {
    expect(parseAllowlist('A@x.com, b@y.com\nc@z.com,,')).toEqual(
      new Set(['a@x.com', 'b@y.com', 'c@z.com']),
    );
    expect(parseAllowlist(' \n , ').size).toBe(0);
  });
});
