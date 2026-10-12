// Thin Google Calendar API v3 client over fetch (no googleapis dependency —
// it's ~50MB and we use five endpoints).
import type { CalendarEventInput, ExistingCalendarEvent } from '../pipeline/types.js';
import { HttpError } from './http.js';
import { logger } from './logger.js';

const BASE = 'https://www.googleapis.com/calendar/v3';

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
}

export interface CreatedEvent {
  id: string;
  htmlLink: string;
}

export class GoogleCalendarError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Google's machine-readable reason, e.g. rateLimitExceeded. Safe to log. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'GoogleCalendarError';
  }
}

// 403 reasons meaning the grant lacks the calendar scope, as for an account
// that signed in under an older, narrower consent. The legacy errors[] entry
// says insufficientPermissions and the ErrorInfo detail says
// ACCESS_TOKEN_SCOPE_INSUFFICIENT. Rate-limit 403s (rateLimitExceeded,
// userRateLimitExceeded) are not here: they clear without the user.
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);

/** Every machine reason in a Google error body, legacy errors[] first. */
function errorReasons(error: unknown): string[] {
  const body = (typeof error === 'object' && error !== null ? error : {}) as {
    errors?: unknown;
    details?: unknown;
  };
  return [body.errors, body.details]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .map((entry) => (entry as { reason?: unknown } | null)?.reason)
    .filter((reason): reason is string => typeof reason === 'string');
}

async function gfetch<T>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const reasons = errorReasons(json.error);
    // A revoked token, or a grant without the calendar scope: only signing in
    // again fixes either, and needs_reauth is the code that tells the app to
    // ask for that. Google's own message stays out of the response.
    if (res.status === 401 || (res.status === 403 && reasons.some((r) => SCOPE_REASONS.has(r)))) {
      logger.warn('google_calendar_needs_reauth', { status: res.status, reason: reasons[0] });
      throw new HttpError(401, 'Reconnect your Google account', 'needs_reauth');
    }
    const message =
      ((json.error as Record<string, unknown> | undefined)?.message as string) ??
      `HTTP ${res.status}`;
    throw new GoogleCalendarError(`Google Calendar: ${message}`, res.status, reasons[0]);
  }
  return json as T;
}

export async function listWritableCalendars(
  accessToken: string,
): Promise<CalendarListEntry[]> {
  const r = await gfetch<{ items?: CalendarListEntry[] }>(
    accessToken,
    'GET',
    '/users/me/calendarList?minAccessRole=writer&maxResults=250',
  );
  return r.items ?? [];
}

export async function createCalendar(
  accessToken: string,
  summary: string,
  timeZone: string,
): Promise<CalendarListEntry> {
  const r = await gfetch<{ id: string; summary: string }>(accessToken, 'POST', '/calendars', {
    summary,
    timeZone,
  });
  return { id: r.id, summary: r.summary, accessRole: 'owner' };
}

/** Events in [timeMin, timeMax] — the dedup candidate window. */
export async function listEventsInWindow(
  accessToken: string,
  calendarId: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<ExistingCalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    singleEvents: 'true',
    maxResults: '250',
  });
  const r = await gfetch<{ items?: ExistingCalendarEvent[] }>(
    accessToken,
    'GET',
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
  );
  return r.items ?? [];
}

export async function insertEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEventInput,
): Promise<CreatedEvent> {
  return gfetch<CreatedEvent>(
    accessToken,
    'POST',
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    event,
  );
}

export async function patchEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: Partial<CalendarEventInput>,
): Promise<CreatedEvent> {
  return gfetch<CreatedEvent>(
    accessToken,
    'PATCH',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    event,
  );
}

export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  await gfetch<void>(
    accessToken,
    'DELETE',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
}
