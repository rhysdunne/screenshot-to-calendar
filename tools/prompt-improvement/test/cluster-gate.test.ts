import { describe, expect, it } from 'vitest';
import { clusterCorrections, MIN_INDEPENDENT_CAPTURES } from '../src/cluster.js';
import { compareReports } from '../src/run-gate.js';
import type { CorrectionRecord } from '../../../backend/src/lib/ddb.js';
import type { ModelReport } from '../../../evals/src/report.js';

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
