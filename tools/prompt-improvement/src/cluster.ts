// Pure clustering logic for correction records — the poisoning defenses live
// here and are unit-tested:
//   #2  a pattern is only eligible with corrections from ≥3 DISTINCT captures
//   (+) only consented corrections ever reach this module (filtered upstream)
import type { CorrectionRecord } from '../../../backend/src/lib/ddb.js';

export const MIN_INDEPENDENT_CAPTURES = 3;

export interface FailurePattern {
  /** e.g. "end_date:miss" — field plus the direction of the error. */
  key: string;
  field: string;
  kind: 'miss' | 'hallucination' | 'wrong_value';
  corrections: CorrectionRecord[];
  distinctCaptures: number;
}

function kindOf(c: CorrectionRecord): FailurePattern['kind'] {
  if (c.oldValue === null && c.newValue !== null) return 'miss';
  if (c.oldValue !== null && c.newValue === null) return 'hallucination';
  return 'wrong_value';
}

/**
 * Group corrections into failure patterns and drop any pattern that fewer
 * than MIN_INDEPENDENT_CAPTURES distinct captures exhibit. A single user
 * hammering one capture with edits cannot create an eligible pattern.
 */
export function clusterCorrections(corrections: CorrectionRecord[]): FailurePattern[] {
  const groups = new Map<string, CorrectionRecord[]>();
  for (const c of corrections) {
    if (!c.consentEvalUse) continue; // belt-and-braces: consent only
    const key = `${c.field}:${kindOf(c)}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  const patterns: FailurePattern[] = [];
  for (const [key, list] of groups) {
    const distinctCaptures = new Set(list.map((c) => c.captureId)).size;
    if (distinctCaptures < MIN_INDEPENDENT_CAPTURES) continue;
    const [field, kind] = key.split(':') as [string, FailurePattern['kind']];
    patterns.push({ key, field, kind, corrections: list, distinctCaptures });
  }
  return patterns.sort((a, b) => b.distinctCaptures - a.distinctCaptures);
}

export function describePattern(p: FailurePattern): string {
  const examples = p.corrections
    .slice(0, 5)
    .map((c) => `  - capture ${c.captureId}: "${c.oldValue ?? '(null)'}" → "${c.newValue ?? '(null)'}"`)
    .join('\n');
  const verb =
    p.kind === 'miss'
      ? 'was missed (extracted null, user filled it in)'
      : p.kind === 'hallucination'
        ? 'was hallucinated (extracted a value, user cleared it)'
        : 'was extracted incorrectly';
  return `Field "${p.field}" ${verb} across ${p.distinctCaptures} independent captures:\n${examples}`;
}
