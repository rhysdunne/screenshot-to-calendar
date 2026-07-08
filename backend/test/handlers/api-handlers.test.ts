// API handler tests: auth enforcement, capture upload + exact dedup, and the
// corrections flow (records + rate limit + calendar patch).
import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { makeHandler as makeCreateHandler } from '../../src/handlers/captures-create.js';
import { makeHandler as makeUpdateHandler } from '../../src/handlers/captures-update.js';
import { makeGetHandler } from '../../src/handlers/captures-read.js';
import { makeExportHandler, makeDeleteHandler } from '../../src/handlers/account.js';
import { makeFakeDeps, testUser } from '../helpers/fake-deps.js';
import { signSession } from '../../src/lib/jwt.js';
import type { ExtractedEvent } from '../../src/pipeline/types.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

function apiEvent(opts: {
  body?: unknown;
  token?: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
}): APIGatewayProxyEventV2 {
  return {
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    isBase64Encoded: false,
    pathParameters: opts.pathParameters,
    queryStringParameters: opts.queryStringParameters,
  } as unknown as APIGatewayProxyEventV2;
}

async function invoke(
  handler: ReturnType<typeof makeCreateHandler>,
  event: APIGatewayProxyEventV2,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const result = (await handler(event, {} as Context, () => {})) as
    | APIGatewayProxyStructuredResultV2
    | undefined;
  return {
    statusCode: result?.statusCode ?? 0,
    body: JSON.parse(result?.body ?? '{}') as Record<string, unknown>,
  };
}

// The fake getSecret returns `secret-${name}` for jwt-secret.
const JWT_SECRET = 'secret-jwt-secret';

describe('captures-create', () => {
  it('rejects missing auth', async () => {
    const fake = makeFakeDeps();
    const res = await invoke(makeCreateHandler(fake.deps), apiEvent({ body: { imageBase64: PNG_BASE64 } }));
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked session (stale tokenVersion)', async () => {
    const fake = makeFakeDeps();
    await fake.store.putUser(testUser({ tokenVersion: 2 }));
    const staleToken = signSession('user-1', 1, JWT_SECRET);
    const res = await invoke(
      makeCreateHandler(fake.deps),
      apiEvent({ body: { imageBase64: PNG_BASE64 }, token: staleToken }),
    );
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toContain('revoked');
  });

  it('accepts an image, stores it, and queues processing (202)', async () => {
    const fake = makeFakeDeps();
    await fake.store.putUser(testUser());
    const token = signSession('user-1', 1, JWT_SECRET);
    const res = await invoke(
      makeCreateHandler(fake.deps),
      apiEvent({ body: { imageBase64: PNG_BASE64 }, token }),
    );
    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('queued');
    const captureId = res.body.captureId as string;
    const capture = await fake.store.getCapture('user-1', captureId);
    expect(capture?.status).toBe('queued');
    expect(capture?.mediaType).toBe('image/png');
    expect(fake.images.objects.has(capture!.imageKey)).toBe(true);
  });

  it('re-uploading the same image returns the original capture (exact dedup)', async () => {
    const fake = makeFakeDeps();
    await fake.store.putUser(testUser());
    const token = signSession('user-1', 1, JWT_SECRET);
    const first = await invoke(
      makeCreateHandler(fake.deps),
      apiEvent({ body: { imageBase64: PNG_BASE64 }, token }),
    );
    const second = await invoke(
      makeCreateHandler(fake.deps),
      apiEvent({ body: { imageBase64: PNG_BASE64 }, token }),
    );
    expect(second.statusCode).toBe(200);
    expect(second.body.status).toBe('duplicate');
    expect(second.body.duplicateOf).toBe(first.body.captureId);
  });
});

describe('captures-update (corrections)', () => {
  const extracted: ExtractedEvent = {
    title: 'Frieze London',
    venue: 'Regents Park',
    address: null,
    start_date: '2026-10-14',
    end_date: '2026-10-18',
    start_time: null,
    end_time: null,
    description: 'Art fair',
    url: null,
    confidence: 'high',
  };

  async function seed(fake: ReturnType<typeof makeFakeDeps>) {
    await fake.store.putUser(testUser());
    await fake.store.createCapture(
      {
        userId: 'user-1',
        status: 'completed',
        imageKey: 'users/user-1/captures/cap-1.png',
        imageSha256: 's',
        mediaType: 'image/png',
        event: extracted,
        calendarEventId: 'gcal-1',
        calendarId: 'cal-events',
      } as never,
      'cap-1',
    );
    return signSession('user-1', 1, JWT_SECRET);
  }

  it('records corrections, preserves the original event, and patches the calendar', async () => {
    const fake = makeFakeDeps();
    const token = await seed(fake);
    const res = await invoke(
      makeUpdateHandler(fake.deps),
      apiEvent({
        token,
        pathParameters: { id: 'cap-1' },
        body: { start_date: '2026-10-15', title: 'Frieze London 2026' },
      }),
    );
    expect(res.statusCode).toBe(200);

    // Corrections recorded with consent snapshot:
    expect(fake.store.corrections).toHaveLength(2);
    const dateCorrection = fake.store.corrections.find((c) => c.field === 'start_date')!;
    expect(dateCorrection.oldValue).toBe('2026-10-14');
    expect(dateCorrection.newValue).toBe('2026-10-15');
    expect(dateCorrection.consentEvalUse).toBe(true);

    // Original extraction untouched; corrected overlay applied:
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.event?.start_date).toBe('2026-10-14');
    expect(capture?.corrected?.start_date).toBe('2026-10-15');

    // Google Calendar patched:
    expect(fake.patchedEvents).toEqual([{ calendarId: 'cal-events', eventId: 'gcal-1' }]);
  });

  it('no-op updates make no correction records', async () => {
    const fake = makeFakeDeps();
    const token = await seed(fake);
    const res = await invoke(
      makeUpdateHandler(fake.deps),
      apiEvent({ token, pathParameters: { id: 'cap-1' }, body: { title: 'Frieze London' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(fake.store.corrections).toHaveLength(0);
    expect(fake.patchedEvents).toHaveLength(0);
  });

  it('enforces the daily correction rate limit (poisoning defense)', async () => {
    const fake = makeFakeDeps();
    const token = await seed(fake);
    for (let i = 0; i < 20; i++) {
      await fake.store.putCorrection({
        userId: 'user-1',
        captureId: 'cap-1',
        field: 'title',
        oldValue: 'a',
        newValue: `b${i}`,
        imageKey: 'k',
        consentEvalUse: true,
      });
    }
    const res = await invoke(
      makeUpdateHandler(fake.deps),
      apiEvent({ token, pathParameters: { id: 'cap-1' }, body: { title: 'Poisoned' } }),
    );
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('correction_limit');
  });
});

describe('captures-read', () => {
  it('returns 404 for another user’s capture id', async () => {
    const fake = makeFakeDeps();
    await fake.store.putUser(testUser());
    await fake.store.putUser(testUser({ userId: 'user-2', googleSub: 'gsub-2' }));
    await fake.store.createCapture(
      {
        userId: 'user-2',
        status: 'completed',
        imageKey: 'k',
        imageSha256: 's',
        mediaType: 'image/png',
      },
      'cap-owned-by-2',
    );
    const token = signSession('user-1', 1, JWT_SECRET);
    const res = await invoke(
      makeGetHandler(fake.deps),
      apiEvent({ token, pathParameters: { id: 'cap-owned-by-2' } }),
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('account export/delete (GDPR)', () => {
  async function seedUserWithCaptures(fake: ReturnType<typeof makeFakeDeps>) {
    await fake.store.putUser(testUser());
    for (const n of [1, 2]) {
      await fake.store.createCapture(
        {
          userId: 'user-1',
          status: 'completed',
          imageKey: `users/user-1/captures/c${n}.png`,
          imageSha256: `sha-${n}`,
          mediaType: 'image/png',
        },
        `c${n}`,
      );
      fake.images.objects.set(`users/user-1/captures/c${n}.png`, Buffer.from('img'));
    }
  }

  it('export bundles image download URLs and never leaks the refresh token', async () => {
    const fake = makeFakeDeps();
    await seedUserWithCaptures(fake);
    const token = signSession('user-1', 1, JWT_SECRET);

    const res = await invoke(makeExportHandler(fake.deps), apiEvent({ token }));
    expect(res.statusCode).toBe(200);

    const exportKey = [...fake.images.objects.keys()].find((k) => k.startsWith('exports/'));
    const bundle = JSON.parse(fake.images.objects.get(exportKey!)!.toString()) as {
      items: unknown[];
      images: { captureId: string; imageKey: string; downloadUrl: string }[];
    };

    // One download URL per capture image, each a presigned link.
    expect(bundle.images).toHaveLength(2);
    expect(bundle.images.map((i) => i.captureId).sort()).toEqual(['c1', 'c2']);
    for (const img of bundle.images) {
      expect(img.downloadUrl).toContain('signed.example.com');
    }
    // The encrypted refresh token must never appear anywhere in the export.
    expect(JSON.stringify(bundle)).not.toContain('encRefreshToken');
  });

  it('delete removes every S3 object and DynamoDB record for the user', async () => {
    const fake = makeFakeDeps();
    await seedUserWithCaptures(fake);
    const token = signSession('user-1', 1, JWT_SECRET);

    const res = await invoke(makeDeleteHandler(fake.deps), apiEvent({ token }));
    expect(res.statusCode).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect([...fake.images.objects.keys()].some((k) => k.startsWith('users/user-1/'))).toBe(
      false,
    );
    expect(await fake.store.getUser('user-1')).toBeNull();
    expect((await fake.store.listCaptures('user-1')).items).toHaveLength(0);
  });
});
