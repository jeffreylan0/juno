/**
 * Stands in for WXT's `#imports` virtual module in the app's build. The
 * extension's modules import only `storage` from it; WXT's storage helper
 * works as is on top of the app's `browser` (browser.ts).
 */
export { storage } from '@wxt-dev/storage';
export const browser = (globalThis as unknown as { browser: unknown }).browser;
