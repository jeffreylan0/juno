/**
 * The extras: every colour theme but the default, placing the bar and the
 * panel, and more than FREE_MACROS macros. Open with a plan (Plus, or one
 * given by hand) or the unlock (account/unlock.ts). In a build without
 * accounts there is nothing to buy, so they are open.
 *
 * Closed, what was chosen is kept, not undone: the settings act as if left
 * at their defaults (withinPlan), and come back as they were once the
 * extras open again.
 */
import { ACCOUNTS } from './account/config';
import { entitlementItem, type Entitlement } from './account/session';
import { unlockItem, unlockedHere } from './account/unlock';
import { DEFAULT_SETTINGS, type Settings } from './storage';
import { DEFAULT_THEME } from './themes';

/** The macros free to use, the first ones in the list. */
export const FREE_MACROS = 2;

/** `unlocked`: the unlock bought on this computer is here (account/unlock.ts). */
export function extrasOpen(ent: Entitlement | null, unlocked: boolean): boolean {
  return !ACCOUNTS || unlocked || (!!ent && ent.plan !== 'free');
}

/** The settings as they act: with the extras closed, those they would change at their defaults. */
export function withinPlan(s: Settings, open: boolean): Settings {
  if (open) return s;
  return { ...s, theme: DEFAULT_THEME, barPlace: DEFAULT_SETTINGS.barPlace, panelPlace: DEFAULT_SETTINGS.panelPlace, macros: s.macros.slice(0, FREE_MACROS) };
}

/** Whether the extras are open now. */
export async function extrasOpenNow(): Promise<boolean> {
  if (!ACCOUNTS) return true;
  const [ent, unlocked] = await Promise.all([entitlementItem.getValue().catch(() => null), unlockedHere()]);
  return extrasOpen(ent, unlocked);
}

/** Calls `fn` with whether the extras are open, as soon as that is known and whenever it changes. */
export function watchExtras(fn: (open: boolean) => void): () => void {
  if (!ACCOUNTS) {
    fn(true);
    return () => {};
  }
  let last: boolean | null = null;
  const tell = () =>
    void extrasOpenNow().then((open) => {
      if (open === last) return;
      last = open;
      fn(open);
    });
  tell();
  const offs = [entitlementItem.watch(tell), unlockItem.watch(tell)];
  return () => offs.forEach((off) => off());
}
