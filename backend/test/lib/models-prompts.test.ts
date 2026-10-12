import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/lib/logger.js';
import {
  DEFAULT_MODELS,
  MODELS,
  assertKnownModel,
  costUsd,
  stageTuning,
} from '../../src/lib/models.js';
import {
  ACTIVE_VERSIONS,
  extractSchemaFor,
  loadPrompt,
  renderPrompt,
} from '../../src/prompts/prompts.js';
import {
  CLASSIFY_IMAGE_SCHEMA,
  EXTRACT_EVENT_SCHEMA,
  EXTRACT_EVENT_SCHEMA_V3,
} from '../../src/prompts/schemas.js';

describe('models', () => {
  it('default models exist in the price table with tuning for their stage', () => {
    expect(MODELS[DEFAULT_MODELS.classify]?.tuning?.classify).toBeDefined();
    expect(MODELS[DEFAULT_MODELS.extract]?.tuning?.extract).toBeDefined();
    expect(MODELS[DEFAULT_MODELS.proposePrompt]).toBeDefined();
  });

  it('every thinking setting is one its model accepts', () => {
    for (const [model, info] of Object.entries(MODELS)) {
      for (const tuning of Object.values(info.tuning ?? {})) {
        // Only Sonnet 5.5 takes between_tools, and it rejects disabled.
        if (model === 'claude-sonnet-5-5') expect(tuning.thinking).not.toBe('disabled');
        else expect(tuning.thinking).not.toBe('between_tools');
        // Thinking-off settings are rejected above high effort.
        if (tuning.thinking !== 'adaptive') {
          expect(['xhigh', 'max']).not.toContain(tuning.effort);
        }
      }
    }
  });

  it('stageTuning returns the table entry and throws for a model without one', () => {
    expect(stageTuning('claude-sonnet-5', 'extract')).toBe(
      MODELS['claude-sonnet-5']?.tuning?.extract,
    );
    expect(() => stageTuning('claude-opus-4-8', 'extract')).toThrow(
      /"claude-opus-4-8" has no extract tuning/,
    );
  });

  it('computes cost from token counts', () => {
    // haiku: $1/MTok in, $5/MTok out
    expect(costUsd('claude-haiku-4-5', 1_000_000, 1_000_000)).toBeCloseTo(6.0);
    expect(costUsd('claude-haiku-4-5', 2000, 300)).toBeCloseTo(0.0035);
    // sonnet 5: $2/MTok in, $10/MTok out
    expect(costUsd('claude-sonnet-5', 1_000_000, 1_000_000)).toBeCloseTo(12.0);
  });

  it('logs an error for a model with no price instead of passing silently', () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      expect(costUsd('claude-nonexistent', 1000, 1000)).toBe(0);
      expect(error).toHaveBeenCalledWith('model_price_missing', { model: 'claude-nonexistent' });
    } finally {
      error.mockRestore();
    }
  });

  it('assertKnownModel throws, naming the model and its use, when it is not in MODELS', () => {
    expect(() => assertKnownModel('claude-nonexistent', 'extract')).toThrow(
      /"claude-nonexistent" \(extract\) is not in MODELS/,
    );
    expect(() => assertKnownModel(DEFAULT_MODELS.extract, 'extract')).not.toThrow();
  });
});

describe('prompts', () => {
  it('loads every pinned prompt version', () => {
    for (const name of Object.keys(ACTIVE_VERSIONS) as (keyof typeof ACTIVE_VERSIONS)[]) {
      expect(loadPrompt(name).length).toBeGreaterThan(100);
    }
  });

  it('extract prompt carries the placeholders and renders them', () => {
    const template = loadPrompt('extract-event');
    expect(template).toContain('{{TODAY}}');
    expect(template).toContain('{{TIMEZONE}}');
    const rendered = renderPrompt(template, {
      today: '2026-07-06',
      timeZone: 'Europe/London',
    });
    expect(rendered).toContain('2026-07-06');
    expect(rendered).not.toContain('{{TODAY}}');
  });

  it('picks the extraction schema by prompt version, numerically past v9', () => {
    expect(extractSchemaFor('v2')).toBe(EXTRACT_EVENT_SCHEMA);
    expect(extractSchemaFor('v3')).toBe(EXTRACT_EVENT_SCHEMA_V3);
    // 'v10' >= 'v3' is false as strings: the regression in #90.
    expect(extractSchemaFor('v10')).toBe(EXTRACT_EVENT_SCHEMA_V3);
  });

  it('schemas require every extraction field and forbid extras', () => {
    expect(EXTRACT_EVENT_SCHEMA.required).toHaveLength(10);
    expect(EXTRACT_EVENT_SCHEMA.additionalProperties).toBe(false);
    expect(CLASSIFY_IMAGE_SCHEMA.additionalProperties).toBe(false);
  });
});
