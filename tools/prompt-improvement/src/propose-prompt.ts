// Ask Claude to propose a minimal prompt revision that addresses the
// clustered failure patterns, writing the next prompt version file. The
// output is a CANDIDATE only — run-gate.ts must pass and a human must merge
// the PR before it takes effect.
//
//   ANTHROPIC_API_KEY=... npm run propose [-- --force]
//
// This script ALWAYS writes work/proposal.json describing what it did, and that
// file is the only thing allowed to name the candidate version. CI reads it
// rather than guessing from the filesystem: a `ls | tail -1` guess cannot tell a
// new candidate apart from the already-active prompt, and in Aug 2026 that made
// the gate evaluate the live prompt against itself.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { ACTIVE_VERSIONS, loadPrompt } from '../../../backend/src/prompts/prompts.js';
import { DEFAULT_MODELS } from '../../../backend/src/lib/models.js';
import { describePattern, type FailurePattern } from './cluster.js';
import { extractEventVersions, nextCandidateVersion, parseVersion } from './versions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = join(__dirname, '..', 'work');
const PROMPTS_DIR = join(__dirname, '..', '..', '..', 'backend', 'src', 'prompts');
const PROPOSAL_PATH = join(WORK_DIR, 'proposal.json');

/** Written to work/proposal.json on every successful run. */
export interface ProposalResult {
  proposed: boolean;
  /** The new version, e.g. "v4". Null whenever `proposed` is false. */
  candidate: string | null;
  /** The active pin the candidate was derived from. */
  basedOn: string;
  patternCount: number;
  reason?: 'no-patterns' | 'pending-candidate';
}

function writeProposal(result: ProposalResult): void {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(PROPOSAL_PATH, `${JSON.stringify(result, null, 2)}\n`);
}

async function main(): Promise<void> {
  // A success file left by an earlier run must never be mistaken for this run's
  // result — CI lifts `candidate` straight out of it.
  rmSync(PROPOSAL_PATH, { force: true });

  const patternsPath = join(WORK_DIR, 'patterns.json');
  if (!existsSync(patternsPath)) {
    throw new Error('work/patterns.json missing — run `npm run aggregate` first');
  }
  const patterns = JSON.parse(readFileSync(patternsPath, 'utf8')) as FailurePattern[];
  const currentVersion = ACTIVE_VERSIONS['extract-event'];

  if (patterns.length === 0) {
    console.log('No failure patterns — nothing to propose.');
    writeProposal({
      proposed: false,
      candidate: null,
      basedOn: currentVersion,
      patternCount: 0,
      reason: 'no-patterns',
    });
    return;
  }

  // An unmerged candidate above the pin is already awaiting human review.
  // Proposing a second one costs a Claude call and an eval pair to produce
  // version sprawl and a duplicate PR.
  const existing = extractEventVersions(readdirSync(PROMPTS_DIR));
  const activeN = parseVersion(currentVersion) ?? 0;
  const pending = existing.filter((v) => (parseVersion(v) ?? 0) > activeN);
  if (pending.length > 0 && !process.argv.includes('--force')) {
    console.log(
      `Candidate ${pending.join(', ')} already awaiting review (pin is ${currentVersion}) — ` +
        'nothing to propose. Pass --force to propose anyway.',
    );
    writeProposal({
      proposed: false,
      candidate: null,
      basedOn: currentVersion,
      patternCount: patterns.length,
      reason: 'pending-candidate',
    });
    return;
  }

  const currentPrompt = loadPrompt('extract-event');
  const nextVersion = nextCandidateVersion(currentVersion, existing);

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
  // Only claim a candidate once the file it names is actually on disk.
  writeProposal({
    proposed: true,
    candidate: nextVersion,
    basedOn: currentVersion,
    patternCount: patterns.length,
  });
  console.log(`Candidate prompt written to ${outPath}`);
  console.log(`\nNext steps:`);
  console.log(`  1. npm run gate -- --candidate ${nextVersion}`);
  console.log(`  2. If the gate passes, bump ACTIVE_VERSIONS in backend/src/prompts/prompts.ts`);
  console.log(`  3. Open a PR with the new version file + the gate report`);
}

const isMain = process.argv[1] && process.argv[1].endsWith('propose-prompt.ts');
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
