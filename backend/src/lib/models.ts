// The ONLY place model IDs, prices, and per-stage defaults live.
// Prices are USD per million tokens (see https://platform.claude.com/docs/en/pricing),
// checked against Anthropic's model reference as cached on 2026-10-06.
// The eval harness (evals/) imports this table so cost reports stay honest.
import { logger } from './logger.js';

export interface ModelInfo {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Whether the model supports output_config.format structured outputs. */
  structuredOutputs: boolean;
}

export const MODELS: Record<string, ModelInfo> = {
  'claude-haiku-4-5': {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    structuredOutputs: true,
  },
  'claude-haiku-5-5': {
    // Rate for prompts up to 100K tokens ($0.50/$2.50 above that). Pipeline
    // prompts are an image and a page of text, a few thousand tokens.
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    structuredOutputs: true,
  },
  'claude-sonnet-4-6': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    structuredOutputs: false,
  },
  'claude-sonnet-5': {
    // $2/$10 per the model reference (2026-10-06), not the $3/$15 this table
    // used to carry.
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    structuredOutputs: true,
  },
  'claude-sonnet-5-5': {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    structuredOutputs: true,
  },
  'claude-opus-4-8': {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
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

export type PipelineStage = 'classify' | 'extract';

/**
 * Throws unless `model` is in MODELS. Runs at module load for DEFAULT_MODELS,
 * and at Lambda cold start for the CLASSIFY_MODEL / EXTRACT_MODEL overrides,
 * so a typo or an unlisted model fails before any capture is processed rather
 * than being billed at $0.
 */
export function assertKnownModel(model: string, use: PipelineStage | 'proposePrompt'): void {
  if (!MODELS[model]) {
    throw new Error(
      `Model "${model}" (${use}) is not in MODELS in backend/src/lib/models.ts. ` +
        'Add its prices there before using it.',
    );
  }
}

for (const [use, model] of Object.entries(DEFAULT_MODELS)) {
  assertKnownModel(model, use as keyof typeof DEFAULT_MODELS);
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const info = MODELS[model];
  if (!info) {
    // Logged rather than thrown: by now the call has been made and paid for,
    // and throwing would discard the response. assertKnownModel is what stops
    // an unknown model reaching this point.
    logger.error('model_price_missing', { model });
    return 0;
  }
  return (
    (inputTokens / 1_000_000) * info.inputPerMTok +
    (outputTokens / 1_000_000) * info.outputPerMTok
  );
}
