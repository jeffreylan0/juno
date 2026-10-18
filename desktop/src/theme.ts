/** Keeps a page in the chosen colour theme (lib/themes.ts), and in step with the system's appearance. */
import { getSettings, migrateSettings, settingsItem } from '@/lib/storage';
import { DEFAULT_THEME, applyTheme, themeById } from '@/lib/themes';

/** `bar`: the overlay, whose only themed part is the bar. */
export function followTheme({ bar = false } = {}): void {
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  let id = DEFAULT_THEME;
  const apply = () => applyTheme(document.documentElement, themeById(id), scheme.matches, bar);
  void getSettings().then(
    (s) => {
      id = s.theme;
      apply();
    },
    () => {},
  );
  settingsItem.watch((s) => {
    id = migrateSettings(s).theme;
    apply();
  });
  scheme.addEventListener('change', apply);
}
