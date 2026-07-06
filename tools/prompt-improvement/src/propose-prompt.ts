// Ask Claude to propose a minimal prompt revision that addresses the
// clustered failure patterns, writing the next prompt version file. The
// output is a CANDIDATE only — run-gate.ts must pass and a human must merge
// the PR before it takes effect.
//
//   ANTHROPIC_API_KEY=... npm run propose
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { ACTIVE_VERSIONS, loadPrompt } from '../../../backend/src/prompts/prompts.js';
import { DEFAULT_MODELS } from '../../../backend/src/lib/models.js';
import { describePattern, type FailurePattern } from './cluster.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = join(__dirname, '..', 'work');
const PROMPTS_DIR = join(__dirname, '..', '..', '..', 'backend', 'src', 'prompts');

async function main(): Promise<void> {
  const patternsPath = join(WORK_DIR, 'patterns.json');
  if (!existsSync(patternsPath)) {
    throw new Error('work/patterns.json missing — run `npm run aggregate` first');
  }
  const patterns = JSON.parse(readFileSync(patternsPath, 'utf8')) as FailurePattern[];
  if (patterns.length === 0) {
    console.log('No failure patterns — nothing to propose.');
    return;
  }

  const currentVersion = ACTIVE_VERSIONS['extract-event'];
  const currentPrompt = loadPrompt('extract-event');
  const nextVersion = `v${Number(currentVersion.slice(1)) + 1}`;

  const client = new Anthropic(); // ANTHROPIC_API_KEY from env
  const response = await client.messages.create({
    model: DEFAULT_MODELS.proposePrompt,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    messages: [
      {
        role: 'user',
        content: `You maintain the extraction prompt for an app that turns event-poster images into calendar entries. Users corrected the extraction output; the recurring failure patterns (each seen on 3+ independent images) are:

${patterns.map(describePattern).join('\n\n')}

Here is the current prompt (version ${currentVersion}):

<prompt>
${currentPrompt}
</prompt>

Propose a revised prompt that addresses these failure patterns with the SMALLEST change that plausibly fixes them — usually adding or sharpening one rule per pattern. Keep the {{TODAY}} and {{TIMEZONE}} placeholders, the exact JSON output shape, and all existing rules that are unrelated to the failures. Do not add commentary.

Return ONLY the full text of the revised prompt.`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')
    .trim();
  if (!text.includes('{{TODAY}}')) {
    throw new Error('Proposed prompt lost the {{TODAY}} placeholder — refusing to write it');
  }

  const outPath = join(PROMPTS_DIR, `extract-event.${nextVersion}.md`);
  writeFileSync(outPath, text + '\n');
  console.log(`Candidate prompt written to ${outPath}`);
  console.log(`\nNext steps:`);
  console.log(`  1. npm run gate -- --candidate ${nextVersion}`);
  console.log(`  2. If the gate passes, bump ACTIVE_VERSIONS in backend/src/prompts/prompts.ts`);
  console.log(`  3. Open a PR with the new version file + the gate report`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
