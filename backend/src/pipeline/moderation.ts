// Pure moderation decision: given Rekognition labels + a policy, decide whether
// to block. No AWS/network imports — the client that produces these labels lives
// in lib/rekognition.ts. This mirrors the callClaude → pipeline/extract split and
// keeps the rule unit-testable without hitting Rekognition.

export interface ModerationLabel {
  /** Specific label, e.g. "Explicit Nudity" or a sub-label. */
  name: string;
  /** Top-level category the label rolls up to; '' for a top-level label. */
  parentName: string;
  /** 0–100. */
  confidence: number;
}

export interface ModerationPolicy {
  /** Top-level categories that cause a block, e.g. ['Explicit Nudity']. */
  blockCategories: string[];
  /** Minimum Rekognition confidence (0–100) for a label to count. */
  minConfidence: number;
}

/**
 * Blocks when any label whose top-level category (`parentName`, or `name` for a
 * top-level label) matches one of `blockCategories` at or above `minConfidence`.
 * Category matching is case-insensitive so env config need not match Rekognition's
 * exact casing. A benign gig poster tagged only `Alcohol`/`Rude Gestures` passes.
 */
export function isBlocked(labels: ModerationLabel[], policy: ModerationPolicy): boolean {
  const blocked = new Set(policy.blockCategories.map((c) => c.trim().toLowerCase()));
  return labels.some((label) => {
    if (label.confidence < policy.minConfidence) return false;
    const category = (label.parentName || label.name).toLowerCase();
    return blocked.has(category);
  });
}
