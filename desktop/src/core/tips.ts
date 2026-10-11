/**
 * Small pieces of the core that are worth testing on their own.
 */

/** The notes the core asks the bar to carry under its row (overlay/notices.ts has their words). */
export type OverlayNotice = 'screen-permission' | 'screen-restart' | 'shortcut-taken';

/** A selection's "page" title in the app: the window it was made over (lib/screen-text.ts). */
export { windowTitle as pageTitle } from '@/lib/screen-text';
