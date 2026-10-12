import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));

const { callClaude } = await import('../../src/lib/anthropic.js');

const base = {
  apiKey: 'test-key',
  prompt: 'Read the event.',
  imageBase64: 'aGVsbG8=',
  mediaType: 'image/png' as const,
};

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({
    content: [{ type: 'text', text: '{}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 100 },
  });
});

describe('callClaude', () => {
  it("sends the stage's thinking, effort and max tokens from MODELS", async () => {
    await callClaude({ ...base, model: 'claude-sonnet-5-5', stage: 'extract', schema: {} });
    const params = create.mock.calls[0]?.[0];
    expect(params.thinking).toEqual({ type: 'between_tools' });
    expect(params.max_tokens).toBe(1024);
    expect(params.output_config.effort).toBe('low');
    expect(params.output_config.format.type).toBe('json_schema');
  });

  it('sends no effort to a model that rejects it, and thinking off explicitly', async () => {
    await callClaude({ ...base, model: 'claude-haiku-4-5', stage: 'classify' });
    const params = create.mock.calls[0]?.[0];
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(params.max_tokens).toBe(256);
    expect(params).not.toHaveProperty('output_config');
  });

  it('uses the tuning the caller passes instead of the table', async () => {
    await callClaude({
      ...base,
      model: 'claude-sonnet-5',
      stage: 'extract',
      tuning: { thinking: 'disabled', effort: 'medium', maxTokens: 2048 },
    });
    const params = create.mock.calls[0]?.[0];
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(params.output_config).toEqual({ effort: 'medium' });
    expect(params.max_tokens).toBe(2048);
  });

  it('refuses an unpriced model before sending anything', async () => {
    await expect(
      callClaude({ ...base, model: 'claude-nonexistent', stage: 'extract' }),
    ).rejects.toThrow(/not in MODELS/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a model with no tuning for the stage before sending anything', async () => {
    await expect(
      callClaude({ ...base, model: 'claude-opus-4-8', stage: 'classify' }),
    ).rejects.toThrow(/no classify tuning/);
    expect(create).not.toHaveBeenCalled();
  });

  it('prices the call from the token counts', async () => {
    const { usage } = await callClaude({ ...base, model: 'claude-sonnet-5', stage: 'extract' });
    // 1000 in at $2/MTok + 100 out at $10/MTok
    expect(usage.costUsd).toBeCloseTo(0.003);
  });
});
