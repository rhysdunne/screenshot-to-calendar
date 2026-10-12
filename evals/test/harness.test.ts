import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTunings, runEval, summarize } from '../src/harness.js';
import { scoreCase } from '../src/score.js';
import type { ExtractedEvent } from '../../backend/src/pipeline/types.js';

const gold: ExtractedEvent = {
  title: 'Zurbarán',
  venue: 'National Gallery',
  address: 'Trafalgar Square, London',
  start_date: '2026-09-01',
  end_date: null,
  start_time: '19:00',
  end_time: null,
  description: null,
  url: null,
  confidence: 'high',
};

/** `summarize` takes the harness's internal CaseResult shape. */
function result(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    score: scoreCase(gold, gold),
    classificationCorrect: true,
    latencyMs: 1000,
    costUsd: 0.01,
    ...over,
  };
}

describe('summarize per-case scores', () => {
  it('keeps one entry per case so two runs can be compared paired', () => {
    const report = summarize('claude-sonnet-5', [result('a'), result('b'), result('c')]);
    expect(report.perCase?.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(report.perCase?.[0]?.aggregate).toBeCloseTo(1, 10);
    expect(report.perCase?.[0]?.fields.start_date).toBe(1);
  });

  it('marks errored cases so they can be told apart from non-event cases', () => {
    const report = summarize('claude-sonnet-5', [
      result('scored'),
      // Threw mid-run: should have produced a score and didn't.
      result('broke', { score: null, classificationCorrect: null, error: 'boom' }),
      // Non-event by design: never scored, on either arm.
      result('menu', { score: null, classificationCorrect: true }),
    ]);
    const byId = new Map(report.perCase?.map((c) => [c.id, c]));

    expect(byId.get('broke')?.errored).toBe(true);
    expect(byId.get('broke')?.aggregate).toBeNull();
    expect(byId.get('menu')?.errored).toBe(false);
    expect(byId.get('menu')?.aggregate).toBeNull();
    expect(byId.get('scored')?.errored).toBe(false);
    // The scalar aggregate still averages only the cases that scored.
    expect(report.cases).toBe(3);
    expect(report.errors).toBe(1);
  });
});

describe('summarize classification and tuning', () => {
  it('scores is_event on its own, apart from the category', () => {
    const report = summarize('claude-haiku-5-5', [
      // Category wrong, is_event right: the bit that gates processing held.
      result('a', { classificationCorrect: false, isEventCorrect: true }),
      result('b', { classificationCorrect: true, isEventCorrect: true }),
      result('c', { classificationCorrect: false, isEventCorrect: false }),
      // Classify skipped: counts towards neither.
      result('d', { classificationCorrect: null, isEventCorrect: null }),
    ]);
    expect(report.classificationAccuracy).toBeCloseTo(1 / 3);
    expect(report.isEventAccuracy).toBeCloseTo(2 / 3);
  });

  it('records the tuning each stage sent when given it', () => {
    const tuning = {
      extract: { thinking: 'disabled' as const, effort: 'low' as const, maxTokens: 1024 },
    };
    expect(summarize('claude-sonnet-5', [result('a')], tuning).tuning).toEqual(tuning);
    expect(summarize('claude-sonnet-5', [result('a')])).not.toHaveProperty('tuning');
  });
});

describe('model validation before a run', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves each model\'s tuning, leaving out classify when it is skipped', () => {
    const both = resolveTunings(['claude-sonnet-5'], true, undefined).get('claude-sonnet-5');
    expect(both?.classify).toBeDefined();
    expect(both?.extract).toBeDefined();
    const extractOnly = resolveTunings(['claude-sonnet-5'], false, { effort: 'low' });
    expect(extractOnly.get('claude-sonnet-5')).not.toHaveProperty('classify');
    expect(extractOnly.get('claude-sonnet-5')?.extract?.effort).toBe('low');
  });

  it('throws for a model not in MODELS or without tuning for a stage it runs', () => {
    expect(() => resolveTunings(['claude-nonexistent'], true, undefined)).toThrow(
      /claude-nonexistent/,
    );
    // In MODELS with prices, but no pipeline tuning.
    expect(() => resolveTunings(['claude-opus-4-8'], false, undefined)).toThrow(
      /no extract tuning/,
    );
  });

  it('fails a run with a typo in --models before any case runs or report is written', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const label = 'test-model-validation-should-not-exist';

    await expect(
      runEval({
        models: ['claude-sonnet-5', 'claude-nonexistent'],
        dataset: 'synthetic',
        mock: true,
        label,
      }),
    ).rejects.toThrow(/claude-nonexistent/);

    // Not even the valid model before the typo started.
    expect(log).not.toHaveBeenCalled();
    const reportDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports', label);
    expect(existsSync(reportDir)).toBe(false);
  });
});
