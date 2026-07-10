import { describe, expect, it } from 'vitest';
import { isBlocked, type ModerationLabel, type ModerationPolicy } from '../../src/pipeline/moderation.js';

const POLICY: ModerationPolicy = { blockCategories: ['Explicit Nudity'], minConfidence: 80 };

const label = (over: Partial<ModerationLabel>): ModerationLabel => ({
  name: '',
  parentName: '',
  confidence: 0,
  ...over,
});

describe('isBlocked', () => {
  it('allows an empty label set', () => {
    expect(isBlocked([], POLICY)).toBe(false);
  });

  it('blocks a top-level match at or above the threshold', () => {
    expect(isBlocked([label({ name: 'Explicit Nudity', confidence: 95 })], POLICY)).toBe(true);
    expect(isBlocked([label({ name: 'Explicit Nudity', confidence: 80 })], POLICY)).toBe(true);
  });

  it('allows the same category below the threshold', () => {
    expect(isBlocked([label({ name: 'Explicit Nudity', confidence: 79.9 })], POLICY)).toBe(false);
  });

  it('matches via parentName for a sub-label', () => {
    // e.g. "Graphic Male Nudity" rolls up to the "Explicit Nudity" category.
    expect(
      isBlocked([label({ name: 'Graphic Male Nudity', parentName: 'Explicit Nudity', confidence: 90 })], POLICY),
    ).toBe(true);
  });

  it('does not block a non-listed category (benign gig-poster content)', () => {
    expect(isBlocked([label({ name: 'Alcohol', confidence: 99 })], POLICY)).toBe(false);
    expect(isBlocked([label({ name: 'Rude Gestures', confidence: 99 })], POLICY)).toBe(false);
  });

  it('matches categories case-insensitively', () => {
    expect(isBlocked([label({ name: 'explicit nudity', confidence: 90 })], POLICY)).toBe(true);
    const lowerPolicy: ModerationPolicy = { blockCategories: ['explicit nudity'], minConfidence: 80 };
    expect(isBlocked([label({ name: 'Explicit Nudity', confidence: 90 })], lowerPolicy)).toBe(true);
  });

  it('blocks if any label in a mixed set matches', () => {
    const labels = [
      label({ name: 'Alcohol', confidence: 99 }),
      label({ name: 'Explicit Nudity', confidence: 88 }),
    ];
    expect(isBlocked(labels, POLICY)).toBe(true);
  });
});
