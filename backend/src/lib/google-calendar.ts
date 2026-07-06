// Thin Google Calendar API v3 client over fetch (no googleapis dependency —
// it's ~50MB and we use five endpoints).
import type { CalendarEventInput, ExistingCalendarEvent } from '../pipeline/types.js';

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
  ) {
    super(message);
    this.name = 'GoogleCalendarError';
  }
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
    const message =
      ((json.error as Record<string, unknown> | undefined)?.message as string) ??
      `HTTP ${res.status}`;
    throw new GoogleCalendarError(`Google Calendar: ${message}`, res.status);
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
