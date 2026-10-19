/**
 * Keeps a page in the chosen colour theme (lib/themes.ts), light or dark as
 * the setting says (or as the system is). The page's stylesheets key their
 * dark colours off `data-scheme` on the root, which this sets, so a choice
 * of Light or Dark holds whatever the system shows.
 */
import { useEffect, useState } from 'react';
import { getSettings, migrateSettings, settingsItem, type Scheme } from '@/lib/storage';
import { DEFAULT_THEME, applyTheme, themeById } from '@/lib/themes';

/** Whether the page is dark: as chosen, or as the system is. */
export const isDark = (scheme: Scheme, systemDark: boolean): boolean => scheme === 'dark' || (scheme === 'system' && systemDark);

/** `bar`: the overlay, whose only themed part is the bar. */
export function followTheme({ bar = false } = {}): void {
  const system = matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  let theme = DEFAULT_THEME;
  let scheme: Scheme = 'system';
  const apply = () => {
    const dark = isDark(scheme, system.matches);
    root.dataset.scheme = dark ? 'dark' : 'light';
    root.style.colorScheme = dark ? 'dark' : 'light';
    applyTheme(root, themeById(theme), dark, bar);
  };
  const take = (s: { theme: string; scheme: Scheme }) => {
    theme = s.theme;
    scheme = s.scheme;
    apply();
  };
  // At once, as the system is, so a page never draws in the wrong scheme first; then as set.
  apply();
  void getSettings().then(take, () => {});
  settingsItem.watch((s) => take(migrateSettings(s)));
  system.addEventListener('change', apply);
}

/** Whether this page is dark now (for previews drawn in the page's own scheme). */
export function usePageDark(): boolean {
  const root = document.documentElement;
  const [dark, setDark] = useState(root.dataset.scheme === 'dark');
  useEffect(() => {
    const watch = new MutationObserver(() => setDark(root.dataset.scheme === 'dark'));
    watch.observe(root, { attributes: true, attributeFilter: ['data-scheme'] });
    return () => watch.disconnect();
  }, [root]);
  return dark;
}
