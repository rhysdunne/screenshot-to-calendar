// End-to-end tests for the pipeline orchestrator with all I/O faked but the
// real pipeline code (prompts, extraction, mapping, dedup) in the loop.
import { describe, expect, it } from 'vitest';
import { processCapture } from '../../src/handlers/process-capture.js';
import { makeFakeDeps, testUser } from '../helpers/fake-deps.js';
import { todayInZone } from '../../src/pipeline/dates.js';
import { HttpError } from '../../src/lib/http.js';

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

  it('passes the user timezone to the venue lookup', async () => {
    const fake = makeFakeDeps({ extractResult: GOOD_EXTRACTION });
    await seedCapture(fake);
    await fake.store.updateUser('user-1', {
      settings: { calendarId: 'cal-events', timezone: 'Pacific/Auckland', consentEvalUse: false },
    });
    const lookups: Array<[string, string]> = [];
    fake.deps.resolveVenue = async (_key, venue, timeZone) => {
      lookups.push([venue, timeZone]);
      return null;
    };

    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });

    expect(lookups).toEqual([['Regents Park', 'Pacific/Auckland']]);
  });

  it('a timed-out venue lookup still creates the event, without an address', async () => {
    const fake = makeFakeDeps({ extractResult: GOOD_EXTRACTION });
    await seedCapture(fake);
    fake.deps.resolveVenue = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };

    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });

    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('completed');
    expect(capture?.event?.address).toBeNull();
    expect(fake.insertedEvents).toHaveLength(1);
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

  it('duplicate in the calendar window skips creation and records the match apart from calendarEventId', async () => {
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
    expect(capture?.matchedEventId).toBe('existing-1');
    expect(capture?.matchedCalendarId).toBe('cal-events');
    expect(capture?.eventLink).toBe('https://calendar.google.com/event?eid=existing');
    // Edit and delete act on calendarEventId — it must never name the match.
    expect(capture?.calendarEventId).toBeUndefined();
    expect(capture?.calendarId).toBeUndefined();
    expect(fake.insertedEvents).toHaveLength(0);
    expect(fake.patchedEvents).toHaveLength(0);
  });

  it('a match carrying this capture’s own link is adopted as its event, not a duplicate', async () => {
    // SQS redelivery: the first attempt inserted the event, then died before
    // the DynamoDB update.
    const fake = makeFakeDeps({
      extractResult: GOOD_EXTRACTION,
      existingEvents: [
        {
          id: 'own-event-1',
          summary: 'Frieze London',
          description: 'Art fair\nView capture: https://app.example.com/c/cap-1\n',
          htmlLink: 'https://calendar.google.com/event?eid=own',
          start: { date: '2026-10-14' },
        },
      ],
    });
    await seedCapture(fake);
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });

    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('completed');
    expect(capture?.calendarEventId).toBe('own-event-1');
    expect(capture?.calendarId).toBe('cal-events');
    expect(capture?.eventLink).toBe('https://calendar.google.com/event?eid=own');
    expect(capture?.matchedEventId).toBeUndefined();
    expect(fake.insertedEvents).toHaveLength(0);
    expect(fake.patchedEvents).toMatchObject([
      { calendarId: 'cal-events', eventId: 'own-event-1' },
    ]);
  });

  it('an earlier attempt’s event is adopted even when the re-extraction misses the dedup match', async () => {
    const fake = makeFakeDeps({
      // Second extraction read a different start date, so title dedup alone
      // would only flag a possible duplicate and insert a second copy.
      extractResult: { ...GOOD_EXTRACTION, start_date: '2026-10-15' },
      existingEvents: [
        {
          id: 'own-event-1',
          summary: 'Frieze London',
          description: 'View capture: https://app.example.com/c/cap-1',
          start: { date: '2026-10-14' },
        },
      ],
    });
    await seedCapture(fake);
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });

    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('completed');
    expect(capture?.calendarEventId).toBe('own-event-1');
    expect(capture?.possibleDuplicateOf).toBeUndefined();
    expect(fake.insertedEvents).toHaveLength(0);
    // The stored event now says 15 October, so the calendar is moved to match.
    expect(capture?.event?.start_date).toBe('2026-10-15');
    expect(fake.patchedEvents).toHaveLength(1);
    const patched = fake.patchedEvents[0]!;
    expect(patched.eventId).toBe('own-event-1');
    expect(patched.event.start).toEqual({ date: '2026-10-15' });
    expect(patched.event.description).toContain('View capture: https://app.example.com/c/cap-1');
  });

  it('another capture’s link does not count as this capture’s event', async () => {
    const fake = makeFakeDeps({
      extractResult: GOOD_EXTRACTION,
      existingEvents: [
        {
          id: 'other-capture-event',
          summary: 'Frieze London',
          description: 'View capture: https://app.example.com/c/cap-other',
          start: { date: '2026-10-14' },
        },
      ],
    });
    await seedCapture(fake);
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });

    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('duplicate');
    expect(capture?.matchedEventId).toBe('other-capture-event');
    expect(capture?.calendarEventId).toBeUndefined();
    expect(fake.patchedEvents).toHaveLength(0);
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
    // Kept so the app can show the fields for the user to add a date and approve:
    expect(capture?.event?.title).toBe('Frieze London');
    expect(capture?.classification?.category).toBe('event_poster');
  });

  it('an event that ends before it starts fails terminally and keeps the extraction', async () => {
    const fake = makeFakeDeps({
      extractResult: {
        ...GOOD_EXTRACTION,
        start_date: '2026-10-14',
        end_date: '2026-10-12',
        start_time: '19:00',
        end_time: '22:00',
      },
    });
    await seedCapture(fake);
    // Must NOT throw: Google would reject the same body on every retry.
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('failed');
    expect(capture?.error).toContain('must end after it starts');
    expect(capture?.event?.end_date).toBe('2026-10-12');
    expect(fake.insertedEvents).toHaveLength(0);
  });

  it('a 23:59 start with no end time is created, though its default end clamps to the start', async () => {
    const fake = makeFakeDeps({
      extractResult: { ...GOOD_EXTRACTION, end_date: null, start_time: '23:59', end_time: null },
    });
    await seedCapture(fake);
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('completed');
    expect(fake.insertedEvents[0]!.event.end).toEqual({
      dateTime: '2026-10-14T23:59:00',
      timeZone: 'Europe/London',
    });
  });

  it('a Google grant that needs a fresh sign-in fails terminally and flags the user', async () => {
    const fake = makeFakeDeps({ extractResult: GOOD_EXTRACTION });
    await seedCapture(fake);
    // What lib/google-calendar.ts throws for a 401 or a missing calendar scope:
    fake.deps.calendar.listEventsInWindow = async () => {
      throw new HttpError(401, 'Reconnect your Google account', 'needs_reauth');
    };
    // Must NOT throw: retrying cannot fix the grant.
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('failed');
    expect(capture?.error).toContain('sign in again');
    // Kept so the user can approve it once they have signed in again:
    expect(capture?.event?.title).toBe('Frieze London');
    expect((await fake.store.getUser('user-1'))?.needsReauth).toBe(true);
  });

  it('a refusal at extraction fails terminally and keeps the classification', async () => {
    const fake = makeFakeDeps({ extractResult: GOOD_EXTRACTION, extractStopReason: 'refusal' });
    await seedCapture(fake);
    // Must NOT throw: the same image gets the same refusal on a retry.
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('failed');
    expect(capture?.error).toContain('could not be read automatically');
    expect(capture?.classification?.category).toBe('event_poster');
    expect(capture?.event).toBeUndefined();
    expect(fake.insertedEvents).toHaveLength(0);
  });

  it('a refusal at classification fails terminally before extraction runs', async () => {
    const fake = makeFakeDeps({ classifyStopReason: 'refusal' });
    await seedCapture(fake);
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('failed');
    expect(capture?.error).toContain('could not be read automatically');
    expect(fake.claudeCalls.map((c) => c.stage)).toEqual(['classify']);
    // The refused call was still billed, so it is still in the ledger.
    expect(fake.store.aiCalls).toHaveLength(1);
  });

  it('a reply cut off at max_tokens rethrows for SQS retry', async () => {
    const fake = makeFakeDeps({ extractResult: GOOD_EXTRACTION, extractStopReason: 'max_tokens' });
    await seedCapture(fake);
    await expect(
      processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' }),
    ).rejects.toThrow(/cut off at max_tokens/);
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('failed');
    expect(capture?.event).toBeUndefined();
  });

  it('a parse failure does not copy model text into the user-visible error', async () => {
    const fake = makeFakeDeps();
    await seedCapture(fake);
    const fakeCall = fake.deps.callClaude;
    fake.deps.callClaude = async (options) => {
      const result = await fakeCall(options);
      if (options.stage === 'classify') return result;
      const response = { ...result.response, content: [{ type: 'text', text: 'Sorry, prose' }] };
      return { ...result, response: response as typeof result.response };
    };
    await expect(
      processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' }),
    ).rejects.toThrow(/Failed to parse event JSON/);
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.error).toContain('Failed to parse event JSON');
    expect(capture?.error).not.toContain('Sorry, prose');
    // Still kept, out of the app's view, for debugging.
    expect(capture?.rawModelOutput).toBe('Sorry, prose');
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
    // The retry re-extracts, so nothing half-done is kept for review.
    expect(capture?.event).toBeUndefined();
  });

  it('a retry that succeeds clears the earlier attempt’s error', async () => {
    const fake = makeFakeDeps({ extractResult: GOOD_EXTRACTION });
    await seedCapture(fake);
    const insertEvent = fake.deps.calendar.insertEvent;
    fake.deps.calendar.insertEvent = async () => {
      throw new Error('Google 503');
    };
    await expect(
      processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' }),
    ).rejects.toThrow('Google 503');
    expect((await fake.store.getCapture('user-1', 'cap-1'))?.error).toContain('Google 503');

    fake.deps.calendar.insertEvent = insertEvent;
    await processCapture(fake.deps, { userId: 'user-1', captureId: 'cap-1' });
    const capture = await fake.store.getCapture('user-1', 'cap-1');
    expect(capture?.status).toBe('completed');
    expect(capture?.error).toBeUndefined();
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
