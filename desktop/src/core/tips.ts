/**
 * Small pieces of the core that are worth testing on their own.
 */

/** The notes the core asks the bar to carry under its row (overlay/notices.ts has their words). */
export type OverlayNotice = 'screen-permission' | 'screen-restart' | 'shortcut-taken';

/** What apps put between the parts of a window title: "Notes - Word", "Quiz | Site — Mozilla Firefox". */
const SEPARATOR = /(\s+[-–—|·]\s+)/;
/** A part that only counts where you are in something: "Task 10 of 13", "Question 3/20", "4 of 12". */
const COUNTER = /^(?:[a-z]+\.?\s*)?\d+\s*(?:of|\/)\s*\d+$/i;
/** An unread count: "(3) YouTube", "Inbox (4)". */
const UNREAD = /^\(\d+\+?\)\s*|\s*\(\d+\+?\)$/g;

/**
 * A selection's "page" title in the app, which names its chat: the name of
 * what the window shows, without the app's own name ("Lab report - Word",
 * "Quiz 2.1 | Stemble — Mozilla Firefox") or the counters that change from one
 * step of the same thing to the next ("Task 10 of 13", "(4)"). The app's name
 * when the window has no title.
 */
export function pageTitle(source: { app: string; title: string }): string {
  const app = source.app.trim();
  const clean = source.title.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  // Alternating parts and separators: [part, separator, part, …]. Each part
  // kept keeps the separator before it.
  const pieces = clean.split(SEPARATOR);
  const kept: { separator: string; part: string }[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const part = pieces[i]!.replace(UNREAD, '').replace(/ and \d+ more pages?$/i, '').trim();
    if (part && !COUNTER.test(part)) kept.push({ separator: pieces[i - 1] ?? '', part });
  }
  if (kept.length > 1 && namesApp(kept.at(-1)!.part, app)) kept.pop();
  if (!kept.length) return app;
  return kept.map((k, i) => (i ? k.separator : '') + k.part).join('');
}

/** Whether a window title's last part is the app's own name ("Mozilla Firefox" for firefox, "Word" for WINWORD). */
function namesApp(part: string, app: string): boolean {
  const a = app.toLowerCase().replace(/\.exe$/, '');
  const p = part.toLowerCase();
  if (!a) return false;
  // "Microsoft Edge" is msedge; but "Google Docs" is not Google Chrome.
  return p.includes(a) || a.includes(p) || a.includes(p.replace(/^(?:microsoft|google|mozilla|adobe|apple) /, ''));
}
