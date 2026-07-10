import { EVENT_CATEGORIES, type EventCategory, type ExtractedEvent } from './types.js';
import { isValidHm, isValidYmd } from './dates.js';

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
    throw new Error(
      `Failed to parse event JSON: ${(e as Error).message}\nRaw response: ${rawText}`,
      { cause: e },
    );
  }
  return normalizeEventData(parsed);
}

/**
 * Validate and coerce a parsed object into a well-formed ExtractedEvent.
 * Malformed dates/times become null rather than propagating garbage into
 * calendar mapping; unknown confidence degrades to 'low'.
 */
export function normalizeEventData(raw: unknown): ExtractedEvent {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Extracted event is not an object');
  }
  const o = raw as Record<string, unknown>;
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

  return {
    title: str(o.title),
    venue: str(o.venue),
    address: str(o.address),
    start_date: date(o.start_date),
    end_date: date(o.end_date),
    start_time: time(o.start_time),
    end_time: time(o.end_time),
    description: str(o.description),
    url: str(o.url),
    confidence,
    // v3 fields: present-but-null on v2 responses is fine downstream.
    price: str(o.price),
    category,
  };
}
