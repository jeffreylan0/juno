/**
 * The extras (lib/extras.ts): every theme, placing the bar and the panel,
 * more than two macros. Open with a plan or the unlock; closed, the
 * settings act as if left at their defaults, and what was chosen is kept.
 */
import { describe, expect, it } from 'vitest';
import { entitlementItem, type Entitlement } from '@/lib/account/session';
import { licenseFits } from '@/lib/account/unlock';
import { FREE_MACROS, extrasOpen, watchExtras, withinPlan } from '@/lib/extras';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/storage';

const ent = (plan: string): Entitlement => ({ plan, planName: plan, cloud: false, quota: 0, used: 0, billing: null, customer: false, checkedAt: 0 });


describe('the extras', () => {
  it('open with a plan or the unlock, not on the free plan or as a guest', () => {
    expect(extrasOpen(null, false)).toBe(false);
    expect(extrasOpen(ent('free'), false)).toBe(false);
    expect(extrasOpen(ent('plus'), false)).toBe(true);
    expect(extrasOpen(ent('unlimited'), false)).toBe(true);
    expect(extrasOpen(null, true)).toBe(true);
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

  it('are watched: a plan starting or ending is heard at once', async () => {
    const heard: boolean[] = [];
    const stop = watchExtras((open) => heard.push(open));
    await new Promise((r) => setTimeout(r, 20));
    await entitlementItem.setValue(ent('plus'));
    await new Promise((r) => setTimeout(r, 20));
    await entitlementItem.setValue(ent('free'));
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(heard).toEqual([false, true, false]);
  });
});

describe('the unlock', () => {
  const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
  const HERE = 'a'.repeat(64);

  it('counts only a license signed with the unlock key, for this computer', async () => {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = b64url(await crypto.subtle.exportKey('raw', keys.publicKey));
    const sign = async (payload: object, key = keys.privateKey) => {
      const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
      return `${body}.${b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(body)))}`;
    };
    const license = await sign({ d: HERE, p: 'pi_1', t: 1 });
    expect(await licenseFits(license, HERE, pub)).toBe(true);
    // Copied to another computer: it names this one, not that one.
    expect(await licenseFits(license, 'b'.repeat(64), pub)).toBe(false);
    // Edited to name another computer: the signature no longer fits.
    const [, sig] = license.split('.');
    expect(await licenseFits(`${b64url(new TextEncoder().encode(JSON.stringify({ d: 'b'.repeat(64), p: 'pi_1', t: 1 })))}.${sig}`, 'b'.repeat(64), pub)).toBe(false);
    // Signed with any other key.
    const other = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    expect(await licenseFits(await sign({ d: HERE, p: 'pi_1', t: 1 }, other.privateKey), HERE, pub)).toBe(false);
    expect(await licenseFits('junk', HERE, pub)).toBe(false);
  });
});
