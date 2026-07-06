// Confidence gating (#2): low-confidence extractions stop at needs_review;
// the approve endpoint creates the event through the same dedup path.
import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { processCapture } from '../../src/handlers/process-capture.js';
import { makeHandler as makeApproveHandler } from '../../src/handlers/captures-approve.js';
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
  const result = (await makeApproveHandler(fake.deps)(event, {} as Context, () => {})) as
    | APIGatewayProxyStructuredResultV2
    | undefined;
  return {
    statusCode: result?.statusCode ?? 0,
    body: JSON.parse(result?.body ?? '{}') as Record<string, unknown>,
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
    expect(fake.insertedEvents).toHaveLength(0);
  });

  it('rejects approval of captures not awaiting review', async () => {
    const fake = makeFakeDeps({
      extractResult: { ...LOW_CONFIDENCE_EXTRACTION, confidence: 'high' },
    });
    await seedProcessedLowConfidence(fake); // completes normally
    const res = await invokeApprove(fake);
    expect(res.statusCode).toBe(409);
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
