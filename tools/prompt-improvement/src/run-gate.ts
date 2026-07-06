// The eval gate (poisoning defense #3): a candidate prompt version is only
// adoptable if, on the full eval dataset, it shows
//   (a) no per-field accuracy regression beyond a small tolerance, AND
//   (b) an aggregate improvement of at least MIN_AGGREGATE_GAIN.
//
//   ANTHROPIC_API_KEY=... npm run gate -- --candidate v3 [--model claude-sonnet-5]
//
// Exit code 0 = pass, 1 = fail. The gate report is written next to the eval
// reports so it can be attached to the PR.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEval } from '../../../evals/src/harness.js';
import { DEFAULT_MODELS } from '../../../backend/src/lib/models.js';
import type { ModelReport } from '../../../evals/src/report.js';

export const MIN_AGGREGATE_GAIN = 0.005; // +0.5pt
export const FIELD_REGRESSION_TOLERANCE = 0.01; // fields may not drop >1pt

export interface GateResult {
  pass: boolean;
  reasons: string[];
  baselineAggregate: number;
  candidateAggregate: number;
}

/** Pure comparison so the gate rule itself is unit-testable. */
export function compareReports(baseline: ModelReport, candidate: ModelReport): GateResult {
  const reasons: string[] = [];
  for (const [field, baseAcc] of Object.entries(baseline.fieldAccuracy)) {
    const candAcc = candidate.fieldAccuracy[field] ?? 0;
    if (candAcc < baseAcc - FIELD_REGRESSION_TOLERANCE) {
      reasons.push(
        `field "${field}" regressed: ${(baseAcc * 100).toFixed(1)}% → ${(candAcc * 100).toFixed(1)}%`,
      );
    }
  }
  if (candidate.aggregate < baseline.aggregate + MIN_AGGREGATE_GAIN) {
    reasons.push(
      `aggregate did not improve by ≥${MIN_AGGREGATE_GAIN * 100}pt: ` +
        `${(baseline.aggregate * 100).toFixed(1)}% → ${(candidate.aggregate * 100).toFixed(1)}%`,
    );
  }
  if (candidate.hallucinationRate > baseline.hallucinationRate + 0.05) {
    reasons.push(
      `hallucination rate worsened: ${baseline.hallucinationRate.toFixed(2)} → ${candidate.hallucinationRate.toFixed(2)}`,
    );
  }
  return {
    pass: reasons.length === 0,
    reasons,
    baselineAggregate: baseline.aggregate,
    candidateAggregate: candidate.aggregate,
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('run-gate.ts');
if (isMain) {
  const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
  };
  const candidate = arg('candidate', '');
  if (!candidate) {
    console.error('Usage: npm run gate -- --candidate v3 [--model <model>]');
    process.exit(2);
  }
  const model = arg('model', DEFAULT_MODELS.extract);

  (async () => {
    console.log(`Gate: pinned prompt vs candidate ${candidate} on ${model}\n`);
    const baseline = await runEval({
      models: [model],
      dataset: 'all',
      label: `gate-baseline-${candidate}`,
    });
    const cand = await runEval({
      models: [model],
      dataset: 'all',
      promptVersion: candidate,
      label: `gate-candidate-${candidate}`,
    });
    const result = compareReports(baseline.reports[0]!, cand.reports[0]!);

    const summary = [
      `# Prompt gate: candidate ${candidate} (${model})`,
      '',
      `Baseline aggregate: ${(result.baselineAggregate * 100).toFixed(1)}%`,
      `Candidate aggregate: ${(result.candidateAggregate * 100).toFixed(1)}%`,
      '',
      result.pass ? '## ✅ PASS' : '## ❌ FAIL',
      ...result.reasons.map((r) => `- ${r}`),
    ].join('\n');
    writeFileSync(join(cand.reportDir, 'gate.md'), summary);
    console.log(`\n${summary}`);
    process.exit(result.pass ? 0 : 1);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
