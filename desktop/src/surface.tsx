/**
 * The app's answers to lib/surface.ts (swapped in for it by vite.config.ts):
 * the copy that says "app" where the extension says "tab", the settings that
 * only the app has (its own shortcut, macOS permissions), and the settings it
 * does not have (blocked sites, the PDF reader).
 */
import type { Surface } from '../../extension/lib/surface';
import { BRAND } from './brand';
import { MAC } from './os';
import { AppSection } from './settings/AppSection';
import { Permissions } from './settings/Permissions';
import { ShortcutField } from './settings/ShortcutField';

export const SURFACE: Surface = {
  anywhere: 'any app',
  source: 'window',
  // A private file in the app's folder, as the browser keeps the extension's (store.rs).
  keysKept: 'Your keys stay in a private file on this computer that only your account can read.',
  shortcutField: () => <ShortcutField />,
  sections: [
    ...(MAC ? [{ id: 'permissions', title: 'Permissions', render: () => <Permissions /> }] : []),
    { id: 'app', title: BRAND.name, render: () => <AppSection /> },
  ],
  blockedSites: false,
  pdfViewer: false,
  ownWindow: true,
  // Long enough to read twice; pointing at one holds it (Notices.tsx).
  noticeMs: 9000,
};
