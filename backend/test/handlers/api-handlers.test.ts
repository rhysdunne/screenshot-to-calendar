// API handler tests: auth enforcement, capture upload + exact dedup, the
// corrections flow (records + rate limit + calendar patch), and capture delete.
import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { makeHandler as makeCreateHandler } from '../../src/handlers/captures-create.js';
import { makeHandler as makeUpdateHandler } from '../../src/handlers/captures-update.js';
import { makeHandler as makeDeleteCaptureHandler } from '../../src/handlers/captures-delete.js';
import { makeGetHandler } from '../../src/handlers/captures-read.js';
import { makeExportHandler, makeDeleteHandler } from '../../src/handlers/account.js';
import { makeFakeDeps, testUser } from '../helpers/fake-deps.js';
import { signSession } from '../../src/lib/jwt.js';
import type { ExtractedEvent } from '../../src/pipeline/types.js';
import type { CaptureRecord } from '../../src/lib/ddb.js';

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
  const result = (await handler(event)) as APIGatewayProxyStructuredResultV2;
  return {
    statusCode: result.statusCode ?? 0,
    body: JSON.parse(result.body ?? '{}') as Record<string, unknown>,
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

  async function seed(
    fake: ReturnType<typeof makeFakeDeps>,
    overrides: Partial<CaptureRecord> = {},
  ) {
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
        ...overrides,
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
    expect(fake.patchedEvents).toMatchObject([{ calendarId: 'cal-events', eventId: 'gcal-1' }]);
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

  it('clearing a field stores null, so the clear sticks and is not re-recorded', async () => {
    const fake = makeFakeDeps();
    const token = await seed(fake, {
      event: { ...extracted, start_date: '2026-10-14', start_time: '19:30', end_time: '22:00' },
    });
    const clearEndTime = () =>
      invoke(
        makeUpdateHandler(fake.deps),
        apiEvent({ token, pathParameters: { id: 'cap-1' }, body: { end_time: '' } }),
      );

    const res = await clearEndTime();
    expect(res.statusCode).toBe(200);
    // null, not absent: the app reads a present null as "cleared".
    expect(res.body.corrected).toEqual({ end_time: null });
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.corrected).toHaveProperty('end_time', null);
    expect(capture?.event?.end_time).toBe('22:00');
    expect(fake.store.corrections).toHaveLength(1);
    expect(fake.store.corrections[0]).toMatchObject({
      field: 'end_time',
      oldValue: '22:00',
      newValue: null,
    });
    // With no end time the calendar falls back to the start + 2 h default.
    expect(fake.patchedEvents).toHaveLength(1);
    expect(fake.patchedEvents[0]!.event.end).toEqual({
      dateTime: '2026-10-14T21:30:00',
      timeZone: 'Europe/London',
    });

    // Sending the same clear again is a no-op: no new correction, no patch.
    const again = await clearEndTime();
    expect(again.statusCode).toBe(200);
    expect(fake.store.corrections).toHaveLength(1);
    expect(fake.patchedEvents).toHaveLength(1);
  });

  it('a legacy duplicate records the correction but patches nothing', async () => {
    const fake = makeFakeDeps();
    // Written before matchedEventId existed: calendarEventId names the
    // matched event, which belongs to another capture.
    const token = await seed(fake, { status: 'duplicate', calendarEventId: 'someone-elses-event' });
    const res = await invoke(
      makeUpdateHandler(fake.deps),
      apiEvent({ token, pathParameters: { id: 'cap-1' }, body: { title: 'Frieze 2026' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(fake.store.corrections).toHaveLength(1);
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.corrected?.title).toBe('Frieze 2026');
    expect(fake.patchedEvents).toHaveLength(0);
  });

  it('a failed Google patch writes no corrections', async () => {
    const fake = makeFakeDeps();
    const token = await seed(fake);
    fake.deps.calendar.patchEvent = async () => {
      throw new Error('Google 503');
    };
    const res = await invoke(
      makeUpdateHandler(fake.deps),
      apiEvent({ token, pathParameters: { id: 'cap-1' }, body: { title: 'Frieze 2026' } }),
    );
    expect(res.statusCode).toBe(500);
    expect(fake.store.corrections).toHaveLength(0);
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.corrected).toBeUndefined();
  });

  it('rejects a malformed date or time with 400 before writing anything', async () => {
    const fake = makeFakeDeps();
    const token = await seed(fake);
    const malformed = [{ start_date: '14/10/2026' }, { start_date: '2026-02-30' }, { start_time: '7pm' }];
    for (const body of malformed) {
      const res = await invoke(
        makeUpdateHandler(fake.deps),
        apiEvent({ token, pathParameters: { id: 'cap-1' }, body }),
      );
      expect(res.statusCode).toBe(400);
    }
    expect(fake.store.corrections).toHaveLength(0);
    expect(fake.patchedEvents).toHaveLength(0);
  });

  it('rejects an edit that leaves the event ending before it starts (400, no patch)', async () => {
    const fake = makeFakeDeps();
    const token = await seed(fake, {
      event: { ...extracted, end_date: null, start_time: '19:00', end_time: '22:00' },
    });
    const res = await invoke(
      makeUpdateHandler(fake.deps),
      apiEvent({ token, pathParameters: { id: 'cap-1' }, body: { end_date: '2026-10-13' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('invalid_time_range');
    expect(fake.patchedEvents).toHaveLength(0);
    expect(fake.store.corrections).toHaveLength(0);
  });

  it('a capture that failed for ending before it starts takes other edits, then the fix', async () => {
    const fake = makeFakeDeps();
    const token = await seed(fake, {
      status: 'failed',
      calendarEventId: undefined,
      calendarId: undefined,
      event: { ...extracted, end_date: '2026-10-12' },
    });
    const edit = (body: Record<string, string>) =>
      invoke(makeUpdateHandler(fake.deps), apiEvent({ token, pathParameters: { id: 'cap-1' }, body }));

    // A title edit does not touch the timing, so the broken range does not block it.
    expect((await edit({ title: 'Frieze 2026' })).statusCode).toBe(200);
    // A date edit that leaves it broken is refused; the one that fixes it is not.
    expect((await edit({ start_date: '2026-10-13' })).statusCode).toBe(400);
    expect((await edit({ end_date: '2026-10-18' })).statusCode).toBe(200);
    expect(fake.store.corrections.map((c) => c.field)).toEqual(['title', 'end_date']);
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

describe('captures-delete', () => {
  async function seed(fake: ReturnType<typeof makeFakeDeps>, overrides: Partial<CaptureRecord>) {
    await fake.store.putUser(testUser());
    await fake.store.createCapture(
      {
        userId: 'user-1',
        status: 'completed',
        imageKey: 'users/user-1/captures/cap-1.png',
        imageSha256: 'sha-1',
        mediaType: 'image/png',
        ...overrides,
      },
      'cap-1',
    );
    fake.images.objects.set('users/user-1/captures/cap-1.png', Buffer.from('img'));
    return signSession('user-1', 1, JWT_SECRET);
  }

  it('deleteEvent=true on a completed capture deletes the event it created', async () => {
    const fake = makeFakeDeps();
    const token = await seed(fake, { calendarEventId: 'gcal-1', calendarId: 'cal-events' });
    const res = await invoke(
      makeDeleteCaptureHandler(fake.deps),
      apiEvent({
        token,
        pathParameters: { id: 'cap-1' },
        queryStringParameters: { deleteEvent: 'true' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(fake.deletedEvents).toEqual([{ calendarId: 'cal-events', eventId: 'gcal-1' }]);
    expect(await fake.store.getCapture('user-1', 'cap-1')).toBeNull();
    expect(fake.images.objects.has('users/user-1/captures/cap-1.png')).toBe(false);
  });

  it('deleteEvent=true on a legacy duplicate deletes the capture but no event', async () => {
    const fake = makeFakeDeps();
    // Written before matchedEventId existed: calendarEventId names the
    // matched event, which belongs to another capture.
    const token = await seed(fake, {
      status: 'duplicate',
      calendarEventId: 'someone-elses-event',
      calendarId: 'cal-events',
    });
    const res = await invoke(
      makeDeleteCaptureHandler(fake.deps),
      apiEvent({
        token,
        pathParameters: { id: 'cap-1' },
        queryStringParameters: { deleteEvent: 'true' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(fake.deletedEvents).toHaveLength(0);
    expect(await fake.store.getCapture('user-1', 'cap-1')).toBeNull();
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

  async function getCapture(overrides: Partial<CaptureRecord>) {
    const fake = makeFakeDeps();
    await fake.store.putUser(testUser());
    await fake.store.createCapture(
      {
        userId: 'user-1',
        status: 'completed',
        imageKey: 'k',
        imageSha256: 's',
        mediaType: 'image/png',
        ...overrides,
      },
      'cap-1',
    );
    const token = signSession('user-1', 1, JWT_SECRET);
    return invoke(makeGetHandler(fake.deps), apiEvent({ token, pathParameters: { id: 'cap-1' } }));
  }

  it('a completed capture reports the event it created and no match', async () => {
    const res = await getCapture({ calendarEventId: 'gcal-1', calendarId: 'cal-events' });
    expect(res.statusCode).toBe(200);
    expect(res.body.calendarEventId).toBe('gcal-1');
    expect(res.body.matchedEventId).toBeNull();
  });

  it('a duplicate reports its match in matchedEventId, never calendarEventId', async () => {
    const res = await getCapture({
      status: 'duplicate',
      matchedEventId: 'existing-1',
      matchedCalendarId: 'cal-events',
      eventLink: 'https://calendar.google.com/event?eid=existing',
    });
    expect(res.body.calendarEventId).toBeNull();
    expect(res.body.matchedEventId).toBe('existing-1');
    expect(res.body.eventLink).toBe('https://calendar.google.com/event?eid=existing');
  });

  it('a legacy duplicate reports the stored calendarEventId as its match', async () => {
    // Written before matchedEventId existed: calendarEventId names the
    // matched event, which belongs to another capture.
    const res = await getCapture({
      status: 'duplicate',
      calendarEventId: 'someone-elses-event',
      calendarId: 'cal-events',
      eventLink: 'https://calendar.google.com/event?eid=existing',
    });
    expect(res.body.calendarEventId).toBeNull();
    expect(res.body.matchedEventId).toBe('someone-elses-event');
    expect(res.body.eventLink).toBe('https://calendar.google.com/event?eid=existing');
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
