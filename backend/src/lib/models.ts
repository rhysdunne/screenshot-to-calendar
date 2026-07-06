// The ONLY place model IDs, prices, and per-stage defaults live.
// Prices are USD per million tokens (see https://platform.claude.com/docs/en/pricing).
// The eval harness (evals/) imports this table so cost reports stay honest.

export interface ModelInfo {
  inputPerMTok: number;
  outputPerMTok: number;
  maxOutputTokens: number;
  /** Whether the model supports output_config.format structured outputs. */
  structuredOutputs: boolean;
}

export const MODELS: Record<string, ModelInfo> = {
  'claude-haiku-4-5': {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    maxOutputTokens: 64_000,
    structuredOutputs: true,
  },
  'claude-sonnet-4-6': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    maxOutputTokens: 128_000,
    structuredOutputs: false,
  },
  'claude-sonnet-5': {
    // Intro pricing $2/$10 through 2026-08-31; sticker $3/$15 used here.
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    maxOutputTokens: 128_000,
    structuredOutputs: true,
  },
  'claude-opus-4-8': {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    maxOutputTokens: 128_000,
    structuredOutputs: true,
  },
};

/** Per-pipeline-stage defaults. Overridable via Lambda env (CLASSIFY_MODEL / EXTRACT_MODEL). */
export const DEFAULT_MODELS = {
  classify: 'claude-haiku-4-5',
  extract: 'claude-sonnet-5',
  /** Used offline by tools/prompt-improvement, never in the request path. */
  proposePrompt: 'claude-opus-4-8',
} as const;

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const info = MODELS[model];
  if (!info) return 0;
  return (
    (inputTokens / 1_000_000) * info.inputPerMTok +
    (outputTokens / 1_000_000) * info.outputPerMTok
  );
}
