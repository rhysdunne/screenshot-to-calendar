import { describe, expect, it } from 'vitest';
import { scoreCase, scoreField } from '../src/score.js';
import type { ExtractedEvent } from '../../backend/src/pipeline/types.js';

function event(overrides: Partial<ExtractedEvent>): ExtractedEvent {
  return {
    title: 'Midnight Botany',
    venue: 'Cafe OTO',
    address: '18-22 Ashwin St, London E8 3DL',
    start_date: '2026-07-18',
    end_date: null,
    start_time: '19:00',
    end_time: '22:30',
    description: null,
    url: 'https://tickets.example.com/e/4821',
    confidence: 'high',
    ...overrides,
  };
}

describe('scoreField', () => {
  it('dates are exact-match only', () => {
    expect(scoreField('start_date', '2026-07-18', '2026-07-18').score).toBe(1);
    expect(scoreField('start_date', '2026-07-18', '2026-07-19').score).toBe(0);
  });

  it('both-null is a match; predicted-only is a hallucination; gold-only is a miss', () => {
    expect(scoreField('address', null, null)).toMatchObject({ score: 1, nullOutcome: 'match' });
    expect(scoreField('address', null, '1 Fake St')).toMatchObject({
      score: 0,
      nullOutcome: 'hallucination',
    });
    expect(scoreField('address', '1 Real St', null)).toMatchObject({
      score: 0,
      nullOutcome: 'miss',
    });
  });

  it('titles score fuzzily', () => {
    expect(scoreField('title', 'Midnight Botany', 'MIDNIGHT BOTANY!').score).toBe(1);
    expect(scoreField('title', 'Midnight Botany', 'Midnight Botany: New Work').score).toBe(1);
    expect(scoreField('title', 'Midnight Botany', 'Pottery Workshop').score).toBe(0);
  });

  it('addresses compare by postcode when both have one', () => {
    expect(
      scoreField('address', '18-22 Ashwin St, London E8 3DL', 'Ashwin Street, E8 3DL').score,
    ).toBe(1);
    expect(
      scoreField('address', '18-22 Ashwin St, London E8 3DL', '4 Elephant Rd, SE17 1LB').score,
    ).toBe(0);
  });

  it('urls normalize scheme/www/trailing slash', () => {
    expect(
      scoreField('url', 'https://tickets.example.com/e/4821', 'http://www.tickets.example.com/e/4821/').score,
    ).toBe(1);
  });
});

describe('scoreCase', () => {
  it('perfect prediction scores 1.0', () => {
    expect(scoreCase(event({}), event({})).aggregate).toBe(1);
  });

  it('wrong date hurts more than wrong url (weighting)', () => {
    const wrongDate = scoreCase(event({}), event({ start_date: '2026-07-19' }));
    const wrongUrl = scoreCase(event({}), event({ url: 'https://other.com' }));
    expect(wrongDate.aggregate).toBeLessThan(wrongUrl.aggregate);
  });

  it('counts hallucinations and misses separately', () => {
    const gold = event({ address: null, url: null });
    const predicted = event({ address: '1 Fake St', venue: null });
    const result = scoreCase(gold, { ...predicted, url: null });
    expect(result.hallucinations).toBe(1); // address invented
    expect(result.misses).toBe(1); // venue dropped
  });
});
