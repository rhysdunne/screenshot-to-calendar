// Model-comparison eval harness. Runs every dataset case through the REAL
// production request path (backend lib/anthropic + prompts + pipeline
// parsing) and scores field-by-field against gold. The output report answers
// "which model is good enough, and what does it cost".
//
//   ANTHROPIC_API_KEY=... npm run eval -- --models claude-haiku-4-5,claude-sonnet-5
//   npm run eval -- --mock                      # plumbing check, no API calls
//   npm run eval -- --prompt-version v3         # eval a candidate prompt (gate)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callClaude } from '../../backend/src/lib/anthropic.js';
import { extractSchemaFor, loadPrompt, renderPrompt } from '../../backend/src/prompts/prompts.js';
import { CLASSIFY_IMAGE_SCHEMA } from '../../backend/src/prompts/schemas.js';
import { extractEventData } from '../../backend/src/pipeline/extract.js';
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

export function loadDataset(which: 'synthetic' | 'real' | 'all', limit?: number): DatasetCase[] {
  const dirs = which === 'all' ? ['synthetic', 'real'] : [which];
  const cases: DatasetCase[] = [];
  for (const d of dirs) {
    const root = join(DATASET_ROOT, d);
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
      };
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
  latencyMs: number;
  costUsd: number;
  error?: string;
}

async function runCase(
  model: string,
  c: DatasetCase,
  opts: { apiKey: string; promptVersion?: string; mock: boolean },
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

  // Classification stage (always measured when gold classification exists).
  let classificationCorrect: boolean | null = null;
  let isEvent = true;
  if (c.classification) {
    const call = await callClaude({
      apiKey: opts.apiKey,
      model,
      prompt: loadPrompt('classify-image'),
      imageBase64: c.imageBase64,
      mediaType,
      schema: CLASSIFY_IMAGE_SCHEMA,
      maxTokens: 256,
      stage: 'classify',
    });
    latencyMs += call.usage.latencyMs;
    costUsd += call.usage.costUsd;
    const predicted = JSON.parse(
      (call.response.content[0] as { text?: string })?.text ?? '{}',
    ) as Classification;
    const cls = scoreClassification(c.classification, predicted);
    classificationCorrect = cls.categoryCorrect && cls.isEventCorrect;
    isEvent = predicted.is_event;
    if (c.classification.is_event === false) {
      // Non-event case: extraction is not scored.
      return { id: c.id, score: null, classificationCorrect, latencyMs, costUsd };
    }
  }

  if (!isEvent) {
    // Model wrongly classified an event as non-event — worst extraction score.
    const zero = scoreCase(c.gold, {
      title: null, venue: null, address: null, start_date: null, end_date: null,
      start_time: null, end_time: null, description: null, url: null, confidence: 'low',
    });
    return { id: c.id, score: zero, classificationCorrect, latencyMs, costUsd };
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
    maxTokens: 1024,
    stage: 'extract',
  });
  latencyMs += call.usage.latencyMs;
  costUsd += call.usage.costUsd;
  const predicted = extractEventData(call.response);
  return {
    id: c.id,
    score: scoreCase(c.gold, predicted),
    classificationCorrect,
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

export function summarize(model: string, results: CaseResult[]): ModelReport {
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
    meanLatencyMs: latencies.length
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0,
    p95LatencyMs: percentile(latencies, 95),
    costPer100Images: results.length
      ? (results.reduce((a, r) => a + r.costUsd, 0) / results.length) * 100
      : 0,
    errors: results.filter((r) => r.error).length,
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
    reports.push(summarize(model, results));
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
  runEval({
    models: arg('models', 'claude-haiku-4-5').split(','),
    dataset: arg('dataset', 'synthetic') as 'synthetic' | 'real' | 'all',
    limit: process.argv.includes('--limit') ? Number(arg('limit', '0')) : undefined,
    promptVersion: process.argv.includes('--prompt-version')
      ? arg('prompt-version', '')
      : undefined,
    mock: process.argv.includes('--mock'),
    label: process.argv.includes('--label') ? arg('label', '') : undefined,
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
