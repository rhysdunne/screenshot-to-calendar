import {
  EVENT_CATEGORIES,
  ExtractParseError,
  type EventCategory,
  type ExtractedEvent,
} from './types.js';
import { isValidHm, isValidYmd } from './dates.js';
import { sanitizeText, sanitizeUrl, type Finding, type SanitizeResult } from './sanitize.js';

// Minimal shape of an Anthropic Messages API response we parse from.
interface AnthropicResponseLike {
  content?: Array<{ type: string; text?: string }>;
}

/**
 * Pull the JSON event object out of an Anthropic response. Structured outputs
 * make this a plain JSON.parse in the happy path, but the markdown-fence
 * stripping is kept so eval candidate models without structured-output
 * support still parse (port of the v1 extractEventData).
 */
export function extractEventData(response: AnthropicResponseLike): ExtractedEvent {
  return extractEventDataWithFindings(response).event;
}

/**
 * As `extractEventData`, but also reports what sanitisation had to change.
 * Handlers use the findings to route suspicious captures to human review; the
 * eval harness uses the plain form above.
 */
export function extractEventDataWithFindings(
  response: AnthropicResponseLike,
): SanitizeResult {
  if (!response.content || !Array.isArray(response.content)) {
    throw new Error('Unexpected API response structure');
  }
  const rawText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Deliberately does NOT carry the raw model text: this message reaches
    // `capture.error` and is rendered in the iOS app, which would hand an
    // injected payload a direct channel to the user. The raw output is still
    // persisted separately (and privately) as `rawModelOutput` for debugging.
    throw new ExtractParseError({ cause: e });
  }
  return normalizeEventDataWithFindings(parsed);
}

/**
 * Validate and coerce a parsed object into a well-formed ExtractedEvent.
 * Malformed dates/times become null rather than propagating garbage into
 * calendar mapping; unknown confidence degrades to 'low'.
 */
export function normalizeEventData(raw: unknown): ExtractedEvent {
  return normalizeEventDataWithFindings(raw).event;
}

/**
 * As `normalizeEventData`, but reports what sanitisation changed. Free-text
 * fields are bounded and stripped of control/invisible characters here; `url`
 * is held to an http(s)-only policy. Dates, times and enums keep their existing
 * strict handling.
 */
export function normalizeEventDataWithFindings(raw: unknown): SanitizeResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Extracted event is not an object');
  }
  const o = raw as Record<string, unknown>;
  const findings: Finding[] = [];
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  const date = (v: unknown): string | null => (isValidYmd(str(v)) ? (str(v) as string) : null);
  const time = (v: unknown): string | null => (isValidHm(str(v)) ? (str(v) as string) : null);
  const confidence =
    o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low'
      ? o.confidence
      : 'low';

  const category = EVENT_CATEGORIES.includes(o.category as EventCategory)
    ? (o.category as EventCategory)
    : null;

  const event: ExtractedEvent = {
    title: sanitizeText(o.title, 'title', findings),
    venue: sanitizeText(o.venue, 'venue', findings),
    address: sanitizeText(o.address, 'address', findings),
    start_date: date(o.start_date),
    end_date: date(o.end_date),
    start_time: time(o.start_time),
    end_time: time(o.end_time),
    description: sanitizeText(o.description, 'description', findings),
    url: sanitizeUrl(o.url, findings),
    confidence,
    // v3 fields: present-but-null on v2 responses is fine downstream.
    price: sanitizeText(o.price, 'price', findings),
    category,
  };
  return { event, findings };
}
