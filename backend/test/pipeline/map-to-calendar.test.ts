// Port of archive/n8n/nodes/parse-event-data.test.js (9 cases) onto the new
// pipeline modules, plus timezone regression tests the v1 code would fail.
import { describe, expect, it } from 'vitest';
import { extractEventData } from '../../src/pipeline/extract.js';
import { mapEventToCalendar } from '../../src/pipeline/map-to-calendar.js';
import type { ExtractedEvent } from '../../src/pipeline/types.js';
import { NoDateError } from '../../src/pipeline/types.js';
import { addDays, todayInZone } from '../../src/pipeline/dates.js';

const OPTS = { today: '2026-07-06', timeZone: 'Europe/London' };

function event(overrides: Partial<ExtractedEvent>): ExtractedEvent {
  return {
    title: 'Test Event',
    venue: null,
    address: null,
    start_date: null,
    end_date: null,
    start_time: null,
    end_time: null,
    description: null,
    url: null,
    confidence: 'high',
    ...overrides,
  };
}

describe('mapEventToCalendar (ported v1 cases)', () => {
  it('end-date-only exhibition starts today (the 400 regression)', () => {
    const result = mapEventToCalendar(event({ end_date: '2026-07-30' }), OPTS);
    expect(result.start).toEqual({ date: '2026-07-06' });
    expect(result.end).toEqual({ date: '2026-07-31' }); // exclusive end
  });

  it('start-only all-day event gets exclusive end = start + 1', () => {
    const result = mapEventToCalendar(event({ start_date: '2026-07-12' }), OPTS);
    expect(result.start).toEqual({ date: '2026-07-12' });
    expect(result.end).toEqual({ date: '2026-07-13' });
  });

  it('throws NoDateError when no dates at all', () => {
    expect(() => mapEventToCalendar(event({}), OPTS)).toThrow(NoDateError);
    expect(() => mapEventToCalendar(event({}), OPTS)).toThrow(/No start or end date/);
  });

  it('timed event keeps explicit end time', () => {
    const result = mapEventToCalendar(
      event({ start_date: '2026-07-12', start_time: '19:00', end_time: '21:30' }),
      OPTS,
    );
    expect(result.start).toEqual({
      dateTime: '2026-07-12T19:00:00',
      timeZone: 'Europe/London',
    });
    expect(result.end).toEqual({
      dateTime: '2026-07-12T21:30:00',
      timeZone: 'Europe/London',
    });
  });

  it('timed event without end time defaults to start + 2h', () => {
    const result = mapEventToCalendar(
      event({ start_date: '2026-07-12', start_time: '14:30' }),
      OPTS,
    );
    expect(result.end).toEqual({
      dateTime: '2026-07-12T16:30:00',
      timeZone: 'Europe/London',
    });
  });

  it('late-night start clamps default end to 23:59, never 25:00', () => {
    const result = mapEventToCalendar(
      event({ start_date: '2026-07-12', start_time: '23:00' }),
      OPTS,
    );
    expect(result.end).toEqual({
      dateTime: '2026-07-12T23:59:00',
      timeZone: 'Europe/London',
    });
  });

  it('builds description from parts with confidence footer', () => {
    const result = mapEventToCalendar(
      event({
        start_date: '2026-07-12',
        description: 'A great gig',
        venue: 'The Windmill',
        address: '22 Blenheim Gardens, London SW2 5BZ',
        url: 'https://example.com/tickets',
        price: '£8 adv',
      }),
      { ...OPTS, captureLink: 'https://d123.cloudfront.net/c/abc' },
    );
    expect(result.description).toBe(
      [
        'A great gig',
        'Venue: The Windmill',
        'Address: 22 Blenheim Gardens, London SW2 5BZ',
        'Price: £8 adv',
        'Link: https://example.com/tickets',
        'View capture: https://d123.cloudfront.net/c/abc',
        '\n[Auto-captured · Confidence: high]',
      ].join('\n'),
    );
    expect(result.location).toBe('22 Blenheim Gardens, London SW2 5BZ');
  });
});

describe('extractEventData (ported v1 cases)', () => {
  const wrap = (text: string) => ({ content: [{ type: 'text', text }] });
  const valid = JSON.stringify({
    title: 'Gig',
    start_date: '2026-07-12',
    confidence: 'high',
  });

  it('strips ```json fences before parsing', () => {
    const result = extractEventData(wrap('```json\n' + valid + '\n```'));
    expect(result.title).toBe('Gig');
    expect(result.start_date).toBe('2026-07-12');
  });

  it('throws on non-JSON body', () => {
    expect(() => extractEventData(wrap('not json at all'))).toThrow(
      /Failed to parse event JSON/,
    );
  });

  it('throws on unexpected response structure', () => {
    expect(() => extractEventData({ foo: 1 } as never)).toThrow(
      /Unexpected API response structure/,
    );
  });

  it('normalizes v3 price/category fields; unknown categories become null', () => {
    const result = extractEventData(
      wrap(
        JSON.stringify({
          title: 'X',
          start_date: '2026-08-01',
          price: '£12.50',
          category: 'club_night',
          confidence: 'high',
        }),
      ),
    );
    expect(result.price).toBe('£12.50');
    expect(result.category).toBe('club_night');

    const bad = extractEventData(
      wrap(JSON.stringify({ title: 'X', start_date: '2026-08-01', category: 'rave', confidence: 'high' })),
    );
    expect(bad.category).toBeNull();
  });

  it('normalizes malformed dates/times to null instead of propagating garbage', () => {
    const result = extractEventData(
      wrap(
        JSON.stringify({
          title: 'X',
          start_date: 'next Saturday', // model failed to resolve — must not reach calendar
          start_time: '7pm',
          confidence: 'banana',
        }),
      ),
    );
    expect(result.start_date).toBeNull();
    expect(result.start_time).toBeNull();
    expect(result.confidence).toBe('low');
  });
});

describe('timezone correctness (the v1 UTC bug)', () => {
  it("todayInZone gives London's date at 00:30 BST when UTC is still yesterday", () => {
    // 2026-07-05T23:30:00Z == 2026-07-06T00:30 BST
    const now = new Date('2026-07-05T23:30:00Z');
    expect(todayInZone('Europe/London', now)).toBe('2026-07-06');
    // The old code would have said 2026-07-05:
    expect(now.toISOString().slice(0, 10)).toBe('2026-07-05');
  });

  it('addDays crosses the spring DST boundary without skipping (2026-03-29)', () => {
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
  });

  it('addDays crosses the autumn DST boundary without repeating (2026-10-25)', () => {
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
  });

  it('addDays handles month and year rollover', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
