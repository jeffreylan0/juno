/**
 * The extension's brand (extension/brand.ts), with what differs in the app:
 * there is no toolbar icon, but a menu bar (macOS) or tray (Windows) icon.
 * Swapped in for `@/brand` by the app's build (vite.config.ts).
 */
import { BRAND as EXTENSION } from '../../extension/brand';
import { MAC } from './os';

export const BRAND = {
  ...EXTENSION,
  iconName: MAC ? 'the menu bar icon' : 'the tray icon',
} as const;
