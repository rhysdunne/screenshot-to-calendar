// Prompt registry. Prompts are versioned files; the ACTIVE_VERSIONS map below
// is the single pin the prompt-improvement pipeline bumps (via PR, never
// automatically). Never edit an existing prompt version file in place — eval
// baselines reference versions by name.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRACT_EVENT_SCHEMA, EXTRACT_EVENT_SCHEMA_V3 } from './schemas.js';

export const ACTIVE_VERSIONS = {
  'extract-event': 'v2',
  'classify-image': 'v1',
} as const;

/** Structured-output schema matching an extract-event prompt version. */
export function extractSchemaFor(version?: string): object {
  const v = version ?? ACTIVE_VERSIONS['extract-event'];
  return v >= 'v3' ? EXTRACT_EVENT_SCHEMA_V3 : EXTRACT_EVENT_SCHEMA;
}

export type PromptName = keyof typeof ACTIVE_VERSIONS;

const promptDir = dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

/** Load a prompt by name at its pinned version (or an explicit version for evals). */
export function loadPrompt(name: PromptName, version?: string): string {
  const v = version ?? ACTIVE_VERSIONS[name];
  const key = `${name}.${v}`;
  let text = cache.get(key);
  if (!text) {
    text = readFileSync(join(promptDir, `${key}.md`), 'utf8');
    cache.set(key, text);
  }
  return text;
}

/** Substitute {{TODAY}} / {{TIMEZONE}} placeholders. */
export function renderPrompt(
  template: string,
  vars: { today?: string; timeZone?: string },
): string {
  let out = template;
  if (vars.today) out = out.replaceAll('{{TODAY}}', vars.today);
  if (vars.timeZone) out = out.replaceAll('{{TIMEZONE}}', vars.timeZone);
  return out;
}
