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
  /** v3 prompt fields — optional so v2 extractions stay valid. */
  price?: string | null;
  category?: EventCategory | null;
}

export const EVENT_CATEGORIES = [
  'exhibition',
  'music',
  'theatre',
  'club_night',
  'food_drink',
  'market',
  'workshop',
  'talk',
  'film',
  'other',
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

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
  | 'not_event'
  /** Low-confidence extraction — awaiting user review/approval in the app. */
  | 'needs_review';

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

/**
 * The model's response was not valid JSON. The message is deliberately fixed
 * and content-free: `capture.error` is surfaced in the iOS app, so echoing the
 * raw response (or a JSON parser's excerpt of it) would let text embedded in a
 * user's image reach the user directly.
 */
export class ExtractParseError extends Error {
  constructor(options?: ErrorOptions) {
    super('Model output was not valid JSON', options);
    this.name = 'ExtractParseError';
  }
}
