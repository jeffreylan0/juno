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
  // Text and Element read the screen through the system's accessibility API,
  // which comes in the next step of the app (the plan's "Parity on Mac").
  unavailable: (label) => `${label} is coming to the app soon. Box and Freeform work everywhere.`,
};
