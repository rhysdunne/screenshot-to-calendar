// The consent rule for the real eval set (CLAUDE.md, #88): every committed real
// case records consent, and the loader refuses one that does not.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDataset } from '../src/harness.js';

const REAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dataset', 'real');

describe('real eval dataset consent', () => {
  it('every committed real case has consent: true in its meta.json', () => {
    const caseIds = readdirSync(REAL_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(caseIds.length).toBeGreaterThan(0);
    for (const id of caseIds) {
      const meta = JSON.parse(readFileSync(join(REAL_DIR, id, 'meta.json'), 'utf8')) as {
        consent?: unknown;
      };
      expect({ id, consent: meta.consent }).toEqual({ id, consent: true });
    }
  });

  describe('loadDataset', () => {
    let root: string | undefined;
    afterEach(() => {
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    });

    function writeCase(kind: 'real' | 'synthetic', id: string, meta: object): void {
      const dir = join(root as string, kind, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(join(dir, 'gold.json'), '{}');
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    }

    it('throws, naming the case, when a real case lacks consent', () => {
      root = mkdtempSync(join(tmpdir(), 's2c-consent-'));
      writeCase('real', 'real-001-ok', { frozenToday: '2026-07-06', consent: true });
      writeCase('real', 'real-002-missing', { frozenToday: '2026-07-06' });
      expect(() => loadDataset('all', undefined, root)).toThrow(/real\/real-002-missing/);
    });

    it('loads real cases that record consent', () => {
      root = mkdtempSync(join(tmpdir(), 's2c-consent-'));
      writeCase('real', 'real-001-ok', { frozenToday: '2026-07-06', consent: true });
      writeCase('synthetic', 'syn-001', { frozenToday: '2026-07-06' });
      expect(loadDataset('all', undefined, root).map((c) => c.id)).toEqual([
        'syn-001',
        'real-001-ok',
      ]);
    });
  });
});
