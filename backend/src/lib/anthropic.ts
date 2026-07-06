// The single entry point for every Claude call in the product. Centralizes:
// model selection (lib/models.ts), structured outputs, latency + token
// measurement, cost computation, structured logging, and the AICALL# usage
// record. The eval harness reuses callClaude with recordUsage disabled so
// eval results go through the exact production request path.
import Anthropic from '@anthropic-ai/sdk';
import { MODELS, costUsd } from './models.js';
import { logger } from './logger.js';
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
  maxTokens?: number;
  stage: 'classify' | 'extract';
}

export interface ClaudeCallResult {
  /** Raw Anthropic response (content blocks etc.) — feed to pipeline/extract. */
  response: Anthropic.Message;
  usage: Omit<AiCallRecord, 'userId' | 'captureId'>;
}

export async function callClaude(opts: ClaudeCallOptions): Promise<ClaudeCallResult> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const modelInfo = MODELS[opts.model];
  const schema =
    opts.schema && (modelInfo?.structuredOutputs ?? false)
      ? (opts.schema as Record<string, unknown>)
      : undefined;

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
  return { response, usage };
}
