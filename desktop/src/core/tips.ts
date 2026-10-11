/**
 * Small pieces of the core that are worth testing on their own.
 */

/** The notes the core asks the bar to carry under its row (overlay/notices.ts has their words). */
export type OverlayNotice = 'screen-permission' | 'screen-restart' | 'shortcut-taken';

/**
 * A selection's "page" title in the app: the window it was made over, and
 * the app, unless the window's title already names it ("Chapter 3.pdf ·
 * Preview", "Lab report - Word").
 */
export function pageTitle(source: { app: string; title: string }): string {
  const app = source.app.trim();
  const title = source.title.replace(/\s+/g, ' ').trim();
  if (!title) return app;
  if (!app || title.toLowerCase().includes(app.toLowerCase())) return title;
  return `${title} · ${app}`;
}
