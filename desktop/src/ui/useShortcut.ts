import { useEffect, useState } from 'react';

/**
 * The key that starts a selection, as the app registered it ("⌥⇧S" on a Mac,
 * "Alt+Shift+S" elsewhere): read live, because students can change it and a
 * clash with another app leaves it unassigned. Empty when unassigned.
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

const MAC_KEYS: Record<string, string> = { '⌘': 'Command', '⌥': 'Option', '⇧': 'Shift', '⌃': 'Control' };

/**
 * A shortcut the way people say it: "Alt + Shift + S", or on a Mac (where it
 * is written "⌥⇧S") "Option + Shift + S", after the keys' own labels.
 */
export function formatShortcut(shortcut: string): string {
  if (!shortcut) return '';
  if (shortcut.includes('+')) return shortcut.split('+').map((k) => k.trim()).filter(Boolean).join(' + ');
  const keys: string[] = [];
  let rest = '';
  for (const ch of shortcut) {
    if (MAC_KEYS[ch]) keys.push(MAC_KEYS[ch]);
    else rest += ch;
  }
  if (rest) keys.push(rest);
  return keys.join(' + ');
}
