// Port of archive/n8n/nodes/parse-event-data.test.js (9 cases) onto the new
// pipeline modules, plus timezone regression tests the v1 code would fail.
import { describe, expect, it } from 'vitest';
import { extractClassification, extractEventData } from '../../src/pipeline/extract.js';
import { endsAfterStart, mapEventToCalendar } from '../../src/pipeline/map-to-calendar.js';
import type { ExtractedEvent } from '../../src/pipeline/types.js';
import {
  MaxTokensError,
  ModelRefusalError,
  NoDateError,
  TerminalProcessingError,
} from '../../src/pipeline/types.js';
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

describe('mapEventToCalendar (overnight events)', () => {
  // A 22:00–04:00 club night used to end before it started; Google rejects that.
  it('end time earlier than start with no end_date rolls to the next day', () => {
    const result = mapEventToCalendar(
      event({ start_date: '2026-07-11', start_time: '22:00', end_time: '04:00' }),
      OPTS,
    );
    expect(result.start).toEqual({
      dateTime: '2026-07-11T22:00:00',
      timeZone: 'Europe/London',
    });
    expect(result.end).toEqual({
      dateTime: '2026-07-12T04:00:00',
      timeZone: 'Europe/London',
    });
  });

  it('end_date equal to start_date still rolls to the next day', () => {
    const result = mapEventToCalendar(
      event({
        start_date: '2026-07-11',
        end_date: '2026-07-11',
        start_time: '22:00',
        end_time: '04:00',
      }),
      OPTS,
    );
    expect(result.end).toEqual({
      dateTime: '2026-07-12T04:00:00',
      timeZone: 'Europe/London',
    });
  });

  it('explicit later end_date is kept as given', () => {
    const result = mapEventToCalendar(
      event({
        start_date: '2026-07-11',
        end_date: '2026-07-13',
        start_time: '22:00',
        end_time: '04:00',
      }),
      OPTS,
    );
    expect(result.end).toEqual({
      dateTime: '2026-07-13T04:00:00',
      timeZone: 'Europe/London',
    });
  });

  it('equal start and end times stay on the same day', () => {
    const result = mapEventToCalendar(
      event({ start_date: '2026-07-11', start_time: '19:00', end_time: '19:00' }),
      OPTS,
    );
    expect(result.end).toEqual({
      dateTime: '2026-07-11T19:00:00',
      timeZone: 'Europe/London',
    });
  });

  it('rolls across a month end', () => {
    const result = mapEventToCalendar(
      event({ start_date: '2026-10-31', start_time: '23:00', end_time: '02:00' }),
      OPTS,
    );
    expect(result.end).toEqual({
      dateTime: '2026-11-01T02:00:00',
      timeZone: 'Europe/London',
    });
  });

  it('rolls across the autumn DST change (2026-10-25)', () => {
    const result = mapEventToCalendar(
      event({ start_date: '2026-10-24', start_time: '22:00', end_time: '04:00' }),
      OPTS,
    );
    expect(result.end).toEqual({
      dateTime: '2026-10-25T04:00:00',
      timeZone: 'Europe/London',
    });
  });
});

describe('endsAfterStart', () => {
  const ends = (overrides: Partial<ExtractedEvent>) => {
    const e = event(overrides);
    return endsAfterStart(mapEventToCalendar(e, OPTS), e);
  };

  it('accepts a normal timed event, an overnight one and an all-day one', () => {
    expect(ends({ start_date: '2026-07-11', start_time: '19:00', end_time: '22:00' })).toBe(true);
    expect(ends({ start_date: '2026-07-11', start_time: '22:00', end_time: '04:00' })).toBe(true);
    expect(ends({ start_date: '2026-07-11', end_date: '2026-07-11' })).toBe(true);
  });

  it('accepts a 23:59 start with no end time, whose default end clamps to 23:59', () => {
    const e = event({ start_date: '2026-07-11', start_time: '23:59' });
    const body = mapEventToCalendar(e, OPTS);
    expect(body.end).toEqual({ dateTime: '2026-07-11T23:59:00', timeZone: 'Europe/London' });
    expect(body.end).toEqual(body.start);
    expect(endsAfterStart(body, e)).toBe(true);
  });

  it('rejects an end time given equal to the start time', () => {
    expect(ends({ start_date: '2026-07-11', start_time: '19:00', end_time: '19:00' })).toBe(false);
    expect(ends({ start_date: '2026-07-11', start_time: '23:59', end_time: '23:59' })).toBe(false);
  });

  it('rejects a timed end date before the start date', () => {
    expect(
      ends({
        start_date: '2026-07-11',
        end_date: '2026-07-10',
        start_time: '19:00',
        end_time: '22:00',
      }),
    ).toBe(false);
  });

  it('rejects an all-day end date before the start date', () => {
    expect(ends({ start_date: '2026-07-11', end_date: '2026-07-09' })).toBe(false);
    // One day before: the exclusive end lands on the start date. No end time,
    // but only a timed default end may be zero-length.
    expect(ends({ start_date: '2026-07-11', end_date: '2026-07-10' })).toBe(false);
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

  it('keeps the model text out of the parse error, which users see', () => {
    expect(() => extractEventData(wrap('not json at all'))).not.toThrow(/not json at all/);
  });

  it('throws a terminal ModelRefusalError on a refusal, before reading content', () => {
    const refused = { stop_reason: 'refusal', content: [{ type: 'text', text: valid }] };
    expect(() => extractEventData(refused)).toThrow(ModelRefusalError);
    expect(() => extractEventData(refused)).toThrow(TerminalProcessingError);
  });

  it('throws a retryable MaxTokensError when the reply was cut off', () => {
    const cut = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"title": "Gi' }] };
    expect(() => extractEventData(cut)).toThrow(MaxTokensError);
    expect(() => extractEventData(cut)).not.toThrow(TerminalProcessingError);
  });

  it('skips thinking blocks before the JSON', () => {
    const result = extractEventData({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', text: undefined },
        { type: 'text', text: valid },
      ],
    });
    expect(result.title).toBe('Gig');
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

describe('extractClassification', () => {
  const wrap = (text: string, stop_reason = 'end_turn') => ({
    stop_reason,
    content: [{ type: 'text', text }],
  });

  it('parses a structured-output classification', () => {
    const result = extractClassification(
      wrap(JSON.stringify({ category: 'ticket', is_event: true, confidence: 'medium' })),
    );
    expect(result).toEqual({ category: 'ticket', is_event: true, confidence: 'medium' });
  });

  it('strips fences and skips a leading thinking block', () => {
    const result = extractClassification({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking' },
        { type: 'text', text: '```json\n{"category":"event_poster","is_event":true}\n```' },
      ],
    });
    expect(result.category).toBe('event_poster');
    expect(result.is_event).toBe(true);
  });

  it('degrades unknown values to the cautious ones', () => {
    const result = extractClassification(
      wrap(JSON.stringify({ category: 'meme', is_event: 'yes', confidence: 'certain' })),
    );
    expect(result).toEqual({ category: 'not_useful', is_event: false, confidence: 'low' });
  });

  it('throws on a non-JSON body without quoting it', () => {
    expect(() => extractClassification(wrap('I cannot help'))).toThrow(
      /^Failed to parse classification JSON$/,
    );
  });

  it('throws ModelRefusalError on a refusal and MaxTokensError when cut off', () => {
    expect(() => extractClassification(wrap('{}', 'refusal'))).toThrow(ModelRefusalError);
    expect(() => extractClassification(wrap('{"cat', 'max_tokens'))).toThrow(MaxTokensError);
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
