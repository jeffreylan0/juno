import { useEffect, useState } from 'react';

/**
 * The key that starts a selection, as the browser reports it ("⌥⇧S" on a Mac,
 * "Alt+Shift+S" elsewhere) — read live, because students can rebind it and a
 * clash with another extension leaves it unassigned. Empty when unassigned.
 */
export function useShortcut(name = '_execute_action'): string {
  const [shortcut, setShortcut] = useState('');
  useEffect(() => {
    let live = true;
    void browser.commands
      ?.getAll()
      .then((all) => {
        if (live) setShortcut(all.find((c) => c.name === name)?.shortcut ?? '');
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [name]);
  return shortcut;
}

/** Opens the browser's own page for changing extension shortcuts. */
export function openShortcutSettings(): void {
  const firefox = (browser as unknown as { commands?: { openShortcutSettings?: () => Promise<void> } }).commands;
  if (import.meta.env.FIREFOX && firefox?.openShortcutSettings) {
    void firefox.openShortcutSettings();
    return;
  }
  const url = import.meta.env.EDGE ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
  void browser.tabs.create({ url });
}
