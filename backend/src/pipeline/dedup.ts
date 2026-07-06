import type { CalendarEventInput, ExistingCalendarEvent } from './types.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'at', 'in', 'on', 'of', 'and', 'to', 'for', 'with',
  'london', 'exhibition', 'presents', 'present', 'show', 'event', 'live',
]);

/** Normalize a title for fuzzy comparison: fold diacritics, strip emoji/punctuation, drop stopwords. */
export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // diacritics
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation + emoji
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .join(' ');
}

/**
 * Similarity in [0,1]: max of Jaccard overlap and containment
 * (|A∩B| / min(|A|,|B|)). Containment catches "Frieze" vs
 * "Frieze London Art Fair 2026" — same event, one source terser.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  const jaccard = intersection / union;
  const containment = intersection / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment);
}

export const DUPLICATE_THRESHOLD = 0.7;
export const POSSIBLE_DUPLICATE_THRESHOLD = 0.5;

export type DedupVerdict =
  | { kind: 'none' }
  | { kind: 'possible'; event: ExistingCalendarEvent; similarity: number }
  | { kind: 'duplicate'; event: ExistingCalendarEvent; similarity: number };

function startDateOf(e: ExistingCalendarEvent): string | null {
  if (e.start?.date) return e.start.date;
  if (e.start?.dateTime) return e.start.dateTime.slice(0, 10);
  return null;
}

function startDateOfCandidate(c: CalendarEventInput): string {
  if ('date' in c.start) return c.start.date;
  return c.start.dateTime.slice(0, 10);
}

/**
 * Decide whether `candidate` duplicates any of `existing` (events already in
 * the target calendar, pre-filtered by the caller to a date window around the
 * candidate). Rules:
 *  - similarity ≥ 0.7 AND same start date  → duplicate (skip creation)
 *  - similarity ≥ 0.5                      → possible duplicate (create, but flag)
 */
export function findDuplicate(
  candidate: CalendarEventInput,
  existing: ExistingCalendarEvent[],
): DedupVerdict {
  const candidateStart = startDateOfCandidate(candidate);
  let best: { event: ExistingCalendarEvent; similarity: number } | null = null;

  for (const e of existing) {
    if (!e.summary) continue;
    const sim = titleSimilarity(candidate.summary, e.summary);
    if (!best || sim > best.similarity) best = { event: e, similarity: sim };
  }

  if (!best || best.similarity < POSSIBLE_DUPLICATE_THRESHOLD) return { kind: 'none' };
  if (best.similarity >= DUPLICATE_THRESHOLD && startDateOf(best.event) === candidateStart) {
    return { kind: 'duplicate', ...best };
  }
  return { kind: 'possible', ...best };
}
