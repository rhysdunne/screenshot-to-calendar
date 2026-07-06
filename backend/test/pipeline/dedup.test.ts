import { describe, expect, it } from 'vitest';
import {
  findDuplicate,
  normalizeTitle,
  titleSimilarity,
} from '../../src/pipeline/dedup.js';
import type { CalendarEventInput } from '../../src/pipeline/types.js';

function candidate(summary: string, date = '2026-07-12'): CalendarEventInput {
  return {
    summary,
    description: '',
    location: '',
    start: { date },
    end: { date },
  };
}

describe('normalizeTitle', () => {
  it('folds case, punctuation, emoji, and stopwords', () => {
    expect(normalizeTitle('The FRIEZE London: Art Fair! 🎨')).toBe('frieze art fair');
  });

  it('folds diacritics', () => {
    expect(normalizeTitle('Café Müller')).toBe('cafe muller');
  });
});

describe('titleSimilarity', () => {
  it('identical titles score 1', () => {
    expect(titleSimilarity('Frieze Art Fair', 'Frieze Art Fair')).toBe(1);
  });

  it('containment catches terse vs verbose variants of the same event', () => {
    expect(titleSimilarity('Frieze', 'Frieze London Art Fair 2026')).toBe(1);
  });

  it('unrelated titles score low', () => {
    expect(titleSimilarity('Jazz Night at Ronnie Scotts', 'Pottery Workshop')).toBeLessThan(
      0.2,
    );
  });
});

describe('findDuplicate', () => {
  const existing = [
    { id: 'ev1', summary: 'Frieze London Art Fair', start: { date: '2026-07-12' } },
    { id: 'ev2', summary: 'Jazz Night', start: { dateTime: '2026-07-14T19:00:00+01:00' } },
  ];

  it('same title + same start date → duplicate', () => {
    const verdict = findDuplicate(candidate('Frieze London Art Fair'), existing);
    expect(verdict.kind).toBe('duplicate');
    if (verdict.kind === 'duplicate') expect(verdict.event.id).toBe('ev1');
  });

  it('similar title but different start date → possible duplicate, not skip', () => {
    const verdict = findDuplicate(candidate('Frieze London Art Fair', '2026-07-13'), existing);
    expect(verdict.kind).toBe('possible');
  });

  it('handles dateTime starts when comparing dates', () => {
    const verdict = findDuplicate(
      {
        summary: 'Jazz Night',
        description: '',
        location: '',
        start: { dateTime: '2026-07-14T19:00:00', timeZone: 'Europe/London' },
        end: { dateTime: '2026-07-14T21:00:00', timeZone: 'Europe/London' },
      },
      existing,
    );
    expect(verdict.kind).toBe('duplicate');
  });

  it('no similar events → none', () => {
    expect(findDuplicate(candidate('Pottery Workshop'), existing).kind).toBe('none');
  });

  it('empty calendar → none', () => {
    expect(findDuplicate(candidate('Anything'), []).kind).toBe('none');
  });
});
