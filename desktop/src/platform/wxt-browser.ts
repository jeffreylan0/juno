/** Stands in for `wxt/browser` in the app's build: the app's `browser` (browser.ts). */
export const browser = (globalThis as unknown as { browser: unknown }).browser;
