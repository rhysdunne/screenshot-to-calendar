// Synthetic dataset generator: renders the HTML templates with Playwright
// (Chromium) and writes image + gold label + metadata per case.
//
//   npm run generate -- --count 40 --seed 42
//
// Regenerating with the same seed/count produces byte-identical gold labels
// (images may differ across Chromium versions — labels are what matter).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { FROZEN_TODAY, makeEventCase, makeNonEventCase, rng, type EventCase } from './data.js';
import { TEMPLATES } from './templates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASET_DIR = join(__dirname, '..', 'dataset', 'synthetic');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

async function main(): Promise<void> {
  const count = Number(arg('count', '40'));
  const seed = Number(arg('seed', '42'));
  const random = rng(seed);

  const cases: EventCase[] = [];
  for (let i = 0; i < count; i++) cases.push(makeEventCase(random, i));
  // ~10% non-event cases so the classifier gets exercised too.
  for (let i = count; i < count + Math.max(2, Math.round(count * 0.1)); i++) {
    cases.push(makeNonEventCase(i));
  }

  rmSync(DATASET_DIR, { recursive: true, force: true });
  // If a pinned Chromium doesn't match the installed playwright-core version,
  // fall back to an explicitly provided binary (e.g. /opt/pw-browsers/chromium).
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_PATH ??
    (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    if (!executablePath) throw e;
    browser = await chromium.launch({ executablePath });
  }
  const context = await browser.newContext({ deviceScaleFactor: 1 });

  for (const c of cases) {
    const template = TEMPLATES[c.template];
    if (!template) throw new Error(`No template: ${c.template}`);
    const html = template(c);
    const dir = join(DATASET_DIR, c.id);
    mkdirSync(dir, { recursive: true });

    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const body = page.locator('body');
    await body.screenshot({ path: join(dir, 'image.png') });
    await page.close();

    writeFileSync(join(dir, 'gold.json'), JSON.stringify(c.gold, null, 2));
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify(
        {
          source: 'synthetic',
          template: c.template,
          frozenToday: FROZEN_TODAY,
          classification: c.goldClassification,
          seed,
          consent: true,
        },
        null,
        2,
      ),
    );
    console.log(`✓ ${c.id}`);
  }

  await browser.close();
  console.log(`\nGenerated ${cases.length} cases in ${DATASET_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
