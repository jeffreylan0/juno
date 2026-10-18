/**
 * Links in answers and settings ("Get a key", sources the model cites) open
 * in the student's browser, never inside the app's window: only a link to a
 * part of the same page (settings' sections) is followed in place. (The
 * native core refuses any other page in its windows too: wm.rs own_page.)
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { isExternal } from './net';

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
      if (isExternal(url)) void openUrl(url);
    },
    true,
  );
  window.open = ((url?: string | URL) => {
    if (url && isExternal(String(url))) void openUrl(String(url));
    return null;
  }) as typeof window.open;
}
