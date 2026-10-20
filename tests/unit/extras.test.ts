/**
 * The extras (lib/extras.ts): every theme, placing the bar and the panel,
 * more than two macros. Open with a plan or the unlock; closed, the
 * settings act as if left at their defaults, and what was chosen is kept.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from '@webext-core/fake-browser';
import { entitlementItem, type Entitlement } from '@/lib/account/session';
import { unlockItem } from '@/lib/account/unlock';
import { FREE_MACROS, extrasOpen, watchExtras, withinPlan } from '@/lib/extras';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/storage';

const ent = (plan: string): Entitlement => ({ plan, planName: plan, cloud: false, quota: 0, used: 0, billing: null, customer: false, checkedAt: 0 });

beforeEach(() => fakeBrowser.reset());

describe('the extras', () => {
  it('open with a plan or the unlock, not on the free plan or as a guest', () => {
    expect(extrasOpen(null, null)).toBe(false);
    expect(extrasOpen(ent('free'), null)).toBe(false);
    expect(extrasOpen(ent('plus'), null)).toBe(true);
    expect(extrasOpen(ent('unlimited'), null)).toBe(true);
    expect(extrasOpen(null, { code: 'JUNO-AB12-CD34-EF56', at: 1 })).toBe(true);
  });

  it('closed, act as the defaults, and keep what was chosen for when they open', () => {
    const chosen: Settings = {
      ...DEFAULT_SETTINGS,
      theme: 'ocean',
      barPlace: 'top-left',
      panelPlace: 'bottom-left',
      macros: [...DEFAULT_SETTINGS.macros, { id: 'mine', name: 'Mine', prompt: 'Mine' }],
    };
    const closed = withinPlan(chosen, false);
    expect([closed.theme, closed.barPlace, closed.panelPlace]).toEqual([DEFAULT_SETTINGS.theme, DEFAULT_SETTINGS.barPlace, DEFAULT_SETTINGS.panelPlace]);
    expect(closed.macros.map((m) => m.id)).toEqual(chosen.macros.slice(0, FREE_MACROS).map((m) => m.id));
    expect(withinPlan(chosen, true)).toBe(chosen);
    expect(chosen.macros).toHaveLength(5);
  });

  it('are watched: buying the unlock, or a plan ending, is heard at once', async () => {
    const heard: boolean[] = [];
    const stop = watchExtras((open) => heard.push(open));
    await new Promise((r) => setTimeout(r, 20));
    await unlockItem.setValue({ code: 'JUNO-AB12-CD34-EF56', at: 1 });
    await new Promise((r) => setTimeout(r, 20));
    await unlockItem.setValue(null);
    await entitlementItem.setValue(ent('plus'));
    await new Promise((r) => setTimeout(r, 20));
    await entitlementItem.setValue(ent('free'));
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(heard).toEqual([false, true, false, true, false]);
  });
});
