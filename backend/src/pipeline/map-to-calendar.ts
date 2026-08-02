import type { CalendarEventInput, ExtractedEvent } from './types.js';
import { NoDateError } from './types.js';
import { addDays } from './dates.js';
import { escapeForCalendar, FIELD_LIMITS } from './sanitize.js';

/**
 * Cap on the assembled description. Google allows 8192; this is far above any
 * legitimate poster and keeps calendar clients readable.
 */
const MAX_DESCRIPTION = 2000;

export interface MapOptions {
  /** Today's date (YYYY-MM-DD) in the user's timezone — from todayInZone(). */
  today: string;
  /** IANA timezone for timed events, e.g. Europe/London. */
  timeZone: string;
  /** Deep link back to the capture in the app; appended to the description. */
  captureLink?: string;
}

/**
 * Map an extracted event to a Google Calendar API v3 event body.
 * Port of the v1 mapEventToCalendar with the same rules:
 *  - end-date-only ("until 30 July") → starts today
 *  - no dates at all → NoDateError
 *  - timed event with no end_time → start + 2h, clamped to 23:59
 *  - all-day end date is exclusive → +1 day
 */
export function mapEventToCalendar(
  eventData: ExtractedEvent,
  opts: MapOptions,
): CalendarEventInput {
  // Google Calendar renders the description as a limited HTML subset, so every
  // extracted value is escaped before it is joined in. Values arriving from
  // `normalizeEventData` already have newlines collapsed, which is what stops
  // an injected field from forging one of the `Label: value` lines below.
  const esc = (s: string): string => escapeForCalendar(s);
  const descParts: string[] = [];
  // Provenance leads, so text further down cannot be mistaken for it. (An
  // in-band marker in a free-text field is a UX hint, not a security control —
  // the real defence is stripping the marker from untrusted values upstream.)
  descParts.push(`[Auto-captured · Confidence: ${eventData.confidence || 'unknown'}]\n`);
  if (eventData.description) descParts.push(esc(eventData.description));
  if (eventData.venue) descParts.push(`Venue: ${esc(eventData.venue)}`);
  if (eventData.address) descParts.push(`Address: ${esc(eventData.address)}`);
  if (eventData.price) descParts.push(`Price: ${esc(eventData.price)}`);
  if (eventData.url) descParts.push(`Link: ${esc(eventData.url)}`);
  if (opts.captureLink) descParts.push(`View capture: ${opts.captureLink}`);

  const hasTime = !!eventData.start_time;
  let startDate = eventData.start_date;
  let endDate = eventData.end_date || eventData.start_date;

  // Exhibition posters often show only a closing date ("until 30 July").
  // If we have an end but no start, treat it as running from today.
  if (!startDate && endDate) {
    startDate = opts.today;
  }
  if (!startDate && !endDate) {
    throw new NoDateError();
  }
  if (!endDate) endDate = startDate;

  let start: CalendarEventInput['start'];
  let end: CalendarEventInput['end'];

  if (hasTime) {
    start = { dateTime: `${startDate}T${eventData.start_time}:00`, timeZone: opts.timeZone };
    if (eventData.end_time) {
      end = { dateTime: `${endDate}T${eventData.end_time}:00`, timeZone: opts.timeZone };
    } else {
      // Default to 2 hours after start, clamped within the same day.
      const [sh, sm] = (eventData.start_time as string).split(':').map(Number) as [
        number,
        number,
      ];
      const overflow = sh + 2 > 23;
      const endH = overflow ? 23 : sh + 2;
      const endM = overflow ? 59 : sm;
      end = {
        dateTime: `${startDate}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`,
        timeZone: opts.timeZone,
      };
    }
  } else {
    // Google Calendar all-day end date is exclusive, so add 1 day.
    start = { date: startDate as string };
    end = { date: addDays(endDate as string, 1) };
  }

  // `summary` and `location` are plain-text fields in Google Calendar, so they
  // need bounds but not escaping; the values are already sanitised upstream.
  return {
    summary: (eventData.title || 'Untitled Event').slice(0, FIELD_LIMITS.title),
    description: descParts.join('\n').slice(0, MAX_DESCRIPTION),
    location: (eventData.address || eventData.venue || '').slice(0, FIELD_LIMITS.address),
    start,
    end,
  };
}
