// Deterministic defences against indirect prompt injection.
//
// The pixels of a user-supplied poster are untrusted input: anyone who can get
// an image in front of a user can put text in it, and that text reaches the
// extraction model. Prompt-level framing reduces how often the model plays
// along; it never guarantees it. So whatever the model returns is bounded and
// neutered *here*, before it reaches Google Calendar or the app.
//
// Pure: string logic and the `URL` global only — no AWS SDK, no fetch, no env.
import type { ExtractedEvent } from './types.js';

/**
 * Per-field character caps. Generous enough for any real poster, tight enough
 * that a wall-of-text payload cannot survive intact.
 */
export const FIELD_LIMITS = {
  title: 200,
  venue: 150,
  address: 250,
  description: 1000,
  price: 60,
  url: 500,
} as const;

export type SanitizedField = keyof typeof FIELD_LIMITS;

export type FindingCode =
  /** C0/C1 control characters, or zero-width / bidi-override characters. */
  | 'control_chars'
  /** Field exceeded its cap and was truncated. */
  | 'truncated'
  /** Text contains HTML-ish markup (escaped downstream, flagged here). */
  | 'markup'
  /** Text tried to forge the "[Auto-captured ...]" provenance marker. */
  | 'provenance_spoof'
  /** Text matches an imperative instruction pattern aimed at a model. */
  | 'instruction_markers'
  /** `url` was not a plain http(s) web address and was dropped. */
  | 'unsafe_url';

export interface Finding {
  field: SanitizedField;
  code: FindingCode;
}

export interface SanitizeResult {
  event: ExtractedEvent;
  findings: Finding[];
}

// Detection and replacement forms are kept separate on purpose: a /g regex
// carries `lastIndex` across `.test()` calls, so reusing one for both makes
// detection alternate true/false on identical input.

// Matching control characters is the entire point of the next two, so
// no-control-regex is disabled deliberately rather than worked around.
/** Control characters (C0 and C1) — never legitimate in extracted event text. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_G = /[\u0000-\u001F\u007F-\u009F]/g;
/** Zero-width and bidi-override characters: hidden-text and homograph carriers. */
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/;
const INVISIBLE_CHARS_G = /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g;
/** HTML-ish markup. Google Calendar renders a limited HTML subset. */
const MARKUP = /<\/?[a-z][^>]*>/i;
/** The provenance marker `map-to-calendar` writes. Untrusted text may not carry it. */
const PROVENANCE_MARKER = /\[auto-captured[^\]]*\]?/i;
const PROVENANCE_MARKER_G = /\[auto-captured[^\]]*\]?/gi;

/**
 * Narrow, high-signal patterns for text addressed at a model rather than a
 * reader. Deliberately tight: these only route a capture to human review, and
 * a false positive costs a user an unnecessary review prompt. Broad matching
 * would fire on real posters ("Ignore the Rain - Outdoor Cinema"), so each
 * pattern requires the imperative *and* its object.
 *
 * This is a review signal, not a filter. It is trivially evadable by
 * paraphrase, homoglyph, or another language — the enforcement is the
 * structural sanitisation above it, which an attacker cannot phrase around.
 */
const INSTRUCTION_MARKERS: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+|the\s+)*(?:previous|prior|above|preceding|earlier)\b/i,
  /\bdisregard\s+(?:all\s+|any\s+|the\s+)*(?:previous|prior|above|preceding|instruction)/i,
  /\bsystem\s+prompt\b/i,
  /\bnew\s+instructions?\s*[:.]/i,
];

/**
 * Clean a single free-text field. Strips control/invisible characters,
 * collapses *all* whitespace (including newlines) to single spaces, trims, and
 * caps length.
 *
 * Collapsing newlines is load-bearing, not cosmetic: `mapEventToCalendar`
 * assembles the calendar description as newline-joined `Label: value` lines,
 * so a field that cannot contain a newline cannot forge one of those lines.
 */
export function sanitizeText(
  value: unknown,
  field: SanitizedField,
  findings: Finding[] = [],
): string | null {
  if (typeof value !== 'string') return null;

  let text = value;
  if (CONTROL_CHARS.test(text) || INVISIBLE_CHARS.test(text)) {
    findings.push({ field, code: 'control_chars' });
    text = text.replace(CONTROL_CHARS_G, ' ').replace(INVISIBLE_CHARS_G, '');
  }
  if (PROVENANCE_MARKER.test(text)) {
    findings.push({ field, code: 'provenance_spoof' });
    text = text.replace(PROVENANCE_MARKER_G, '');
  }
  if (MARKUP.test(text)) findings.push({ field, code: 'markup' });
  if (INSTRUCTION_MARKERS.some((re) => re.test(text))) {
    findings.push({ field, code: 'instruction_markers' });
  }

  text = text.replace(/\s+/g, ' ').trim();

  const limit = FIELD_LIMITS[field];
  if (text.length > limit) {
    findings.push({ field, code: 'truncated' });
    text = truncateAtWord(text, limit);
  }

  return text === '' ? null : text;
}

function truncateAtWord(text: string, limit: number): string {
  const clipped = text.slice(0, limit - 1);
  const lastSpace = clipped.lastIndexOf(' ');
  // Only break on a word boundary when one exists reasonably near the end;
  // otherwise a single long token would collapse to almost nothing.
  const body = lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.trimEnd()}…`;
}

/**
 * Validate an extracted URL. Policy: plain `http(s)` web addresses only.
 *
 * Everything else becomes null — `javascript:`, `data:`, `vbscript:`,
 * `mailto:`, `file:`, credentials-in-URL display spoofs
 * (`https://ticketmaster.com@evil.example`), IP literals, and hostnames with
 * no dot. `mailto:` is excluded deliberately: the prompt asks for "any website
 * or ticket link", so allowing it widens the sink for no product benefit.
 *
 * A bare domain (`dice.fm/event/abc`) is normalised to `https://` rather than
 * dropped — posters print addresses without a scheme far more often than with
 * one, and the result still satisfies the http(s)-only policy. Eval scoring
 * strips the scheme before comparing, so this is score-neutral.
 */
export function sanitizeUrl(value: unknown, findings: Finding[] = []): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const reject = (): null => {
    findings.push({ field: 'url', code: 'unsafe_url' });
    return null;
  };

  // Whitespace or control characters inside a URL mean it is not one.
  if (/\s/.test(trimmed) || CONTROL_CHARS.test(trimmed) || INVISIBLE_CHARS.test(trimmed)) {
    return reject();
  }
  if (trimmed.length > FIELD_LIMITS.url) return reject();

  let candidate: string | null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    candidate = trimmed;
  } else if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[/?#]|$)/i.test(trimmed)) {
    // Bare domain with a plausible TLD — assume https.
    candidate = `https://${trimmed}`;
  } else {
    candidate = null;
  }
  if (candidate === null) return reject();

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return reject();
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return reject();
  // Embedded credentials are the classic display spoof.
  if (url.username !== '' || url.password !== '') return reject();

  const host = url.hostname;
  if (!host.includes('.')) return reject();
  if (host === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return reject();
  // `new URL` punycodes non-ASCII hostnames, so European venue domains survive.

  const result = url.toString();
  return result.length > FIELD_LIMITS.url ? reject() : result;
}

/**
 * Escape text destined for the Google Calendar description, which renders a
 * limited HTML subset. This is a correctness fix as much as a security one:
 * an unescaped "Rock & Roll" already renders wrong today.
 */
export function escapeForCalendar(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Route a capture to human review when the deterministic layer had to change
 * something. Every finding is an objectively anomalous condition, so a normal
 * poster produces none and sees no extra review prompt.
 *
 * This exists because the model picks its own `confidence`, which makes the
 * existing gate self-reported: an injected payload can simply claim "high".
 */
export function requiresReview(event: ExtractedEvent, findings: Finding[]): boolean {
  return event.confidence === 'low' || findings.length > 0;
}

/** Distinct finding codes, for structured logging (codes only, never content). */
export function findingCodes(findings: Finding[]): string[] {
  return [...new Set(findings.map((f) => `${f.field}:${f.code}`))].sort();
}
