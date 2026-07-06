import { describe, expect, it } from 'vitest';
import { FROZEN_TODAY, makeEventCase, rng, weekdayOf } from '../src/data.js';
import { TEMPLATES } from '../src/templates.js';
import { isValidYmd } from '../../backend/src/pipeline/dates.js';

describe('synthetic case generation', () => {
  it('is deterministic for a given seed', () => {
    const a = makeEventCase(rng(42), 0);
    const b = makeEventCase(rng(42), 0);
    expect(a).toEqual(b);
  });

  it('different seeds give different cases', () => {
    const a = makeEventCase(rng(1), 0);
    const b = makeEventCase(rng(2), 0);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('gold dates are valid YYYY-MM-DD in the future of frozenToday', () => {
    const random = rng(7);
    for (let i = 0; i < 50; i++) {
      const c = makeEventCase(random, i);
      for (const d of [c.gold.start_date, c.gold.end_date]) {
        if (d !== null) {
          expect(isValidYmd(d)).toBe(true);
          expect(d > FROZEN_TODAY).toBe(true);
        }
      }
      // Every case must be calendar-creatable: at least one date.
      expect(c.gold.start_date ?? c.gold.end_date).not.toBeNull();
    }
  });

  it('"This Saturday" cases resolve to an actual Saturday', () => {
    const random = rng(3);
    for (let i = 0; i < 100; i++) {
      const c = makeEventCase(random, i);
      if (c.display.dateText === 'This Saturday') {
        expect(weekdayOf(c.gold.start_date!)).toBe('Saturday');
      }
    }
  });

  it('every generated template exists and renders the gold-visible facts', () => {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const random = rng(42);
    for (let i = 0; i < 16; i++) {
      const c = makeEventCase(random, i);
      const template = TEMPLATES[c.template];
      expect(template, c.template).toBeDefined();
      const html = template!(c);
      expect(html).toContain(esc(c.display.title));
      expect(html).toContain(esc(c.display.dateText));
      // Gold facts must only be non-null when actually visible in the image.
      if (c.gold.address) expect(html).toContain(esc(c.gold.address));
      if (c.gold.url) expect(html).toContain(esc(c.gold.url.replace('https://', '')));
    }
  });
});
