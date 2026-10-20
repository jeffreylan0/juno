/**
 * The app's icons, from its mark (desktop/assets/icon.svg):
 *
 *   src-tauri/icons/app.png   1024 px, which `tauri icon` turns into every
 *                             size and format the bundles need
 *   src-tauri/icons/tray.png  the menu bar icon: the mark's frame and handles
 *                             in black on transparent, which macOS tints
 *                             (a "template" image), 22 pt at 2×
 *
 *   pnpm --filter desktop icons
 *
 * Rendered with Playwright's Chromium, so the PNGs match the SVG exactly.
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'desktop/src-tauri/icons');
const mark = readFileSync(resolve(root, 'desktop/assets/icon.svg'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

// The mark without its blue tile: the frame and the four handles, cut out.
const tray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <mask id="holes">
    <rect width="128" height="128" fill="#fff"/>
    <g fill="#000">
      <rect x="21" y="21" width="14" height="14" rx="2"/><rect x="93" y="21" width="14" height="14" rx="2"/>
      <rect x="21" y="93" width="14" height="14" rx="2"/><rect x="93" y="93" width="14" height="14" rx="2"/>
    </g>
  </mask>
  <g mask="url(#holes)">
    <rect x="30" y="30" width="68" height="68" fill="none" stroke="#000" stroke-width="10"/>
    <rect x="12" y="12" width="32" height="32" rx="6"/><rect x="84" y="12" width="32" height="32" rx="6"/>
    <rect x="12" y="84" width="32" height="32" rx="6"/><rect x="84" y="84" width="32" height="32" rx="6"/>
  </g>
</svg>`;

async function render(page, svg, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  writeFileSync(resolve(out, file), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  console.log(`icons/${file}`);
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await render(page, mark, 1024, 'app.png');
  await render(page, tray, 44, 'tray.png');
} finally {
  await browser.close();
}
