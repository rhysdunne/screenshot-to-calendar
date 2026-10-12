import {
  EVENT_CATEGORIES,
  MaxTokensError,
  ModelRefusalError,
  type Classification,
  type EventCategory,
  type ExtractedEvent,
} from './types.js';
import { isValidHm, isValidYmd } from './dates.js';

// Minimal shape of an Anthropic Messages API response we parse from.
interface AnthropicResponseLike {
  stop_reason?: string | null;
  content?: Array<{ type: string; text?: string }>;
}

/**
 * Throws when the model did not finish its answer. Checked before reading the
 * content: neither a refusal nor a cut-off reply holds usable JSON, and
 * parsing one only produces a misleading parse error.
 */
function assertModelFinished(
  response: AnthropicResponseLike,
  stage: 'classify' | 'extract',
): void {
  if (response.stop_reason === 'refusal') throw new ModelRefusalError(stage);
  if (response.stop_reason === 'max_tokens') throw new MaxTokensError(stage);
}

/**
 * Parse the JSON answer out of a finished response. Thinking blocks are
 * skipped, so a response that opens with one still parses. Structured outputs
 * make this a plain JSON.parse in the happy path, but the markdown-fence
 * stripping is kept so eval candidate models without structured-output
 * support still parse (port of the v1 extractEventData).
 */
function parseResponseJson(
  response: AnthropicResponseLike,
  stage: 'classify' | 'extract',
): unknown {
  assertModelFinished(response, stage);
  if (!response.content || !Array.isArray(response.content)) {
    throw new Error('Unexpected API response structure');
  }
  const cleaned = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // No model text in the message, which the processor shows to the user.
    // That includes the SyntaxError's own message, which quotes the input.
    // The processor keeps the raw extract output in rawModelOutput for debugging.
    const what = stage === 'extract' ? 'event' : 'classification';
    throw new Error(`Failed to parse ${what} JSON`, { cause: e });
  }
}

/** Pull the event object out of an Anthropic response. */
export function extractEventData(response: AnthropicResponseLike): ExtractedEvent {
  return normalizeEventData(parseResponseJson(response, 'extract'));
}

const CLASSIFICATION_CATEGORIES: readonly Classification['category'][] = [
  'event_poster',
  'event_screenshot',
  'ticket',
  'other_scrapbook',
  'not_useful',
];

/**
 * Pull the classification out of an Anthropic response. The processor and the
 * eval harness both use it, so evals score what production parses. Anything
 * unrecognised degrades to the cautious value: an unknown category is
 * not_useful, and only a literal `true` counts as an event.
 */
export function extractClassification(response: AnthropicResponseLike): Classification {
  const parsed = parseResponseJson(response, 'classify');
  const raw = (
    typeof parsed === 'object' && parsed !== null ? parsed : {}
  ) as Partial<Classification>;
  const category = CLASSIFICATION_CATEGORIES.includes(raw.category as Classification['category'])
    ? (raw.category as Classification['category'])
    : 'not_useful';
  return {
    category,
    is_event: raw.is_event === true,
    confidence:
      raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low',
  };
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
