/**
 * The extension's brand (extension/brand.ts), with what differs in the app:
 * there is no toolbar icon, but a menu bar (macOS) or tray (Windows) icon.
 * Swapped in for `@/brand` by the app's build (vite.config.ts).
 */
import { BRAND as EXTENSION } from '../../extension/brand';
import { MAC } from './os';

export { CHROME_KEY, GECKO_ID } from '../../extension/brand';

export const BRAND = {
  ...EXTENSION,
  description: 'Select anything on screen and ask Claude or ChatGPT about exactly that. Math, chemistry and physics render properly.',
  actionTitle: 'Selection AI — select and ask',
  iconName: MAC ? 'the menu bar icon' : 'the tray icon',
} as const;
