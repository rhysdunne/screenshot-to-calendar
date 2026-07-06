// Field-level scoring of a predicted extraction against gold. Pure functions,
// unit-tested. Reuses the production dedup similarity for fuzzy text fields
// so eval scores reflect the matching the product actually does.
import { titleSimilarity } from '../../backend/src/pipeline/dedup.js';
import type { Classification, ExtractedEvent } from '../../backend/src/pipeline/types.js';

export type FieldName =
  | 'title' | 'venue' | 'address' | 'start_date' | 'end_date'
  | 'start_time' | 'end_time' | 'url' | 'price' | 'category';

export const SCORED_FIELDS: FieldName[] = [
  'title', 'venue', 'address', 'start_date', 'end_date', 'start_time', 'end_time', 'url',
];

/** v3 fields — scored only when the gold file carries the key, so pre-v3 gold stays valid. */
export const OPTIONAL_FIELDS: FieldName[] = ['price', 'category'];

/** Dates are the product — weight them double; the title matters more than metadata. */
export const FIELD_WEIGHTS: Record<FieldName, number> = {
  start_date: 2, end_date: 2, start_time: 2, end_time: 2,
  title: 1.5, venue: 1, address: 1, url: 1,
  price: 0.5, category: 0.5,
};

export type NullOutcome = 'match' | 'hallucination' | 'miss' | 'both_present';

export interface FieldScore {
  field: FieldName;
  score: number; // 0..1
  nullOutcome: NullOutcome;
}

function normalizeUrl(u: string): string {
  return u
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .replace(/[?&]utm_[^=&]+=[^&]*/g, '');
}

function normalizeAddress(a: string): string {
  return a.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizePrice(p: string): string {
  return p.toLowerCase().replace(/\b(entry|tickets?|admission)\b/g, '').replace(/\s+/g, '');
}

const POSTCODE = /\b[a-z]{1,2}\d[a-z\d]?\s*\d[a-z]{2}\b/i;

export function scoreField(
  field: FieldName,
  gold: string | null,
  predicted: string | null,
): FieldScore {
  if (gold === null && predicted === null) {
    return { field, score: 1, nullOutcome: 'match' };
  }
  if (gold === null) return { field, score: 0, nullOutcome: 'hallucination' };
  if (predicted === null) return { field, score: 0, nullOutcome: 'miss' };

  let score: number;
  switch (field) {
    case 'start_date':
    case 'end_date':
    case 'start_time':
    case 'end_time':
      score = gold === predicted ? 1 : 0;
      break;
    case 'title':
    case 'venue': {
      const sim = titleSimilarity(gold, predicted);
      score = sim >= 0.8 ? 1 : sim >= 0.5 ? 0.5 : 0;
      break;
    }
    case 'address': {
      const g = normalizeAddress(gold);
      const p = normalizeAddress(predicted);
      const goldPostcode = POSTCODE.exec(gold)?.[0]?.replace(/\s/g, '').toLowerCase();
      const predPostcode = POSTCODE.exec(predicted)?.[0]?.replace(/\s/g, '').toLowerCase();
      if (goldPostcode && predPostcode) {
        score = goldPostcode === predPostcode ? 1 : 0;
      } else {
        score = g.includes(p) || p.includes(g) || titleSimilarity(g, p) >= 0.7 ? 1 : 0;
      }
      break;
    }
    case 'url':
      score = normalizeUrl(gold) === normalizeUrl(predicted) ? 1 : 0;
      break;
    case 'price':
      score = normalizePrice(gold) === normalizePrice(predicted) ? 1 : 0;
      break;
    case 'category':
      score = gold === predicted ? 1 : 0;
      break;
  }
  return { field, score, nullOutcome: 'both_present' };
}

export interface CaseScore {
  fields: FieldScore[];
  /** Weighted aggregate in [0,1]. */
  aggregate: number;
  hallucinations: number;
  misses: number;
}

export function scoreCase(gold: ExtractedEvent, predicted: ExtractedEvent): CaseScore {
  const scoredFields = [
    ...SCORED_FIELDS,
    ...OPTIONAL_FIELDS.filter((f) => f in gold),
  ];
  const fields = scoredFields.map((f) =>
    scoreField(f, (gold[f] ?? null) as string | null, (predicted[f] ?? null) as string | null),
  );
  let weighted = 0;
  let totalWeight = 0;
  for (const fs of fields) {
    weighted += fs.score * FIELD_WEIGHTS[fs.field];
    totalWeight += FIELD_WEIGHTS[fs.field];
  }
  return {
    fields,
    aggregate: weighted / totalWeight,
    hallucinations: fields.filter((f) => f.nullOutcome === 'hallucination').length,
    misses: fields.filter((f) => f.nullOutcome === 'miss').length,
  };
}

export function scoreClassification(gold: Classification, predicted: Classification): {
  categoryCorrect: boolean;
  isEventCorrect: boolean;
} {
  return {
    categoryCorrect: gold.category === predicted.category,
    isEventCorrect: gold.is_event === predicted.is_event,
  };
}
