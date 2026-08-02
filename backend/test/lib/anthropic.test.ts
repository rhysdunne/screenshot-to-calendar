// The structured-output guard in lib/anthropic.ts. Exercised through the pure
// `resolveStructuredOutput` so the suite stays offline and credential-free.
import { describe, expect, it } from 'vitest';
import {
  resolveStructuredOutput,
  StructuredOutputUnavailableError,
} from '../../src/lib/anthropic.js';
import { EXTRACT_EVENT_SCHEMA_V3 } from '../../src/prompts/schemas.js';

const schema = EXTRACT_EVENT_SCHEMA_V3;

describe('resolveStructuredOutput', () => {
  it('applies the schema on a model that supports structured outputs', () => {
    expect(resolveStructuredOutput('claude-sonnet-5', schema, undefined)).toBe(schema);
  });

  it('throws when the model is registered as unable to enforce a schema', () => {
    // claude-sonnet-4-6 carries structuredOutputs: false in lib/models.ts.
    expect(() => resolveStructuredOutput('claude-sonnet-4-6', schema, undefined)).toThrow(
      StructuredOutputUnavailableError,
    );
  });

  it('throws for a model unknown to the registry, naming it', () => {
    // The failure this prevents: an EXTRACT_MODEL typo in production silently
    // removing the only shape guard on the model's response.
    expect(() => resolveStructuredOutput('claude-sonnet-9-typo', schema, undefined)).toThrow(
      /claude-sonnet-9-typo/,
    );
  });

  it('drops the schema without throwing when the caller opts in', () => {
    // The eval harness compares candidate models that lack structured-output
    // support and relies on the fence-stripping fallback in pipeline/extract.
    expect(resolveStructuredOutput('claude-sonnet-4-6', schema, true)).toBeUndefined();
  });

  it('is a no-op when no schema was requested', () => {
    expect(resolveStructuredOutput('claude-sonnet-9-typo', undefined, undefined)).toBeUndefined();
  });
});
