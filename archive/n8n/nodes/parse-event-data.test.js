// Unit tests for the Parse Event Data node logic.
// Run with `make test` (or `node --test n8n/nodes/`).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractEventData, mapEventToCalendar } = require('./parse-event-data.js');

// --- mapEventToCalendar: date handling ---

test('end date only ("until X") starts today — regression for the 400', () => {
  const today = new Date().toISOString().split('T')[0];
  const ev = mapEventToCalendar({ title: 'X', start_date: null, end_date: '2026-07-30' });
  assert.ok(ev.start, 'start must not be null — null start is what Google rejected with 400');
  assert.equal(ev.start, today);
  assert.equal(ev.end, '2026-07-31'); // all-day end is exclusive, so +1 day
  assert.equal(ev.allDay, 'yes');
});

test('start date only — end defaults to the same day (+1 exclusive)', () => {
  const ev = mapEventToCalendar({ title: 'X', start_date: '2026-07-30', end_date: null });
  assert.equal(ev.start, '2026-07-30');
  assert.equal(ev.end, '2026-07-31');
  assert.equal(ev.allDay, 'yes');
});

test('no dates at all throws instead of emitting a null start', () => {
  assert.throws(
    () => mapEventToCalendar({ title: 'X', start_date: null, end_date: null }),
    /No start or end date/,
  );
});

test('timed event keeps the explicit end time', () => {
  const ev = mapEventToCalendar({
    title: 'X', start_date: '2026-07-30', start_time: '19:00', end_time: '21:30',
  });
  assert.equal(ev.start, '2026-07-30T19:00:00');
  assert.equal(ev.end, '2026-07-30T21:30:00');
  assert.equal(ev.allDay, 'no');
});

test('timed event with no end time defaults to start + 2h', () => {
  const ev = mapEventToCalendar({ title: 'X', start_date: '2026-07-30', start_time: '14:30' });
  assert.equal(ev.end, '2026-07-30T16:30:00');
});

test('late-night start clamps default end to 23:59, never "25:00"', () => {
  const ev = mapEventToCalendar({ title: 'X', start_date: '2026-07-30', start_time: '22:30' });
  assert.equal(ev.end, '2026-07-30T23:59:00');
  const endHour = Number(ev.end.slice(11, 13));
  assert.ok(endHour <= 23, `end hour ${endHour} must be a valid clock value`);
});

// --- extractEventData: response parsing ---

test('strips ```json code fences before parsing', () => {
  const resp = { content: [{ type: 'text', text: '```json\n{"title":"Y","start_date":"2026-01-01"}\n```' }] };
  const ev = extractEventData(resp);
  assert.equal(ev.title, 'Y');
  assert.equal(ev.start_date, '2026-01-01');
});

test('throws a useful error on a non-JSON body', () => {
  const resp = { content: [{ type: 'text', text: 'sorry, I could not read it' }] };
  assert.throws(() => extractEventData(resp), /Failed to parse event JSON/);
});

test('throws on an unexpected response structure', () => {
  assert.throws(() => extractEventData({ foo: 1 }), /Unexpected API response structure/);
});
