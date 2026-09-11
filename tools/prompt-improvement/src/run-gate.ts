// The eval gate (poisoning defense #3): a candidate prompt version is only
// adoptable if, on the full eval dataset, it shows
//   (a) no per-field accuracy regression beyond a small tolerance, AND
//   (b) more cases improved than regressed, by a margin a paired sign test
//       calls significant, AND
//   (c) no drop in the mean aggregate, and no worse hallucination rate.
//
//   ANTHROPIC_API_KEY=... npm run gate -- --candidate v4 [--model claude-sonnet-5]
//
// (b) replaces an earlier "aggregate must improve by ≥0.5pt" rule. Both arms run
// at API default temperature, and four runs of an IDENTICAL prompt were measured
// spanning 0.9pt — so an absolute 0.5pt threshold on two independent means was
// inside its own noise floor and decided by chance. Pairing on the case removes
// the between-run variance that dominates here: the only question asked is
// "on this same image, did the candidate do better or worse".
//
// Exit codes:
//   0 = candidate passed
//   1 = gate REJECTED the candidate (the mechanism working; not a broken job)
//   2 = misuse, crash, or a comparison too error-ridden to trust
//
// The gate report is written next to the eval reports so it can be attached to
// the PR, with a machine-readable gate.json beside it.
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval } from '../../../evals/src/harness.js';
import { DEFAULT_MODELS } from '../../../backend/src/lib/models.js';
import { ACTIVE_VERSIONS } from '../../../backend/src/prompts/prompts.js';
import type { ModelReport, PerCaseScore } from '../../../evals/src/report.js';
import { extractEventVersions, parseVersion } from './versions.js';

export const FIELD_REGRESSION_TOLERANCE = 0.01; // fields may not drop >1pt
/** Legacy unpaired threshold — only reachable via the pre-per-case fallback. */
export const MIN_AGGREGATE_GAIN = 0.005;
export const SIGN_TEST_ALPHA = 0.05;
/** Aggregate differences below this are float dust, not a better/worse case. */
export const CASE_EPSILON = 0.001;
/** A comparison needs this share of the scorable cases to be trustworthy. */
export const MIN_PAIRED_COVERAGE = 0.95;

export interface GateResult {
  pass: boolean;
  reasons: string[];
  baselineAggregate: number;
  candidateAggregate: number;
  /** Paired-mode detail (absent when either report lacks per-case scores). */
  paired?: number;
  better?: number;
  worse?: number;
  unchanged?: number;
  pValue?: number;
  /** Set when the comparison itself can't be trusted — surfaces as exit 2. */
  unusable?: string;
}

/**
 * Exact one-sided binomial tail: P(X >= better) for X ~ Binomial(better+worse, 0.5).
 * Computed by walking the pmf so C(n,k) never overflows.
 */
export function signTestP(better: number, worse: number): number {
  const n = better + worse;
  if (n === 0) return 1;
  let pmf = Math.pow(0.5, n); // pmf(0)
  let sum = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= better) sum += pmf;
    pmf = (pmf * (n - k)) / (k + 1);
  }
  return Math.min(1, sum);
}

/**
 * Refuse a candidate that can't meaningfully be gated, BEFORE spending anything
 * on evals. The `candidate !== active` rule is the one that matters: in Aug 2026
 * CI inferred the candidate with `ls | sort -V | tail -1`, got the already-active
 * version, and ran two full evals of the same prompt against each other.
 */
export function validateCandidate(
  candidate: string,
  active: string,
  availableVersions: string[],
): string[] {
  const reasons: string[] = [];
  const candN = parseVersion(candidate);
  if (candN === null) {
    return [`candidate "${candidate}" is not a v<N> version`];
  }
  const activeN = parseVersion(active);
  if (activeN === null) {
    return [`active version "${active}" is not a v<N> version`];
  }
  if (candN === activeN) {
    reasons.push(
      `candidate ${candidate} is the ACTIVE version — there is nothing to compare it against`,
    );
  } else if (candN < activeN) {
    reasons.push(`candidate ${candidate} is older than the active version ${active}`);
  }
  if (!availableVersions.some((v) => parseVersion(v) === candN)) {
    reasons.push(`no prompt file exists for candidate ${candidate}`);
  }
  return reasons;
}

/** Cases that should have produced a score: scored, or errored while trying. */
function attempted(perCase: PerCaseScore[]): Set<string> {
  return new Set(perCase.filter((c) => c.aggregate !== null || c.errored).map((c) => c.id));
}

function scoredById(perCase: PerCaseScore[]): Map<string, PerCaseScore> {
  return new Map(
    perCase.filter((c) => c.aggregate !== null && !c.errored).map((c) => [c.id, c]),
  );
}

const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/** Pure comparison so the gate rule itself is unit-testable. */
export function compareReports(baseline: ModelReport, candidate: ModelReport): GateResult {
  if (!baseline.perCase || !candidate.perCase) {
    return compareAggregates(baseline, candidate);
  }

  const base = scoredById(baseline.perCase);
  const cand = scoredById(candidate.perCase);
  const ids = [...base.keys()].filter((id) => cand.has(id)).sort();

  // Non-event cases are unscored by design on both sides and must not count
  // against coverage; cases that errored while trying to score must.
  const expected = new Set([...attempted(baseline.perCase), ...attempted(candidate.perCase)]);
  if (expected.size > 0 && ids.length < MIN_PAIRED_COVERAGE * expected.size) {
    return {
      pass: false,
      reasons: [],
      baselineAggregate: baseline.aggregate,
      candidateAggregate: candidate.aggregate,
      paired: ids.length,
      unusable:
        `only ${ids.length} of ${expected.size} scorable cases scored on both sides ` +
        `(need ${(MIN_PAIRED_COVERAGE * 100).toFixed(0)}%) — too many errors to compare`,
    };
  }

  let better = 0;
  let worse = 0;
  let unchanged = 0;
  for (const id of ids) {
    const delta = (cand.get(id)!.aggregate as number) - (base.get(id)!.aggregate as number);
    if (delta > CASE_EPSILON) better++;
    else if (delta < -CASE_EPSILON) worse++;
    else unchanged++;
  }

  // Every summary statistic below is computed over the SAME paired case set, so
  // one arm losing a case to a transient error can no longer shift the numbers.
  const baselineAggregate = mean(ids.map((id) => base.get(id)!.aggregate as number));
  const candidateAggregate = mean(ids.map((id) => cand.get(id)!.aggregate as number));
  const pValue = signTestP(better, worse);

  const reasons: string[] = [];
  for (const field of Object.keys(baseline.fieldAccuracy)) {
    const baseAcc = mean(ids.map((id) => base.get(id)!.fields[field] ?? 0));
    const candAcc = mean(ids.map((id) => cand.get(id)!.fields[field] ?? 0));
    if (candAcc < baseAcc - FIELD_REGRESSION_TOLERANCE) {
      reasons.push(
        `field "${field}" regressed: ${(baseAcc * 100).toFixed(1)}% → ${(candAcc * 100).toFixed(1)}%`,
      );
    }
  }
  if (better <= worse) {
    reasons.push(`no net improvement: ${better} cases better, ${worse} worse`);
  } else if (pValue >= SIGN_TEST_ALPHA) {
    reasons.push(
      `improvement is within noise: ${better} better / ${worse} worse, ` +
        `sign test p=${pValue.toFixed(3)} (need p<${SIGN_TEST_ALPHA})`,
    );
  }
  if (candidateAggregate < baselineAggregate - 1e-9) {
    reasons.push(
      `mean aggregate decreased: ${(baselineAggregate * 100).toFixed(1)}% → ` +
        `${(candidateAggregate * 100).toFixed(1)}%`,
    );
  }
  const baseHalluc = mean(ids.map((id) => base.get(id)!.hallucinations));
  const candHalluc = mean(ids.map((id) => cand.get(id)!.hallucinations));
  if (candHalluc > baseHalluc + 0.05) {
    reasons.push(
      `hallucination rate worsened: ${baseHalluc.toFixed(2)} → ${candHalluc.toFixed(2)}`,
    );
  }

  return {
    pass: reasons.length === 0,
    reasons,
    baselineAggregate,
    candidateAggregate,
    paired: ids.length,
    better,
    worse,
    unchanged,
    pValue,
  };
}

/**
 * Legacy unpaired comparison, kept verbatim for reports predating per-case
 * scores (the committed baselines under `evals/reports`). Live gate runs take
 * the paired path above; this one cannot separate signal from noise, which is
 * precisely why it was replaced.
 */
function compareAggregates(baseline: ModelReport, candidate: ModelReport): GateResult {
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

export function renderGate(candidate: string, model: string, result: GateResult): string {
  const lines = [
    `# Prompt gate: candidate ${candidate} (${model})`,
    '',
    `Baseline aggregate: ${(result.baselineAggregate * 100).toFixed(1)}%`,
    `Candidate aggregate: ${(result.candidateAggregate * 100).toFixed(1)}%`,
  ];
  if (result.paired !== undefined && result.better !== undefined) {
    lines.push(
      '',
      `Paired cases: ${result.paired}`,
      `- improved: ${result.better}`,
      `- regressed: ${result.worse}`,
      `- unchanged: ${result.unchanged}`,
      `- sign test p = ${result.pValue?.toFixed(4)} (α = ${SIGN_TEST_ALPHA})`,
      '',
      'Classification stage excluded — the candidate only changes `extract-event`.',
    );
  }
  lines.push('', result.unusable ? '## ⚠️ UNUSABLE' : result.pass ? '## ✅ PASS' : '## ❌ FAIL');
  if (result.unusable) lines.push(`- ${result.unusable}`);
  lines.push(...result.reasons.map((r) => `- ${r}`));
  return lines.join('\n');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', '..', '..', 'backend', 'src', 'prompts');

const isMain = process.argv[1] && process.argv[1].endsWith('run-gate.ts');
if (isMain) {
  const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
  };
  const candidate = arg('candidate', '');
  if (!candidate) {
    console.error('Usage: npm run gate -- --candidate v4 [--model <model>]');
    process.exit(2);
  }
  const model = arg('model', DEFAULT_MODELS.extract);

  // Validate before spending anything on evals.
  const active = ACTIVE_VERSIONS['extract-event'];
  const problems = validateCandidate(
    candidate,
    active,
    extractEventVersions(readdirSync(PROMPTS_DIR)),
  );
  if (problems.length > 0) {
    console.error(`Refusing to run the gate on candidate ${candidate}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }

  (async () => {
    console.log(`Gate: pinned prompt ${active} vs candidate ${candidate} on ${model}\n`);
    // classify: false — the candidate only changes `extract-event`, so the
    // classify call is identical in both arms: no signal, and the largest single
    // noise source (a flip to is_event:false zeroes a whole case).
    const baseline = await runEval({
      models: [model],
      dataset: 'all',
      classify: false,
      label: `gate-baseline-${candidate}`,
    });
    const cand = await runEval({
      models: [model],
      dataset: 'all',
      promptVersion: candidate,
      classify: false,
      label: `gate-candidate-${candidate}`,
    });
    const result = compareReports(baseline.reports[0]!, cand.reports[0]!);

    const summary = renderGate(candidate, model, result);
    writeFileSync(join(cand.reportDir, 'gate.md'), summary);
    // Counts only — per-case ids are `corr-<captureId>` for real cases, and this
    // repo is public. The id-bearing report.json stays in the run artifact.
    writeFileSync(
      join(cand.reportDir, 'gate.json'),
      `${JSON.stringify({ candidate, model, ...result, reasons: result.reasons }, null, 2)}\n`,
    );
    console.log(`\n${summary}`);
    if (result.unusable) process.exit(2);
    process.exit(result.pass ? 0 : 1);
  })().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
