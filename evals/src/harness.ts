// Model-comparison eval harness. Runs every dataset case through the REAL
// production request path (backend lib/anthropic + prompts + pipeline
// parsing) and scores field-by-field against gold. The output report answers
// "which model is good enough, and what does it cost".
//
//   ANTHROPIC_API_KEY=... npm run eval -- --models claude-haiku-4-5,claude-sonnet-5
//   npm run eval -- --mock                      # plumbing check, no API calls
//   npm run eval -- --prompt-version v4         # eval a candidate prompt (gate)
//   npm run eval -- --no-classify               # extract only (skip classify stage)
//   npm run eval -- --thinking between_tools --effort medium [--max-tokens 2048]
//                     # compare thinking settings: each flag replaces that field
//                     # of the MODELS tuning for every stage the run calls
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callClaude } from '../../backend/src/lib/anthropic.js';
import {
  stageTuning,
  type PipelineStage,
  type StageTuning,
} from '../../backend/src/lib/models.js';
import { extractSchemaFor, loadPrompt, renderPrompt } from '../../backend/src/prompts/prompts.js';
import { CLASSIFY_IMAGE_SCHEMA } from '../../backend/src/prompts/schemas.js';
import { extractClassification, extractEventData } from '../../backend/src/pipeline/extract.js';
import { detectMediaType } from '../../backend/src/pipeline/image.js';
import type { Classification, ExtractedEvent } from '../../backend/src/pipeline/types.js';
import { scoreCase, scoreClassification, SCORED_FIELDS, type CaseScore } from './score.js';
import { renderReport, type ModelReport } from './report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASET_ROOT = join(__dirname, '..', 'dataset');
const REPORTS_DIR = join(__dirname, '..', 'reports');

export interface DatasetCase {
  id: string;
  imagePath: string;
  imageBase64: string;
  gold: ExtractedEvent;
  frozenToday: string;
  classification?: Classification;
}

export function loadDataset(
  which: 'synthetic' | 'real' | 'all',
  limit?: number,
  datasetRoot: string = DATASET_ROOT,
): DatasetCase[] {
  const dirs = which === 'all' ? ['synthetic', 'real'] : [which];
  const cases: DatasetCase[] = [];
  for (const d of dirs) {
    const root = join(datasetRoot, d);
    if (!existsSync(root)) continue;
    for (const id of readdirSync(root).sort()) {
      const caseDir = join(root, id);
      const imagePath = ['image.png', 'image.jpg', 'image.jpeg']
        .map((f) => join(caseDir, f))
        .find(existsSync);
      if (!imagePath) continue;
      const gold = JSON.parse(readFileSync(join(caseDir, 'gold.json'), 'utf8')) as ExtractedEvent;
      const meta = JSON.parse(readFileSync(join(caseDir, 'meta.json'), 'utf8')) as {
        frozenToday: string;
        classification?: Classification;
        consent?: unknown;
      };
      // Real cases are people's screenshots. A case without recorded consent
      // stops the run, so consent is checked here rather than trusted to
      // whoever added the files (#88).
      if (d === 'real' && meta.consent !== true) {
        throw new Error(
          `Eval case real/${id} has no "consent": true in its meta.json. Only add ` +
            'images you have consent to use (docs/adding-eval-images.md).',
        );
      }
      cases.push({
        id,
        imagePath,
        imageBase64: readFileSync(imagePath).toString('base64'),
        gold,
        frozenToday: meta.frozenToday,
        classification: meta.classification,
      });
    }
  }
  return limit ? cases.slice(0, limit) : cases;
}

interface CaseResult {
  id: string;
  score: CaseScore | null; // null for non-event cases
  classificationCorrect: boolean | null;
  /** is_event alone: the bit that decides whether a capture is processed. */
  isEventCorrect?: boolean | null;
  latencyMs: number;
  costUsd: number;
  error?: string;
}

/** The stage's MODELS tuning with any harness override laid over it. */
function tuningFor(
  model: string,
  stage: PipelineStage,
  override: Partial<StageTuning> | undefined,
): StageTuning {
  return { ...stageTuning(model, stage), ...override };
}

async function runCase(
  model: string,
  c: DatasetCase,
  opts: {
    apiKey: string;
    promptVersion?: string;
    mock: boolean;
    classify: boolean;
    tuning?: Partial<StageTuning>;
  },
): Promise<CaseResult> {
  if (opts.mock) {
    return {
      id: c.id,
      score: c.classification?.is_event === false ? null : scoreCase(c.gold, c.gold),
      classificationCorrect: true,
      latencyMs: 0,
      costUsd: 0,
    };
  }

  const mediaType = detectMediaType(c.imageBase64);
  let latencyMs = 0;
  let costUsd = 0;

  // Classification stage (measured when gold classification exists). With
  // `classify: false` the stage is skipped and gold is trusted instead: when only
  // the extract prompt is under test, re-running an unchanged classify prompt adds
  // cost and variance but no signal.
  let classificationCorrect: boolean | null = null;
  let isEventCorrect: boolean | null = null;
  let isEvent = c.classification?.is_event ?? true;
  if (c.classification && opts.classify) {
    const call = await callClaude({
      apiKey: opts.apiKey,
      model,
      prompt: loadPrompt('classify-image'),
      imageBase64: c.imageBase64,
      mediaType,
      schema: CLASSIFY_IMAGE_SCHEMA,
      stage: 'classify',
      tuning: tuningFor(model, 'classify', opts.tuning),
    });
    latencyMs += call.usage.latencyMs;
    costUsd += call.usage.costUsd;
    const predicted = extractClassification(call.response);
    const cls = scoreClassification(c.classification, predicted);
    classificationCorrect = cls.categoryCorrect && cls.isEventCorrect;
    isEventCorrect = cls.isEventCorrect;
    isEvent = predicted.is_event;
  }

  if (c.classification?.is_event === false) {
    // Non-event case: extraction is not scored, by design and on both arms.
    return { id: c.id, score: null, classificationCorrect, isEventCorrect, latencyMs, costUsd };
  }

  if (!isEvent) {
    // Model wrongly classified an event as non-event — worst extraction score.
    const zero = scoreCase(c.gold, {
      title: null, venue: null, address: null, start_date: null, end_date: null,
      start_time: null, end_time: null, description: null, url: null, confidence: 'low',
    });
    return { id: c.id, score: zero, classificationCorrect, isEventCorrect, latencyMs, costUsd };
  }

  const call = await callClaude({
    apiKey: opts.apiKey,
    model,
    prompt: renderPrompt(loadPrompt('extract-event', opts.promptVersion), {
      today: c.frozenToday,
      timeZone: 'Europe/London',
    }),
    imageBase64: c.imageBase64,
    mediaType,
    schema: extractSchemaFor(opts.promptVersion),
    stage: 'extract',
    tuning: tuningFor(model, 'extract', opts.tuning),
  });
  latencyMs += call.usage.latencyMs;
  costUsd += call.usage.costUsd;
  const predicted = extractEventData(call.response);
  return {
    id: c.id,
    score: scoreCase(c.gold, predicted),
    classificationCorrect,
    isEventCorrect,
    latencyMs,
    costUsd,
  };
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i] as T);
      }
    }),
  );
  return results;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

export function summarize(
  model: string,
  results: CaseResult[],
  tuning?: ModelReport['tuning'],
): ModelReport {
  const scored = results.filter((r): r is CaseResult & { score: CaseScore } => r.score !== null);
  const fieldAccuracy: Record<string, number> = {};
  for (const field of SCORED_FIELDS) {
    const scores = scored.map(
      (r) => r.score.fields.find((f) => f.field === field)?.score ?? 0,
    );
    fieldAccuracy[field] = scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0;
  }
  const classified = results.filter((r) => r.classificationCorrect !== null);
  const isEventScored = results.filter(
    (r) => r.isEventCorrect !== null && r.isEventCorrect !== undefined,
  );
  const latencies = results.map((r) => r.latencyMs);
  return {
    model,
    cases: results.length,
    aggregate: scored.length
      ? scored.reduce((a, r) => a + r.score.aggregate, 0) / scored.length
      : 0,
    fieldAccuracy,
    hallucinationRate: scored.length
      ? scored.reduce((a, r) => a + r.score.hallucinations, 0) / scored.length
      : 0,
    missRate: scored.length
      ? scored.reduce((a, r) => a + r.score.misses, 0) / scored.length
      : 0,
    classificationAccuracy: classified.length
      ? classified.filter((r) => r.classificationCorrect).length / classified.length
      : null,
    isEventAccuracy: isEventScored.length
      ? isEventScored.filter((r) => r.isEventCorrect).length / isEventScored.length
      : null,
    meanLatencyMs: latencies.length
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0,
    p95LatencyMs: percentile(latencies, 95),
    costPer100Images: results.length
      ? (results.reduce((a, r) => a + r.costUsd, 0) / results.length) * 100
      : 0,
    errors: results.filter((r) => r.error).length,
    ...(tuning ? { tuning } : {}),
    perCase: results.map((r) => ({
      id: r.id,
      aggregate: r.score ? r.score.aggregate : null,
      fields: Object.fromEntries((r.score?.fields ?? []).map((f) => [f.field, f.score])),
      hallucinations: r.score?.hallucinations ?? 0,
      misses: r.score?.misses ?? 0,
      errored: r.error !== undefined,
    })),
  };
}

export interface EvalRunResult {
  reports: ModelReport[];
  reportDir: string;
}

export async function runEval(options: {
  models: string[];
  dataset: 'synthetic' | 'real' | 'all';
  limit?: number;
  promptVersion?: string;
  mock?: boolean;
  label?: string;
  /**
   * Run the classify stage (default true). Set false when only the extract
   * prompt is under test — see the note in `runCase`.
   */
  classify?: boolean;
  /**
   * Fields laid over each stage's MODELS tuning, to compare thinking settings
   * before one goes into MODELS. Omit to measure what production sends.
   */
  tuning?: Partial<StageTuning>;
}): Promise<EvalRunResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!options.mock && !apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for a live eval (or pass --mock)');
  }
  const cases = loadDataset(options.dataset, options.limit);
  if (cases.length === 0) {
    throw new Error(`No dataset cases found — run \`npm run generate\` first`);
  }

  const reports: ModelReport[] = [];
  for (const model of options.models) {
    console.log(`\n=== ${model} on ${cases.length} cases ===`);
    const results = await pool(cases, 4, async (c) => {
      try {
        const r = await runCase(model, c, {
          apiKey,
          promptVersion: options.promptVersion,
          mock: options.mock ?? false,
          classify: options.classify ?? true,
          tuning: options.tuning,
        });
        console.log(
          `  ${c.id}: ${r.score ? r.score.aggregate.toFixed(2) : 'n/a'} ($${r.costUsd.toFixed(4)})`,
        );
        return r;
      } catch (e) {
        console.error(`  ${c.id}: ERROR ${(e as Error).message}`);
        return {
          id: c.id,
          score: null,
          classificationCorrect: null,
          latencyMs: 0,
          costUsd: 0,
          error: String(e),
        } satisfies CaseResult;
      }
    });
    const classify = options.classify ?? true;
    reports.push(
      summarize(model, results, {
        ...(classify ? { classify: tuningFor(model, 'classify', options.tuning) } : {}),
        extract: tuningFor(model, 'extract', options.tuning),
      }),
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = join(REPORTS_DIR, options.label ?? stamp);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, 'report.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dataset: options.dataset,
        promptVersion: options.promptVersion ?? 'pinned',
        mock: options.mock ?? false,
        classify: options.classify ?? true,
        tuningOverride: options.tuning ?? null,
        reports,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(reportDir, 'report.md'), renderReport(reports, options));
  console.log(`\nReport written to ${reportDir}`);
  return { reports, reportDir };
}

// CLI entry.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
  };
  const tuningOverride = (): Partial<StageTuning> | undefined => {
    const has = (name: string) => process.argv.includes(`--${name}`);
    if (!has('thinking') && !has('effort') && !has('max-tokens')) return undefined;
    return {
      ...(has('thinking') ? { thinking: arg('thinking', '') as StageTuning['thinking'] } : {}),
      ...(has('effort') ? { effort: arg('effort', '') as StageTuning['effort'] } : {}),
      ...(has('max-tokens') ? { maxTokens: Number(arg('max-tokens', '0')) } : {}),
    };
  };
  runEval({
    models: arg('models', 'claude-haiku-4-5').split(','),
    dataset: arg('dataset', 'synthetic') as 'synthetic' | 'real' | 'all',
    limit: process.argv.includes('--limit') ? Number(arg('limit', '0')) : undefined,
    promptVersion: process.argv.includes('--prompt-version')
      ? arg('prompt-version', '')
      : undefined,
    mock: process.argv.includes('--mock'),
    label: process.argv.includes('--label') ? arg('label', '') : undefined,
    classify: !process.argv.includes('--no-classify'),
    tuning: tuningOverride(),
  })
    .then(({ reports }) => {
      // runCase errors are caught per case so one bad call does not sink a run,
      // but a revoked key or a retired model errors every case and the run
      // would still exit 0. Any errored case fails the process instead, so a
      // scheduled eval goes red.
      const errored = reports.filter((r) => r.errors > 0);
      for (const r of errored) {
        console.error(`${r.model}: ${r.errors} of ${r.cases} cases errored`);
      }
      if (errored.length > 0) process.exit(1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
