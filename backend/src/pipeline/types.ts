// Core data shapes shared by the pipeline, handlers, evals, and (mirrored in
// Swift) the iOS app. Changing a field here is an API contract change — update
// docs/architecture.md and ios/Shared/Models.swift together.

/** The JSON object Claude extracts from an event image. */
export interface ExtractedEvent {
  title: string | null;
  venue: string | null;
  address: string | null;
  /** YYYY-MM-DD */
  start_date: string | null;
  /** YYYY-MM-DD */
  end_date: string | null;
  /** HH:MM, 24h */
  start_time: string | null;
  /** HH:MM, 24h */
  end_time: string | null;
  description: string | null;
  url: string | null;
  confidence: 'high' | 'medium' | 'low';
}

/** Fields a user may correct in the app (subset of ExtractedEvent). */
export const CORRECTABLE_FIELDS = [
  'title',
  'venue',
  'address',
  'start_date',
  'end_date',
  'start_time',
  'end_time',
  'description',
  'url',
] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

/** The classification step's output. Categories anticipate the scrapbook pivot. */
export interface Classification {
  category: 'event_poster' | 'event_screenshot' | 'ticket' | 'other_scrapbook' | 'not_useful';
  is_event: boolean;
  confidence: 'high' | 'medium' | 'low';
}

/** Google Calendar API v3 event body (the subset we create). */
export interface CalendarEventInput {
  summary: string;
  description: string;
  location: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
}

export type CaptureStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'duplicate'
  | 'not_event';

/** A calendar event as returned by the Google Calendar list API (subset). */
export interface ExistingCalendarEvent {
  id: string;
  summary?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string };
}

export class NoDateError extends Error {
  constructor() {
    super('No start or end date could be extracted from the image');
    this.name = 'NoDateError';
  }
}
