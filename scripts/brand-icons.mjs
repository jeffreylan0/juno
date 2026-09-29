/**
 * Renders extension/assets/brand/icon.svg to every icon size the manifests use,
 * with a real browser (the Playwright Chromium the test suite already has), so
 * the PNGs match what the SVG looks like — no image library to install.
 *
 *   pnpm brand:icons
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(resolve(root, 'extension/assets/brand/icon.svg'), 'utf8');
const sizes = [16, 32, 48, 96, 128];
const outDir = resolve(root, 'extension/public/icon');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace(
        '<svg ',
        `<svg width="${size}" height="${size}" `,
      )}</div></body></html>`,
    );
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    writeFileSync(resolve(outDir, `${size}.png`), png);
    console.log(`icon/${size}.png`);
  }
} finally {
  await browser.close();
}
