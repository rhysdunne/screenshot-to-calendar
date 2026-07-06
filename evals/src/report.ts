// Markdown report rendering — the artifact that answers "which model is good
// enough to process the images, and what does it cost".
export interface ModelReport {
  model: string;
  cases: number;
  aggregate: number;
  fieldAccuracy: Record<string, number>;
  hallucinationRate: number;
  missRate: number;
  classificationAccuracy: number | null;
  meanLatencyMs: number;
  p95LatencyMs: number;
  costPer100Images: number;
  errors: number;
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
    '| Model | Aggregate | Halluc./case | Miss/case | Classify | p95 latency | $/100 images |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of reports) {
    lines.push(
      `| ${r.model} | **${pct(r.aggregate)}** | ${r.hallucinationRate.toFixed(2)} | ${r.missRate.toFixed(2)} | ${
        r.classificationAccuracy === null ? '—' : pct(r.classificationAccuracy)
      } | ${(r.p95LatencyMs / 1000).toFixed(1)}s | $${r.costPer100Images.toFixed(2)} |`,
    );
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
    '',
  );
  return lines.filter((l) => l !== undefined).join('\n');
}
