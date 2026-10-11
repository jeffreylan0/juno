/**
 * The app's answers to lib/surface.ts (swapped in for it by vite.config.ts):
 * the copy that says "app" where the extension says "tab", the settings that
 * only the app has (its own shortcut, macOS permissions), and the settings it
 * does not have (blocked sites, the PDF reader).
 */
import type { Surface } from '../../extension/lib/surface';
import { MAC, WINDOWS } from './os';
import { Permissions } from './settings/Permissions';
import { ShortcutField } from './settings/ShortcutField';

export type { Surface };

export const SURFACE: Surface = {
  kind: 'desktop',
  anywhere: 'any app',
  source: 'window',
  keysKept: MAC
    ? "Your keys stay in this Mac's keychain."
    : WINDOWS
      ? "Your keys stay in Windows' Credential Manager."
      : 'Your keys stay in a private file on this computer.',
  shortcutField: () => <ShortcutField />,
  sections: MAC ? [{ id: 'permissions', title: 'Permissions', render: () => <Permissions /> }] : [],
  blockedSites: false,
  pdfViewer: false,
  ownWindow: true,
  // Every mode works everywhere; Text and Element on what the app reads off
  // the screen (lib/screen-text.ts).
  unavailable: (label) => `${label} doesn't work here`,
  modeHints: {
    text: 'Drag across the text',
    element: 'Click a paragraph · ↑ ↓ to resize',
  },
};
