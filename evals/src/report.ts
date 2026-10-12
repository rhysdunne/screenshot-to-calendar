// Markdown report rendering — the artifact that answers "which model is good
// enough to process the images, and what does it cost".
import type { PipelineStage, StageTuning } from '../../backend/src/lib/models.js';

/**
 * One case's score, retained so two runs can be compared PAIRED (same case,
 * baseline vs candidate) instead of as two independent means. See
 * `tools/prompt-improvement/src/run-gate.ts` for why that matters.
 */
export interface PerCaseScore {
  id: string;
  /** Null for non-event cases (unscored by design) and for errored cases. */
  aggregate: number | null;
  fields: Record<string, number>;
  hallucinations: number;
  misses: number;
  /** True only when the case threw — distinguishes an error from a non-event. */
  errored: boolean;
}

export interface ModelReport {
  model: string;
  cases: number;
  aggregate: number;
  fieldAccuracy: Record<string, number>;
  hallucinationRate: number;
  missRate: number;
  classificationAccuracy: number | null;
  /** is_event alone. Optional: absent from reports generated before it was kept. */
  isEventAccuracy?: number | null;
  meanLatencyMs: number;
  p95LatencyMs: number;
  costPer100Images: number;
  errors: number;
  /** Thinking, effort and max tokens each stage sent. Absent from older reports. */
  tuning?: Partial<Record<PipelineStage, StageTuning>>;
  /** Optional: absent from reports generated before per-case scores were kept. */
  perCase?: PerCaseScore[];
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

export function renderReport(
  reports: ModelReport[],
  options: { dataset: string; promptVersion?: string; mock?: boolean },
): string {
  const lines: string[] = [
    '# Extraction eval report',
    '',
    `- Dataset: \`${options.dataset}\``,
    `- Prompt version: \`${options.promptVersion ?? 'pinned'}\``,
    `- Generated: ${new Date().toISOString()}`,
    options.mock ? '- ⚠️ MOCK RUN (no API calls — plumbing check only)' : '',
    '',
    '## Summary',
    '',
    '| Model | Aggregate | Halluc./case | Miss/case | Classify | is_event | Errors | Mean latency | p95 latency | $/100 images |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  const pctOrDash = (v: number | null | undefined): string =>
    v === null || v === undefined ? '—' : pct(v);
  for (const r of reports) {
    lines.push(
      `| ${r.model} | **${pct(r.aggregate)}** | ${r.hallucinationRate.toFixed(2)} | ${r.missRate.toFixed(2)} | ${pctOrDash(
        r.classificationAccuracy,
      )} | ${pctOrDash(r.isEventAccuracy)} | ${r.errors} | ${(r.meanLatencyMs / 1000).toFixed(1)}s | ${(
        r.p95LatencyMs / 1000
      ).toFixed(1)}s | $${r.costPer100Images.toFixed(2)} |`,
    );
  }
  const tuned = reports.filter((r) => r.tuning);
  if (tuned.length > 0) {
    lines.push('', '## Thinking settings', '');
    const describe = (t: StageTuning): string =>
      `thinking ${t.thinking}, effort ${t.effort ?? 'not sent'}, max ${t.maxTokens} tokens`;
    for (const r of tuned) {
      for (const [stage, t] of Object.entries(r.tuning ?? {})) {
        lines.push(`- ${r.model} ${stage}: ${describe(t)}`);
      }
    }
  }
  lines.push('', '## Per-field accuracy', '');
  const fields = Object.keys(reports[0]?.fieldAccuracy ?? {});
  lines.push(`| Field | ${reports.map((r) => r.model).join(' | ')} |`);
  lines.push(`|---|${reports.map(() => '---').join('|')}|`);
  for (const field of fields) {
    lines.push(
      `| ${field} | ${reports.map((r) => pct(r.fieldAccuracy[field] ?? 0)).join(' | ')} |`,
    );
  }
  lines.push(
    '',
    '## Reading this report',
    '',
    '- **Aggregate** weights dates ×2 and title ×1.5 — a model below ~85% here',
    '  creates wrong calendar entries often enough to erode trust.',
    '- **Halluc./case** counts fields invented where gold is null (worse than a',
    '  miss: a made-up address sends you to the wrong place).',
    '- **$/100 images** uses the price table in `backend/src/lib/models.ts`.',
    '- **is_event** is the classify bit that gates processing; **Classify** also',
    '  needs the category right, which nothing downstream uses yet.',
    '',
  );
  return lines.filter((l) => l !== undefined).join('\n');
}
