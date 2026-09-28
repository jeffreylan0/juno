/**
 * Renders each problem's fixture page in headless Chromium and screenshots the
 * selected element into eval/problems/crops/<id>.png. Used by the image-only
 * route and as the "what a student would box" reference.
 *
 *   pnpm eval:crops
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import { ROOT, loadProblems } from './lib';

// PLAYWRIGHT_CHROMIUM_PATH lets CI or a sandbox point at a preinstalled Chromium.
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1000, height: 800 } });
for (const problem of loadProblems()) {
  if (!problem.crop) continue;
  await page.goto(`file://${join(ROOT, problem.page)}`);
  const el = page.locator(problem.selector).first();
  const out = join(ROOT, problem.crop);
  mkdirSync(dirname(out), { recursive: true });
  await el.screenshot({ path: out });
  console.log(`${problem.id} → ${problem.crop}`);
}
await browser.close();
