import { describe, expect, it } from 'vitest';
import { buildEvalCase } from '../src/materialize-eval-cases.js';
import type { ExtractedEvent } from '../../../backend/src/pipeline/types.js';

const event: ExtractedEvent = {
  title: 'Frieze London',
  venue: 'Regents Park',
  address: null,
  start_date: '2026-10-14',
  end_date: null,
  start_time: null,
  end_time: null,
  description: null,
  url: null,
  confidence: 'low',
};

describe('buildEvalCase', () => {
  it('gold = original extraction with corrections overlaid; frozenToday = capture date', () => {
    const result = buildEvalCase(
      {
        captureId: '01ABC',
        event,
        corrected: { start_date: '2026-10-15', end_date: '2026-10-18' },
        classification: { category: 'event_poster', is_event: true, confidence: 'high' },
        createdAt: '2026-07-06T14:00:00.000Z',
      },
      ['start_date', 'end_date', 'start_date'],
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe('corr-01ABC');
    expect(result!.gold.start_date).toBe('2026-10-15'); // corrected value wins
    expect(result!.gold.title).toBe('Frieze London'); // uncorrected value kept
    expect(result!.meta.frozenToday).toBe('2026-07-06');
    expect(result!.meta.notes).toBe('User corrected: end_date, start_date'); // deduped, sorted
    expect(result!.meta.consent).toBe(true);
  });

  it('returns null when there is no extraction or no corrections', () => {
    expect(
      buildEvalCase(
        { captureId: 'x', event: undefined, corrected: { title: 'y' }, createdAt: '2026-01-01T00:00:00Z' },
        ['title'],
      ),
    ).toBeNull();
    expect(
      buildEvalCase(
        { captureId: 'x', event, corrected: undefined, createdAt: '2026-01-01T00:00:00Z' },
        [],
      ),
    ).toBeNull();
  });
});
