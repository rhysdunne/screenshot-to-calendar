import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, MODELS, costUsd } from '../../src/lib/models.js';
import { ACTIVE_VERSIONS, loadPrompt, renderPrompt } from '../../src/prompts/prompts.js';
import { CLASSIFY_IMAGE_SCHEMA, EXTRACT_EVENT_SCHEMA } from '../../src/prompts/schemas.js';

describe('models', () => {
  it('default models exist in the price table', () => {
    expect(MODELS[DEFAULT_MODELS.classify]).toBeDefined();
    expect(MODELS[DEFAULT_MODELS.extract]).toBeDefined();
  });

  it('computes cost from token counts', () => {
    // haiku: $1/MTok in, $5/MTok out
    expect(costUsd('claude-haiku-4-5', 1_000_000, 1_000_000)).toBeCloseTo(6.0);
    expect(costUsd('claude-haiku-4-5', 2000, 300)).toBeCloseTo(0.0035);
  });

  it('unknown model costs zero rather than throwing', () => {
    expect(costUsd('claude-nonexistent', 1000, 1000)).toBe(0);
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

  it('schemas require every extraction field and forbid extras', () => {
    expect(EXTRACT_EVENT_SCHEMA.required).toHaveLength(10);
    expect(EXTRACT_EVENT_SCHEMA.additionalProperties).toBe(false);
    expect(CLASSIFY_IMAGE_SCHEMA.additionalProperties).toBe(false);
  });
});
