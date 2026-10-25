/**
 * Imported first by every window of the app: puts the WebExtension-shaped
 * `browser` (browser.ts) in place before anything else runs, then swaps in
 * the app's ways of keeping screenshots, reaching the network and opening
 * links.
 */
import { setImageStore } from '@/lib/images';
import { createBrowser } from './browser';
import { FileImageStore } from './images';
import { installLinks, openExternal } from './links';
import { installFetch } from './net';
import { tauriTransport } from './transport';

export const transport = tauriTransport();

/** A step of this window's, or an error, for the app's log (juno.log: src-tauri/src/diag.rs). */
export const note = (text: string): void => void transport.invoke('diag_note', { text }).catch(() => {});
addEventListener('error', (e) => note(`error: ${e.message} (${e.filename.split('/').pop()}:${e.lineno})`));
addEventListener('unhandledrejection', (e) => note(`unhandled: ${(e.reason as Error)?.message ?? String(e.reason)}`));
export const browser = createBrowser(transport, { openUrl: openExternal });

(globalThis as unknown as { browser: typeof browser }).browser = browser;
setImageStore(new FileImageStore(transport));
installFetch();
installLinks();
// window.close() hides settings (the panel's own ✕ goes through the core:
// panel/main.tsx); the other windows never close themselves.
window.close = () => void transport.invoke('window_close').catch(() => {});
