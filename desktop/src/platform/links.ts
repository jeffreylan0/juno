/**
 * Links in answers and settings ("Get a key", sources the model cites) open
 * in the student's browser, never inside the app's window: only a link to a
 * part of the same page (settings' sections) is followed in place. (The
 * native core refuses any other page in its windows too: wm.rs own_page.)
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { isExternal } from './net';

/**
 * Juno opened another app's window (a page in the browser, System
 * Settings), which this card may sit over: card.ts reminds the student that
 * Escape puts Juno away.
 */
export const OPENED_ELSEWHERE = 'juno:opened-elsewhere';

/** Opens a page in the student's browser. */
export function openExternal(url: string): void {
  void openUrl(url);
  dispatchEvent(new Event(OPENED_ELSEWHERE));
}

export function installLinks(): void {
  document.addEventListener(
    'click',
    (e) => {
      // Any element with an href, SVG and MathML links included (their `href` isn't a string).
      const a = (e.target as Element | null)?.closest?.('[href]');
      const href = a?.getAttribute('href');
      if (!a || href == null || href.startsWith('#')) return;
      e.preventDefault();
      const url = new URL(href, location.href).href;
      if (isExternal(url)) openExternal(url);
    },
    true,
  );
  window.open = ((url?: string | URL) => {
    if (url && isExternal(String(url))) openExternal(String(url));
    return null;
  }) as typeof window.open;
}
