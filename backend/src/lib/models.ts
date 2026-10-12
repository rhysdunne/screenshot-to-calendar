// The ONLY place model IDs, prices, and per-stage defaults live.
// Prices are USD per million tokens (see https://platform.claude.com/docs/en/pricing),
// checked against Anthropic's model reference as cached on 2026-10-06.
// The eval harness (evals/) imports this table so cost reports stay honest.
import { logger } from './logger.js';

export type PipelineStage = 'classify' | 'extract';

/**
 * How one pipeline stage calls one model. callClaude sends every field on
 * every call instead of leaving it to API defaults, because the defaults
 * differ by model: Sonnet 5 thinks when `thinking` is omitted and Haiku 4.5
 * does not, and Haiku 5.5 defaults to medium effort where Sonnet uses high.
 * Giving a stage a new model therefore means choosing these in the same change.
 */
export interface StageTuning {
  /** Sonnet 5.5 rejects 'disabled'; its thinking-off setting is 'between_tools'. */
  thinking: 'adaptive' | 'disabled' | 'between_tools';
  /** Omitted only where the model rejects output_config.effort (Haiku 4.5). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Thinking tokens count against this as well as the JSON reply. */
  maxTokens: number;
}

export interface ModelInfo {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Whether the model supports output_config.format structured outputs. */
  structuredOutputs: boolean;
  /** A model with no tuning for a stage cannot run that stage (stageTuning throws). */
  tuning?: Partial<Record<PipelineStage, StageTuning>>;
}

export const MODELS: Record<string, ModelInfo> = {
  'claude-haiku-4-5': {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    structuredOutputs: true,
    // No adaptive thinking or effort on this model.
    tuning: {
      classify: { thinking: 'disabled', maxTokens: 256 },
      extract: { thinking: 'disabled', maxTokens: 1024 },
    },
  },
  'claude-haiku-5-5': {
    // Rate for prompts up to 100K tokens ($0.50/$2.50 above that). Pipeline
    // prompts are an image and a page of text, a few thousand tokens.
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    structuredOutputs: true,
    // Thinking is on by default here; 'disabled' is accepted up to high effort.
    tuning: {
      classify: { thinking: 'disabled', effort: 'low', maxTokens: 256 },
      extract: { thinking: 'disabled', effort: 'low', maxTokens: 1024 },
    },
  },
  'claude-sonnet-4-6': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    structuredOutputs: false,
    tuning: {
      classify: { thinking: 'disabled', effort: 'high', maxTokens: 256 },
      extract: { thinking: 'disabled', effort: 'high', maxTokens: 1024 },
    },
  },
  'claude-sonnet-5': {
    // $2/$10 per the model reference (2026-10-06), not the $3/$15 this table
    // used to carry.
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    structuredOutputs: true,
    // extract: thinking off scored the same as the adaptive thinking the API
    // ran when none was sent, for no more cost or latency, and leaves all of
    // max_tokens to the JSON (evals/reports/model-refresh-2026-10/).
    // classify: what the API did when no thinking or effort was sent.
    tuning: {
      classify: { thinking: 'adaptive', effort: 'high', maxTokens: 256 },
      extract: { thinking: 'disabled', effort: 'high', maxTokens: 1024 },
    },
  },
  'claude-sonnet-5-5': {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    structuredOutputs: true,
    // 'between_tools' is accepted at high effort or below.
    tuning: {
      classify: { thinking: 'between_tools', effort: 'low', maxTokens: 256 },
      extract: { thinking: 'between_tools', effort: 'low', maxTokens: 1024 },
    },
  },
  'claude-opus-4-8': {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    structuredOutputs: true,
    // No tuning: proposePrompt calls it directly with its own settings.
  },
};

/**
 * Per-pipeline-stage defaults. Overridable via Lambda env (CLASSIFY_MODEL /
 * EXTRACT_MODEL). Chosen in docs/decisions/0007-model-refresh-2026-10.md.
 */
export const DEFAULT_MODELS = {
  classify: 'claude-haiku-5-5',
  extract: 'claude-sonnet-5',
  /** Used offline by tools/prompt-improvement, never in the request path. */
  proposePrompt: 'claude-opus-4-8',
} as const;

/**
 * Throws unless `model` is in MODELS and, for a pipeline stage, has tuning for
 * it. Runs at module load for DEFAULT_MODELS, and at Lambda cold start for the
 * CLASSIFY_MODEL / EXTRACT_MODEL overrides, so a typo or an unlisted model
 * fails before any capture is processed rather than being billed at $0 or
 * called with whatever the API defaults to.
 */
export function assertKnownModel(model: string, use: PipelineStage | 'proposePrompt'): void {
  const info = MODELS[model];
  if (!info) {
    throw new Error(
      `Model "${model}" (${use}) is not in MODELS in backend/src/lib/models.ts. ` +
        'Add its prices there before using it.',
    );
  }
  if (use !== 'proposePrompt' && !info.tuning?.[use]) {
    throw new Error(
      `Model "${model}" has no ${use} tuning in MODELS in backend/src/lib/models.ts. ` +
        `Choose its thinking, effort and maxTokens there before using it for ${use}.`,
    );
  }
}

/** The settings `stage` sends to `model`. Throws as assertKnownModel does. */
export function stageTuning(model: string, stage: PipelineStage): StageTuning {
  assertKnownModel(model, stage);
  return MODELS[model]?.tuning?.[stage] as StageTuning;
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
