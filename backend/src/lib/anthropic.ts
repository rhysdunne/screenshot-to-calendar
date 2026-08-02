// The single entry point for every Claude call in the product. Centralizes:
// model selection (lib/models.ts), structured outputs, latency + token
// measurement, cost computation, structured logging, and the AICALL# usage
// record. The eval harness reuses callClaude with recordUsage disabled so
// eval results go through the exact production request path.
import Anthropic from '@anthropic-ai/sdk';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { MODELS, costUsd } from './models.js';
import { logger } from './logger.js';

// EMF metric backing the s2c-ai-spend alarm (infra/lib/backend-stack.ts).
// Only emitted when STAGE is set — i.e. in Lambda, not in the eval harness.
const metrics = new Metrics({ namespace: 's2c', serviceName: 's2c' });

function emitCostMetric(cost: number): void {
  const stage = process.env.STAGE;
  if (!stage) return;
  const single = metrics.singleMetric();
  single.addDimension('stage', stage);
  single.addMetric('AiCostUsd', MetricUnit.NoUnit, cost);
}
import type { AiCallRecord } from './ddb.js';
import type { ImageMediaType } from '../pipeline/image.js';

export interface ClaudeCallOptions {
  apiKey: string;
  model: string;
  prompt: string;
  imageBase64: string;
  mediaType: ImageMediaType;
  /** JSON Schema for structured outputs; applied only if the model supports it. */
  schema?: object;
  /**
   * Opt in to running without structured outputs when the model can't do them.
   * The eval harness sets this — it deliberately compares candidate models that
   * lack structured-output support and relies on the fence-stripping fallback
   * in `pipeline/extract.ts`. Production callers leave it unset so that an
   * unknown `EXTRACT_MODEL` fails loudly instead of quietly dropping the only
   * shape guard on the response.
   */
  allowUnstructured?: boolean;
  maxTokens?: number;
  stage: 'classify' | 'extract';
}

/** A schema was requested but the configured model cannot enforce one. */
export class StructuredOutputUnavailableError extends Error {
  constructor(model: string) {
    super(
      `Model "${model}" cannot enforce structured outputs (unknown to lib/models.ts, ` +
        `or structuredOutputs: false). Pass allowUnstructured to proceed without them.`,
    );
    this.name = 'StructuredOutputUnavailableError';
  }
}

/**
 * Decide whether structured outputs apply to this call. Pure, so the guard is
 * testable without a network call.
 *
 * Previously a schema was silently dropped whenever the model didn't support
 * structured outputs — including when the model ID was simply unknown to
 * `lib/models.ts`, which an `EXTRACT_MODEL` typo would trigger. That removed
 * the only shape guard on the model's response with no signal at all, so it
 * now fails loudly unless the caller explicitly opts out.
 */
export function resolveStructuredOutput(
  model: string,
  schema: object | undefined,
  allowUnstructured: boolean | undefined,
): Record<string, unknown> | undefined {
  const supported = MODELS[model]?.structuredOutputs ?? false;
  if (schema && !supported && !allowUnstructured) {
    throw new StructuredOutputUnavailableError(model);
  }
  return schema && supported ? (schema as Record<string, unknown>) : undefined;
}

export interface ClaudeCallResult {
  /** Raw Anthropic response (content blocks etc.) — feed to pipeline/extract. */
  response: Anthropic.Message;
  usage: Omit<AiCallRecord, 'userId' | 'captureId'>;
}

export async function callClaude(opts: ClaudeCallOptions): Promise<ClaudeCallResult> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const schema = resolveStructuredOutput(opts.model, opts.schema, opts.allowUnstructured);

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: opts.mediaType, data: opts.imageBase64 },
          },
          { type: 'text', text: opts.prompt },
        ],
      },
    ],
    ...(schema ? { output_config: { format: { type: 'json_schema' as const, schema } } } : {}),
  };

  const startedAt = Date.now();
  const response = await client.messages.create(params);
  const latencyMs = Date.now() - startedAt;

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const usage = {
    stage: opts.stage,
    model: opts.model,
    inputTokens,
    outputTokens,
    costUsd: costUsd(opts.model, inputTokens, outputTokens),
    latencyMs,
  };

  logger.info('claude_call', { ...usage, stopReason: response.stop_reason });
  emitCostMetric(usage.costUsd);
  return { response, usage };
}
