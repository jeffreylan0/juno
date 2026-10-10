/**
 * Links in answers and settings ("Get a key", sources the model cites) open
 * in the student's browser, not inside the app's window.
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { isExternal } from './net';

export function installLinks(): void {
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || !isExternal(a.href)) return;
      e.preventDefault();
      void openUrl(a.href);
    },
    true,
  );
  window.open = ((url?: string | URL) => {
    if (url && isExternal(String(url))) void openUrl(String(url));
    return null;
  }) as typeof window.open;
}
