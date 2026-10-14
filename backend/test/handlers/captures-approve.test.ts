// Confidence gating (#2): low-confidence extractions stop at needs_review;
// the approve endpoint creates the event through the same dedup path. It also
// accepts a stalled capture that kept an event (#122).
import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { processCapture } from '../../src/handlers/process-capture.js';
import { makeHandler as makeApproveHandler } from '../../src/handlers/captures-approve.js';
import { makeHandler as makeUpdateHandler } from '../../src/handlers/captures-update.js';
import { STALLED_ERROR } from '../../src/handlers/captures-read.js';
import { makeFakeDeps, testUser } from '../helpers/fake-deps.js';
import { signSession } from '../../src/lib/jwt.js';
import type { ExtractedEvent } from '../../src/pipeline/types.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';
const JWT_SECRET = 'secret-jwt-secret';

const LOW_CONFIDENCE_EXTRACTION = {
  title: 'Blurry Poster Night',
  venue: null,
  address: null,
  start_date: '2026-08-01',
  end_date: null,
  start_time: null,
  end_time: null,
  description: null,
  url: null,
  confidence: 'low',
};

async function seedProcessedLowConfidence(fake: ReturnType<typeof makeFakeDeps>) {
  await fake.store.putUser(testUser());
  const imageKey = fake.images.captureKey('user-1', 'cap-1', 'png');
  await fake.images.putImage(imageKey, Buffer.from(PNG_BASE64, 'base64'), 'image/png');
  await fake.store.createCapture(
    { userId: 'user-1', status: 'queued', imageKey, imageSha256: 's', mediaType: 'image/png' },
    'cap-1',
  );
  await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });
}

// Stored as processing with an event, last written `minutesOld` minutes ago.
// FakeStore stamps updatedAt with the real clock, so it is moved back here.
async function seedProcessingWithEvent(
  fake: ReturnType<typeof makeFakeDeps>,
  minutesOld: number,
) {
  await fake.store.putUser(testUser());
  await fake.store.createCapture(
    {
      userId: 'user-1',
      status: 'processing',
      imageKey: 'k',
      imageSha256: 's',
      mediaType: 'image/png',
      event: { ...LOW_CONFIDENCE_EXTRACTION, confidence: 'high' } as ExtractedEvent,
    },
    'cap-1',
  );
  fake.store.captures.get('user-1/cap-1')!.updatedAt = new Date(
    Date.now() - minutesOld * 60_000,
  ).toISOString();
}

async function invokeApprove(
  fake: ReturnType<typeof makeFakeDeps>,
  captureId = 'cap-1',
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const token = signSession('user-1', 1, JWT_SECRET);
  const event = {
    headers: { authorization: `Bearer ${token}` },
    pathParameters: { id: captureId },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
  const result = (await makeApproveHandler(fake.deps)(event)) as APIGatewayProxyStructuredResultV2;
  return {
    statusCode: result.statusCode ?? 0,
    body: JSON.parse(result.body ?? '{}') as Record<string, unknown>,
  };
}

async function invokeUpdate(
  fake: ReturnType<typeof makeFakeDeps>,
  body: Record<string, string | null>,
  captureId = 'cap-1',
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const token = signSession('user-1', 1, JWT_SECRET);
  const event = {
    headers: { authorization: `Bearer ${token}` },
    pathParameters: { id: captureId },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
  const result = (await makeUpdateHandler(fake.deps)(event)) as APIGatewayProxyStructuredResultV2;
  return {
    statusCode: result.statusCode ?? 0,
    body: JSON.parse(result.body ?? '{}') as Record<string, unknown>,
  };
}

describe('confidence gating', () => {
  it('low-confidence extraction stops at needs_review without touching the calendar', async () => {
    const fake = makeFakeDeps({ extractResult: LOW_CONFIDENCE_EXTRACTION });
    await seedProcessedLowConfidence(fake);

    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('needs_review');
    expect(capture?.event?.title).toBe('Blurry Poster Night');
    expect(fake.insertedEvents).toHaveLength(0);
    expect(capture?.calendarEventId).toBeUndefined();
  });

  it('approve creates the event with corrections overlaid', async () => {
    const fake = makeFakeDeps({ extractResult: LOW_CONFIDENCE_EXTRACTION });
    await seedProcessedLowConfidence(fake);
    // User fixed the date in the app before approving:
    await fake.store.updateCapture('user-1', 'cap-1', {
      corrected: { start_date: '2026-08-02' } as Partial<ExtractedEvent>,
    });

    const res = await invokeApprove(fake);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(fake.insertedEvents).toHaveLength(1);
    expect(fake.insertedEvents[0]!.event.start).toEqual({ date: '2026-08-02' });

    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.calendarEventId).toBe('created-event-1');
    // Original extraction still preserved (training signal):
    expect(capture?.event?.start_date).toBe('2026-08-01');
  });

  it('approve still runs dedup — a duplicate is linked, not created', async () => {
    const fake = makeFakeDeps({
      extractResult: LOW_CONFIDENCE_EXTRACTION,
      existingEvents: [
        { id: 'existing-9', summary: 'Blurry Poster Night', start: { date: '2026-08-01' } },
      ],
    });
    await seedProcessedLowConfidence(fake);

    const res = await invokeApprove(fake);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('duplicate');
    expect(res.body.matchedEventId).toBe('existing-9');
    expect(res.body.calendarEventId).toBeNull();
    expect(fake.insertedEvents).toHaveLength(0);
  });

  it('a capture that failed for want of a date is approved once the user adds one', async () => {
    const fake = makeFakeDeps({
      extractResult: { ...LOW_CONFIDENCE_EXTRACTION, start_date: null, confidence: 'high' },
    });
    await seedProcessedLowConfidence(fake);
    expect((await fake.store.getCapture('user-1', 'cap-1'))?.status).toBe('failed');
    await fake.store.updateCapture('user-1', 'cap-1', {
      corrected: { start_date: '2026-08-02' } as Partial<ExtractedEvent>,
    });

    const res = await invokeApprove(fake);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.error).toBeNull();
    expect(fake.insertedEvents[0]!.event.start).toEqual({ date: '2026-08-02' });
  });

  it('approve refuses an event that ends before it starts (409, no insert)', async () => {
    const fake = makeFakeDeps({ extractResult: LOW_CONFIDENCE_EXTRACTION });
    await seedProcessedLowConfidence(fake);
    await fake.store.updateCapture('user-1', 'cap-1', {
      corrected: { start_time: '20:00', end_date: '2026-07-31', end_time: '22:00' } as Partial<ExtractedEvent>,
    });

    const res = await invokeApprove(fake);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('must end after it starts');
    expect(fake.insertedEvents).toHaveLength(0);
  });

  it('approve with no target calendar keeps the guidance instead of clearing it', async () => {
    const fake = makeFakeDeps({ extractResult: LOW_CONFIDENCE_EXTRACTION });
    await seedProcessedLowConfidence(fake);
    await fake.store.updateUser('user-1', {
      settings: { calendarId: null, timezone: 'Europe/London', consentEvalUse: false },
    });

    const res = await invokeApprove(fake);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toContain('pick a calendar');
    expect(fake.insertedEvents).toHaveLength(0);
  });

  it('a capture deleted while approve runs is a 404 and is not recreated', async () => {
    const fake = makeFakeDeps({ extractResult: LOW_CONFIDENCE_EXTRACTION });
    await seedProcessedLowConfidence(fake);
    // Deleted from another device while the event was being created.
    const insertEvent = fake.deps.calendar.insertEvent;
    fake.deps.calendar.insertEvent = async (...args) => {
      await fake.store.deleteCapture('user-1', 'cap-1', 's');
      return insertEvent(...args);
    };

    const res = await invokeApprove(fake);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('Capture not found');
    expect(fake.store.captures.size).toBe(0);
  });

  it('a capture deleted just after approve writes it is a 404', async () => {
    const fake = makeFakeDeps({ extractResult: LOW_CONFIDENCE_EXTRACTION });
    await seedProcessedLowConfidence(fake);
    const updateCapture = fake.store.updateCapture.bind(fake.store);
    fake.store.updateCapture = async (userId, captureId, updates) => {
      await updateCapture(userId, captureId, updates);
      await fake.store.deleteCapture(userId, captureId, 's');
    };

    const res = await invokeApprove(fake);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('Capture not found');
  });

  it('rejects approval of captures not awaiting review', async () => {
    const fake = makeFakeDeps({
      extractResult: { ...LOW_CONFIDENCE_EXTRACTION, confidence: 'high' },
    });
    await seedProcessedLowConfidence(fake); // completes normally
    const res = await invokeApprove(fake);
    expect(res.statusCode).toBe(409);
  });

  it('approve still refuses a capture that is processing now', async () => {
    const fake = makeFakeDeps();
    await seedProcessingWithEvent(fake, 1);
    const res = await invokeApprove(fake);
    expect(res.statusCode).toBe(409);
    expect(fake.insertedEvents).toHaveLength(0);
  });

  it('high/medium confidence still auto-creates (no gate)', async () => {
    const fake = makeFakeDeps({
      extractResult: { ...LOW_CONFIDENCE_EXTRACTION, confidence: 'medium' },
    });
    await seedProcessedLowConfidence(fake);
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('completed');
    expect(fake.insertedEvents).toHaveLength(1);
  });
});

describe('stalled captures', () => {
  // An attempt after the capture had already finished (an SQS redelivery, or
  // a redrive) rewrote processing over it and then timed out. The event stays,
  // and captureView reports the capture as failed, so the app offers approve.
  it('approve accepts a stalled capture that has an event', async () => {
    const fake = makeFakeDeps();
    await seedProcessingWithEvent(fake, 11);

    const res = await invokeApprove(fake);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.error).toBeNull();
    expect(fake.insertedEvents).toHaveLength(1);
  });

  it('an edit before approving stores the failure, so the approve that follows is accepted', async () => {
    // The app's approve saves pending edits first. That write refreshes
    // updatedAt, which on its own would make the capture look processing again.
    const fake = makeFakeDeps();
    await seedProcessingWithEvent(fake, 11);

    const patch = await invokeUpdate(fake, { title: 'Frieze Masters' });
    expect(patch.statusCode).toBe(200);
    expect(patch.body.status).toBe('failed');
    expect(patch.body.error).toBe(STALLED_ERROR);
    const stored = await fake.store.getCapture('user-1', 'cap-1');
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe(STALLED_ERROR);

    const res = await invokeApprove(fake);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.error).toBeNull();
    expect(fake.insertedEvents[0]!.event.summary).toBe('Frieze Masters');
  });

  it('an edit to a capture that is processing now leaves its status alone', async () => {
    const fake = makeFakeDeps();
    await seedProcessingWithEvent(fake, 1);

    const patch = await invokeUpdate(fake, { title: 'Frieze Masters' });

    expect(patch.statusCode).toBe(200);
    expect(patch.body.status).toBe('processing');
    const stored = await fake.store.getCapture('user-1', 'cap-1');
    expect(stored?.status).toBe('processing');
    expect(stored?.error).toBeUndefined();
  });
});
