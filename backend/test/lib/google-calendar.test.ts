// Google Calendar error mapping (#38): a grant only a fresh sign-in can fix
// becomes needs_reauth, everything else stays a GoogleCalendarError, and
// Google's own message text never reaches the client.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarError, listWritableCalendars } from '../../src/lib/google-calendar.js';
import { HttpError } from '../../src/lib/http.js';

function stubGoogle(status: number, error: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error }), { status })),
  );
}

async function failure(): Promise<unknown> {
  return listWritableCalendars('access-token').then(
    () => {
      throw new Error('expected the call to fail');
    },
    (e: unknown) => e,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('google-calendar error mapping', () => {
  it('maps a 403 for a missing calendar scope to needs_reauth', async () => {
    stubGoogle(403, {
      code: 403,
      message: 'Request had insufficient authentication scopes.',
      errors: [{ message: 'Insufficient Permission', reason: 'insufficientPermissions' }],
      details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
    });
    const e = await failure();
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ statusCode: 401, code: 'needs_reauth' });
    expect((e as Error).message).toBe('Reconnect your Google account');
  });

  it('recognises the scope reason when only the ErrorInfo detail carries it', async () => {
    stubGoogle(403, {
      code: 403,
      message: 'Request had insufficient authentication scopes.',
      details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
    });
    expect(await failure()).toMatchObject({ statusCode: 401, code: 'needs_reauth' });
  });

  it('maps any Calendar 401 to needs_reauth', async () => {
    stubGoogle(401, { code: 401, message: 'Invalid Credentials' });
    const e = await failure();
    expect(e).toMatchObject({ statusCode: 401, code: 'needs_reauth' });
    expect((e as Error).message).not.toContain('Invalid Credentials');
  });

  it('leaves a rate-limit 403 as a GoogleCalendarError with its reason', async () => {
    stubGoogle(403, {
      code: 403,
      message: 'Rate Limit Exceeded',
      errors: [{ message: 'Rate Limit Exceeded', reason: 'rateLimitExceeded' }],
    });
    const e = await failure();
    expect(e).toBeInstanceOf(GoogleCalendarError);
    expect(e).toMatchObject({ status: 403, reason: 'rateLimitExceeded' });
  });

  it('keeps other failures as GoogleCalendarError with the status', async () => {
    stubGoogle(503, { code: 503, message: 'Backend Error' });
    const e = await failure();
    expect(e).toBeInstanceOf(GoogleCalendarError);
    expect(e).toMatchObject({ status: 503, reason: undefined });
  });
});
