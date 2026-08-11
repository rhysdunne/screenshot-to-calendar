// Prompt version helpers. Versions are `v<N>` strings and every comparison
// here is NUMERIC. String comparison sorts 'v10' below 'v3', which is the class
// of bug that let CI pick the wrong candidate file (`ls | sort -V | tail -1`).

const VERSION_RE = /^v(\d+)$/;
const PROMPT_FILE_RE = /^extract-event\.(v\d+)\.md$/;

/** Numeric version, or null if the string isn't a `v<N>` version. */
export function parseVersion(v: string): number | null {
  const m = VERSION_RE.exec(v);
  return m ? Number(m[1]) : null;
}

/**
 * The next candidate version: one above the highest of the active pin and every
 * version already on disk. Never returns an existing version — writing over one
 * would edit a prompt version in place, and eval baselines reference versions by
 * name.
 */
export function nextCandidateVersion(active: string, existingVersions: string[]): string {
  const activeN = parseVersion(active);
  if (activeN === null) {
    throw new Error(`Active prompt version is not a v<N> version: ${active}`);
  }
  const highest = existingVersions.reduce((max, v) => {
    const n = parseVersion(v);
    return n !== null && n > max ? n : max;
  }, activeN);
  return `v${highest + 1}`;
}

/** The `v<N>` versions among a list of filenames from the prompts directory. */
export function extractEventVersions(files: string[]): string[] {
  return files
    .map((f) => PROMPT_FILE_RE.exec(f)?.[1])
    .filter((v): v is string => v !== undefined);
}
