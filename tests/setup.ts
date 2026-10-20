/**
 * Every test starts with a fresh `browser`, as the app's pages start with
 * theirs: the app's own (desktop/src/platform/browser.ts), over a native
 * core kept in memory.
 */
import { beforeEach } from 'vitest';
import { createBrowser } from '../desktop/src/platform/browser';
import { fakeCore } from './support/fake-core';

beforeEach(async () => {
  const browser = createBrowser(fakeCore().transport('core'), { origin: 'tauri://localhost' });
  Object.assign(globalThis, { browser });
  await browser.ready;
});
