// End-to-end tests for the pipeline orchestrator with all I/O faked but the
// real pipeline code (prompts, extraction, mapping, dedup) in the loop.
import { describe, expect, it } from 'vitest';
import { processCapture } from '../../src/handlers/process-capture.js';
import { makeFakeDeps, testUser } from '../helpers/fake-deps.js';
import { todayInZone } from '../../src/pipeline/dates.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

async function seedCapture(deps: ReturnType<typeof makeFakeDeps>) {
  const { store, images } = deps;
  await store.putUser(testUser());
  const bytes = Buffer.from(PNG_BASE64, 'base64');
  const imageKey = images.captureKey('user-1', 'cap-1', 'png');
  await images.putImage(imageKey, bytes, 'image/png');
  await store.createCapture(
    {
      userId: 'user-1',
      status: 'queued',
      imageKey,
      imageSha256: 'sha-1',
      mediaType: 'image/png',
    },
    'cap-1',
  );
}

const GOOD_EXTRACTION = {
  title: 'Frieze London',
  venue: 'Regents Park',
  address: null,
  start_date: '2026-10-14',
  end_date: '2026-10-18',
  start_time: null,
  end_time: null,
  description: 'Art fair',
  url: 'https://frieze.com',
  confidence: 'high',
};

describe('processCapture', () => {
  it('happy path: classify → extract → places → create event', async () => {
    const fake = makeFakeDeps({ extractResult: GOOD_EXTRACTION });
    await seedCapture(fake);

    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });

    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('completed');
    expect(capture?.calendarEventId).toBe('created-event-1');
    expect(capture?.event?.title).toBe('Frieze London');
    // Places filled the missing address:
    expect(capture?.event?.address).toBe('1 Test St, London');
    expect(capture?.costUsd).toBeGreaterThan(0);
    expect(fake.store.aiCalls).toHaveLength(2);

    const inserted = fake.insertedEvents[0]!;
    expect(inserted.calendarId).toBe('cal-events');
    expect(inserted.event.start).toEqual({ date: '2026-10-14' });
    expect(inserted.event.end).toEqual({ date: '2026-10-19' }); // exclusive
    // Deep link back to the capture is in the calendar description:
    expect(inserted.event.description).toContain('View capture: https://app.example.com/c/cap-1');
  });

  it('timed events carry the user timezone on the calendar body', async () => {
    const fake = makeFakeDeps({
      extractResult: { ...GOOD_EXTRACTION, start_time: '19:30', end_time: '22:00' },
    });
    await seedCapture(fake);
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });
    const inserted = fake.insertedEvents[0]!;
    expect(inserted.event.start).toEqual({
      dateTime: '2026-10-14T19:30:00',
      timeZone: 'Europe/London',
    });
  });

  it('non-event images are kept but skip calendar creation', async () => {
    const fake = makeFakeDeps({
      classifyResult: { category: 'other_scrapbook', is_event: false, confidence: 'high' },
    });
    await seedCapture(fake);
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });

    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('not_event');
    expect(capture?.classification?.category).toBe('other_scrapbook');
    expect(fake.insertedEvents).toHaveLength(0);
    expect(fake.claudeCalls).toHaveLength(1); // no extract call
  });

  it('duplicate in the calendar window skips creation and links the existing event', async () => {
    const fake = makeFakeDeps({
      extractResult: GOOD_EXTRACTION,
      existingEvents: [
        {
          id: 'existing-1',
          summary: 'Frieze London Art Fair',
          htmlLink: 'https://calendar.google.com/event?eid=existing',
          start: { date: '2026-10-14' },
        },
      ],
    });
    await seedCapture(fake);
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });

    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('duplicate');
    expect(capture?.calendarEventId).toBe('existing-1');
    expect(fake.insertedEvents).toHaveLength(0);
  });

  it('similar event on a different date creates but flags possibleDuplicateOf', async () => {
    const fake = makeFakeDeps({
      extractResult: { ...GOOD_EXTRACTION, start_date: '2026-10-15' },
      existingEvents: [
        { id: 'existing-1', summary: 'Frieze London Art Fair', start: { date: '2026-10-14' } },
      ],
    });
    await seedCapture(fake);
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });

    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('completed');
    expect(capture?.possibleDuplicateOf).toBe('existing-1');
    expect(fake.insertedEvents).toHaveLength(1);
  });

  it('no extractable date fails terminally without SQS retry', async () => {
    const fake = makeFakeDeps({
      extractResult: { ...GOOD_EXTRACTION, start_date: null, end_date: null },
    });
    await seedCapture(fake);
    // Must NOT throw — NoDateError is terminal, retrying cannot help.
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('failed');
    expect(capture?.error).toContain('No date');
  });

  it('transient failures mark the capture failed and rethrow for SQS retry', async () => {
    const fake = makeFakeDeps({ extractResult: GOOD_EXTRACTION });
    await seedCapture(fake);
    fake.deps.calendar.insertEvent = async () => {
      throw new Error('Google 503');
    };
    await expect(
      processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' }),
    ).rejects.toThrow('Google 503');
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('failed');
  });

  it('no target calendar selected fails with guidance', async () => {
    const fake = makeFakeDeps({ extractResult: GOOD_EXTRACTION });
    await fake.store.putUser(
      testUser({ settings: { calendarId: null, timezone: 'Europe/London', consentEvalUse: false } }),
    );
    const bytes = Buffer.from(PNG_BASE64, 'base64');
    const imageKey = fake.images.captureKey('user-1', 'cap-1', 'png');
    await fake.images.putImage(imageKey, bytes, 'image/png');
    await fake.store.createCapture(
      { userId: 'user-1', status: 'queued', imageKey, imageSha256: 's', mediaType: 'image/png' },
      'cap-1',
    );
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('failed');
    expect(capture?.error).toContain('pick a calendar');
  });

  it('renders {{TODAY}} in the extraction prompt with the user-timezone date', async () => {
    const fake = makeFakeDeps({ extractResult: GOOD_EXTRACTION });
    await seedCapture(fake);
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });
    const extractCall = fake.claudeCalls.find((c) => c.stage === 'extract')!;
    expect(extractCall.prompt).toContain(todayInZone('Europe/London'));
    expect(extractCall.prompt).not.toContain('{{TODAY}}');
  });
});
