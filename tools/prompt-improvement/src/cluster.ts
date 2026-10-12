// Pure clustering logic for correction records — the poisoning defenses live
// here and are unit-tested:
//   #2  a pattern is only eligible with corrections from ≥3 DISTINCT captures
//   (+) only consented corrections ever reach this module (filtered upstream)
//   (+) only the owner's corrections reach it: aggregate reads one partition
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

/**
 * Keep only corrections whose capture still exists. Deleting a capture
 * removes the capture and its image but leaves its CORRECTION items, and a
 * capture the user deleted must not steer a prompt change. `liveCaptures`
 * holds `${userId}/${captureId}` for every capture in the table.
 */
export function dropOrphanedCorrections(
  corrections: CorrectionRecord[],
  liveCaptures: ReadonlySet<string>,
): CorrectionRecord[] {
  return corrections.filter((c) => liveCaptures.has(`${c.userId}/${c.captureId}`));
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

function verbFor(kind: FailurePattern['kind']): string {
  return kind === 'miss'
    ? 'was missed (extracted null, user filled it in)'
    : kind === 'hallucination'
      ? 'was hallucinated (extracted a value, user cleared it)'
      : 'was extracted incorrectly';
}

/**
 * The pattern with up to five example corrections, old and new values
 * included. For the proposal prompt sent to Claude only: never print it,
 * because the values are what users typed, and CI logs on this repo are
 * public. Use summarizePattern for console output.
 */
export function describePattern(p: FailurePattern): string {
  const examples = p.corrections
    .slice(0, 5)
    .map((c) => `  - capture ${c.captureId}: "${c.oldValue ?? '(null)'}" → "${c.newValue ?? '(null)'}"`)
    .join('\n');
  return `Field "${p.field}" ${verbFor(p.kind)} across ${p.distinctCaptures} independent captures:\n${examples}`;
}

/** Field name and counts only, safe for a public CI log. */
export function summarizePattern(p: FailurePattern): string {
  return (
    `Field "${p.field}" ${verbFor(p.kind)}: ` +
    `${p.corrections.length} corrections across ${p.distinctCaptures} independent captures`
  );
}
