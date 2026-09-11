import { describe, expect, it } from 'vitest';
import { clusterCorrections, MIN_INDEPENDENT_CAPTURES } from '../src/cluster.js';
import {
  compareReports,
  signTestP,
  validateCandidate,
  MIN_AGGREGATE_GAIN,
  SIGN_TEST_ALPHA,
} from '../src/run-gate.js';
import { extractEventVersions, nextCandidateVersion, parseVersion } from '../src/versions.js';
import type { CorrectionRecord } from '../../../backend/src/lib/ddb.js';
import type { ModelReport, PerCaseScore } from '../../../evals/src/report.js';

function correction(overrides: Partial<CorrectionRecord>): CorrectionRecord {
  return {
    userId: 'u1',
    correctionId: 'c1',
    captureId: 'cap-1',
    field: 'end_date',
    oldValue: null,
    newValue: '2026-08-01',
    imageKey: 'k',
    consentEvalUse: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('clusterCorrections (poisoning defenses)', () => {
  it('requires corrections from ≥3 distinct captures', () => {
    // One user hammering the same capture 10 times must not create a pattern.
    const sameCapture = Array.from({ length: 10 }, (_, i) =>
      correction({ correctionId: `c${i}`, captureId: 'cap-1' }),
    );
    expect(clusterCorrections(sameCapture)).toHaveLength(0);

    const independent = Array.from({ length: MIN_INDEPENDENT_CAPTURES }, (_, i) =>
      correction({ correctionId: `c${i}`, captureId: `cap-${i}` }),
    );
    expect(clusterCorrections(independent)).toHaveLength(1);
  });

  it('drops non-consented corrections entirely', () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      correction({ correctionId: `c${i}`, captureId: `cap-${i}`, consentEvalUse: false }),
    );
    expect(clusterCorrections(records)).toHaveLength(0);
  });

  it('separates misses, hallucinations, and wrong values per field', () => {
    const records = [
      ...[0, 1, 2].map((i) =>
        correction({ correctionId: `m${i}`, captureId: `capm-${i}`, oldValue: null }),
      ),
      ...[0, 1, 2].map((i) =>
        correction({
          correctionId: `h${i}`,
          captureId: `caph-${i}`,
          oldValue: '2026-01-01',
          newValue: null,
        }),
      ),
    ];
    const patterns = clusterCorrections(records);
    expect(patterns.map((p) => p.key).sort()).toEqual([
      'end_date:hallucination',
      'end_date:miss',
    ]);
  });
});

function report(overrides: Partial<ModelReport>): ModelReport {
  return {
    model: 'claude-sonnet-5',
    cases: 44,
    aggregate: 0.9,
    fieldAccuracy: { start_date: 0.95, end_date: 0.85, title: 0.98 },
    hallucinationRate: 0.1,
    missRate: 0.2,
    classificationAccuracy: 1,
    meanLatencyMs: 4000,
    p95LatencyMs: 8000,
    costPer100Images: 1.2,
    errors: 0,
    ...overrides,
  };
}

describe('compareReports (the eval gate)', () => {
  it('passes when aggregate improves with no field regression', () => {
    const result = compareReports(
      report({}),
      report({ aggregate: 0.93, fieldAccuracy: { start_date: 0.95, end_date: 0.92, title: 0.98 } }),
    );
    expect(result.pass).toBe(true);
  });

  it('fails when any field regresses even if aggregate improves', () => {
    const result = compareReports(
      report({}),
      report({ aggregate: 0.93, fieldAccuracy: { start_date: 0.85, end_date: 0.95, title: 0.98 } }),
    );
    expect(result.pass).toBe(false);
    expect(result.reasons.join()).toContain('start_date');
  });

  it('fails when aggregate does not improve enough', () => {
    const result = compareReports(report({}), report({ aggregate: 0.901 }));
    expect(result.pass).toBe(false);
  });

  it('fails when hallucination rate worsens materially', () => {
    const result = compareReports(
      report({}),
      report({ aggregate: 0.95, hallucinationRate: 0.3 }),
    );
    expect(result.pass).toBe(false);
    expect(result.reasons.join()).toContain('hallucination');
  });
});

describe('prompt version arithmetic', () => {
  it('parses versions numerically', () => {
    expect(parseVersion('v3')).toBe(3);
    expect(parseVersion('v10')).toBe(10);
    expect(parseVersion('draft')).toBeNull();
  });

  it('picks the next version above the active pin', () => {
    expect(nextCandidateVersion('v3', ['v2', 'v3'])).toBe('v4');
  });

  it('never returns a version that already exists on disk', () => {
    // An unmerged v4 must not be overwritten — eval baselines reference
    // versions by name, so a version file is immutable once written.
    expect(nextCandidateVersion('v3', ['v2', 'v3', 'v4'])).toBe('v5');
  });

  it('compares numerically, not lexicographically', () => {
    // 'v9' > 'v10' as strings. This is the bug class that made the old
    // `ls | sort -V | tail -1` candidate heuristic unsafe.
    expect(nextCandidateVersion('v9', ['v9'])).toBe('v10');
    expect(nextCandidateVersion('v9', ['v9', 'v10'])).toBe('v11');
  });

  it('reads versions out of prompt filenames only', () => {
    expect(
      extractEventVersions([
        'extract-event.v2.md',
        'extract-event.v10.md',
        'classify-image.v1.md',
        'prompts.ts',
      ]),
    ).toEqual(['v2', 'v10']);
  });
});

describe('validateCandidate (pre-flight, before any eval spend)', () => {
  it('refuses a candidate that is the active version', () => {
    // The Aug 2026 failure: CI inferred the candidate from the filesystem, got
    // the live prompt, and ran two full evals of it against itself.
    const reasons = validateCandidate('v3', 'v3', ['v2', 'v3']);
    expect(reasons).not.toHaveLength(0);
    expect(reasons.join()).toContain('ACTIVE');
  });

  it('refuses a candidate older than the active version', () => {
    expect(validateCandidate('v2', 'v3', ['v2', 'v3'])).not.toHaveLength(0);
  });

  it('refuses a candidate with no prompt file', () => {
    expect(validateCandidate('v4', 'v3', ['v2', 'v3']).join()).toContain('no prompt file');
  });

  it('refuses a malformed version', () => {
    expect(validateCandidate('latest', 'v3', ['v2', 'v3'])).not.toHaveLength(0);
  });

  it('accepts a real candidate above the pin', () => {
    expect(validateCandidate('v4', 'v3', ['v2', 'v3', 'v4'])).toEqual([]);
  });
});

describe('signTestP', () => {
  it('is significant when every changed case improves', () => {
    expect(signTestP(10, 0)).toBeLessThan(SIGN_TEST_ALPHA);
  });

  it('is not significant when improvements and regressions are balanced', () => {
    expect(signTestP(6, 5)).toBeGreaterThan(SIGN_TEST_ALPHA);
  });

  it('returns 1 when nothing changed', () => {
    expect(signTestP(0, 0)).toBe(1);
  });

  it('matches the exact binomial tail', () => {
    // P(X >= 10 | n=10, p=0.5) = 0.5^10
    expect(signTestP(10, 0)).toBeCloseTo(Math.pow(0.5, 10), 12);
    // n=11 is symmetric about 5.5, so P(X >= 6) is exactly a half.
    expect(signTestP(6, 5)).toBeCloseTo(0.5, 12);
  });
});

/** A scored case. `fields` is independent of `aggregate` here by design: the
 *  field-regression rule and the sign test are separate rules, unit-tested
 *  separately. */
function perCase(id: string, aggregate: number | null, over: Partial<PerCaseScore> = {}): PerCaseScore {
  return {
    id,
    aggregate,
    fields: { start_date: 0.95, end_date: 0.85, title: 0.98 },
    hallucinations: 0,
    misses: 0,
    errored: false,
    ...over,
  };
}

/** 72 scored cases plus the 4 non-event cases the real dataset carries. */
function paired(scores: number[], over: Partial<ModelReport> = {}): ModelReport {
  const cases: PerCaseScore[] = scores.map((s, i) => perCase(`case-${i}`, s));
  for (let i = 0; i < 4; i++) {
    cases.push(perCase(`nonevent-${i}`, null));
  }
  return report({
    cases: cases.length,
    aggregate: scores.reduce((a, b) => a + b, 0) / scores.length,
    perCase: cases,
    ...over,
  });
}

describe('compareReports (paired per-case comparison)', () => {
  it('rejects a mean gain that is really symmetric noise', () => {
    // THE REGRESSION TEST FOR THE AUG 2026 INCIDENT. Six cases up, five down —
    // the coin-flip pattern of two runs of the same prompt — yet the mean rises
    // by ~1pt, which is what the old absolute-threshold rule keyed on.
    const base = Array.from({ length: 72 }, (_, i) => (i < 6 ? 0.8 : i < 11 ? 1.0 : 0.96));
    const cand = Array.from({ length: 72 }, (_, i) => (i < 6 ? 1.0 : i < 11 ? 0.9 : 0.96));
    const result = compareReports(paired(base), paired(cand));

    expect(result.better).toBe(6);
    expect(result.worse).toBe(5);
    // It would have sailed through the old rule…
    expect(result.candidateAggregate - result.baselineAggregate).toBeGreaterThan(
      MIN_AGGREGATE_GAIN,
    );
    // …and the paired test correctly calls it noise.
    expect(result.pass).toBe(false);
    expect(result.reasons.join()).toContain('within noise');
  });

  it('passes a small but consistent improvement', () => {
    // +0.3pt on the mean — below the old absolute threshold — but 12 of 13
    // changed cases moved the right way, which is real.
    const base = Array.from({ length: 72 }, () => 0.9);
    const cand = base.map((s, i) => (i < 12 ? s + 0.02 : i === 12 ? s - 0.02 : s));
    const result = compareReports(paired(base), paired(cand));

    expect(result.better).toBe(12);
    expect(result.worse).toBe(1);
    expect(result.candidateAggregate - result.baselineAggregate).toBeLessThan(MIN_AGGREGATE_GAIN);
    expect(result.pValue).toBeLessThan(SIGN_TEST_ALPHA);
    expect(result.pass).toBe(true);
  });

  it('rejects a candidate that regresses more cases than it improves', () => {
    const base = Array.from({ length: 72 }, () => 0.9);
    const cand = base.map((s, i) => (i < 3 ? s + 0.05 : i < 12 ? s - 0.05 : s));
    const result = compareReports(paired(base), paired(cand));
    expect(result.pass).toBe(false);
    expect(result.reasons.join()).toContain('no net improvement');
  });

  it('scores both sides over the same cases when one errors', () => {
    // The denominator asymmetry: baseline scored 72 cases, candidate errored on
    // one. Averaging 72 against 71 let a dropped weak case masquerade as a gain.
    const base = Array.from({ length: 72 }, (_, i) => (i === 71 ? 0.0 : 0.9));
    const baseline = paired(base);
    const cand = paired(Array.from({ length: 72 }, () => 0.9));
    cand.perCase![71] = perCase('case-71', null, { errored: true });

    const result = compareReports(baseline, cand);
    expect(result.paired).toBe(71);
    // The excluded 0.0 must not drag the baseline mean down.
    expect(result.baselineAggregate).toBeCloseTo(0.9, 10);
    expect(result.candidateAggregate).toBeCloseTo(0.9, 10);
    expect(result.unusable).toBeUndefined();
  });

  it('does not count by-design non-event cases against coverage', () => {
    // Non-event cases are unscored on both arms. An earlier draft of the guard
    // compared the paired count against `cases` (76) and so always misfired.
    const result = compareReports(
      paired(Array.from({ length: 72 }, () => 0.9)),
      paired(Array.from({ length: 72 }, () => 0.9)),
    );
    expect(result.paired).toBe(72);
    expect(result.unusable).toBeUndefined();
  });

  it('is unusable — not merely a rejection — when too many cases error', () => {
    const baseline = paired(Array.from({ length: 72 }, () => 0.9));
    const cand = paired(Array.from({ length: 72 }, () => 0.95));
    for (let i = 0; i < 15; i++) {
      cand.perCase![i] = perCase(`case-${i}`, null, { errored: true });
    }
    const result = compareReports(baseline, cand);
    expect(result.unusable).toBeDefined();
    expect(result.pass).toBe(false);
  });

  it('still rejects a per-field regression in paired mode', () => {
    const base = Array.from({ length: 72 }, () => 0.9);
    const cand = base.map((s, i) => (i < 20 ? s + 0.05 : s));
    const candidate = paired(cand);
    for (const c of candidate.perCase!) {
      c.fields = { ...c.fields, start_date: 0.7 };
    }
    const result = compareReports(paired(base), candidate);
    expect(result.pass).toBe(false);
    expect(result.reasons.join()).toContain('start_date');
  });

  it('rejects a candidate whose mean drops even if more cases improve', () => {
    // Many small wins, one catastrophic loss.
    const base = Array.from({ length: 72 }, () => 0.9);
    const cand = base.map((s, i) => (i < 20 ? s + 0.01 : i === 20 ? 0.0 : s));
    const result = compareReports(paired(base), paired(cand));
    expect(result.better).toBe(20);
    expect(result.pass).toBe(false);
    expect(result.reasons.join()).toContain('mean aggregate decreased');
  });
});
