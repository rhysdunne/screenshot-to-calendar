import { describe, expect, it } from 'vitest';
import { FROZEN_TODAY, makeEventCase, makeJustPastCases, rng, weekdayOf } from '../src/data.js';
import { TEMPLATES } from '../src/templates.js';
import { addDays, isValidYmd } from '../../backend/src/pipeline/dates.js';

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

  it('just-past cases print no year and fall before frozenToday (#27)', () => {
    const cases = makeJustPastCases(rng(42), 44);
    expect(cases.map((c) => c.id)[0]).toBe('syn-044-just-past-gig');
    const control = cases[cases.length - 1]!;
    for (const c of cases) {
      expect(c.display.dateText).not.toMatch(/\b20\d\d\b/);
      if (c === control) continue;
      // Each just-past case starts within the last month.
      expect(c.gold.start_date! < FROZEN_TODAY).toBe(true);
      expect(c.gold.start_date! >= addDays(FROZEN_TODAY, -30)).toBe(true);
    }
    // A short-style date carries a weekday, which has to fit the gold year.
    const short = cases.find((c) => c.template === 'club-night')!;
    expect(short.display.dateText.startsWith(weekdayOf(short.gold.start_date!).slice(0, 3))).toBe(
      true,
    );
    // The control is months past, so it keeps the next occurrence.
    expect(control.gold.start_date).toBe('2027-02-14');
    expect(control.display.dateText).toBe('14 February');
  });

  it('just-past cases leave the drawn cases unchanged', () => {
    const plain = rng(42);
    const withExtra = rng(42);
    const a = Array.from({ length: 40 }, (_, i) => makeEventCase(plain, i));
    const b = Array.from({ length: 40 }, (_, i) => makeEventCase(withExtra, i));
    makeJustPastCases(withExtra, 44);
    expect(b).toEqual(a);
  });

  it('every generated template exists and renders the gold-visible facts', () => {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const random = rng(42);
    const drawn = Array.from({ length: 16 }, (_, i) => makeEventCase(random, i));
    for (const c of [...drawn, ...makeJustPastCases(random, 16)]) {
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
