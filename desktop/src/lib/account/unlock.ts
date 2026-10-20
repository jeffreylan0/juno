/**
 * The unlock, for students who would rather not have an account
 * (worker/src/unlock.ts): one payment opens the extras (lib/extras.ts) on
 * this computer. What is kept is a license the Worker signed for this
 * computer's id (src-tauri/src/device.rs); it counts only if its signature
 * checks out against the public key built into the app (UNLOCK_KEY) and it
 * names this computer, so a copy taken to another computer opens nothing.
 */
import { defineItem, GATEWAY_URL } from '../storage';
import { openStripe } from './billing';
import { ACCOUNTS, UNLOCK_KEY } from './config';
import { AccountError } from './session';

export interface Unlock {
  /** `<payload>.<signature>`, base64url: the payload is `{ d: device, p: payment, t }`. */
  license: string;
  /** When it was kept, in ms. */
  at: number;
}

export const unlockItem = defineItem<Unlock | null>('unlock', null);

/** Whether this build can sell and check the unlock. */
export const UNLOCK = ACCOUNTS && !!UNLOCK_KEY;

/** How often an open checkout is asked about, and for how long. */
const POLL_MS = 3000;
const WAIT_MS = 20 * 60_000;

const base = () => GATEWAY_URL.replace(/\/$/, '');
const bytes = (b64url: string) => Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const keys = new Map<string, Promise<CryptoKey>>();
const checks = new Map<string, Promise<boolean>>();

/** Whether `license` was signed with the unlock's key, for `device`. */
export function licenseFits(license: string, device: string, key = UNLOCK_KEY): Promise<boolean> {
  const id = `${key} ${device} ${license}`;
  let check = checks.get(id);
  if (!check) {
    check = (async () => {
      const [body, sig] = license.split('.');
      if (!body || !sig || !key) return false;
      if (!keys.has(key)) keys.set(key, crypto.subtle.importKey('raw', bytes(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
      const signed = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await keys.get(key)!, bytes(sig), new TextEncoder().encode(body));
      return signed && (JSON.parse(new TextDecoder().decode(bytes(body))) as { d?: unknown }).d === device;
    })().catch(() => false);
    checks.set(id, check);
  }
  return check;
}

/** Whether the unlock bought on this computer is here. */
export async function unlockedHere(): Promise<boolean> {
  if (!UNLOCK) return false;
  const [unlock, device] = await Promise.all([unlockItem.getValue().catch(() => null), browser.runtime.deviceId()]);
  return !!unlock && !!device && (await licenseFits(unlock.license, device));
}

/** What it costs; null when it isn't on offer, or the Worker can't be reached. */
export async function unlockOffer(): Promise<{ amount: number; currency: string } | null> {
  if (!UNLOCK) return null;
  try {
    const res = await fetch(`${base()}/unlock`, { signal: AbortSignal.timeout(8000) });
    return res.ok ? ((await res.json()) as { amount: number; currency: string }) : null;
  } catch {
    return null;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new AccountError("Couldn't reach the payment service. Check your connection.", 'network');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new AccountError(data.error?.message ?? `The payment service said ${res.status}.`, 'server', res.status);
  return data;
}

async function device(): Promise<string> {
  const id = await browser.runtime.deviceId();
  if (!id) throw new AccountError("This computer couldn't be identified, so it can't be unlocked. Plus works instead.", 'server');
  return id;
}

async function keep(license: string, id: string): Promise<void> {
  if (!(await licenseFits(license, id))) throw new AccountError("The unlock didn't check out. Write to info@humanbn.com.", 'server');
  await unlockItem.setValue({ license, at: Date.now() });
}

/**
 * Opens Stripe Checkout in the browser, then asks every few seconds whether
 * it was paid; resolves once this computer is unlocked. `signal` stops the asking.
 */
export async function buyUnlock(signal?: AbortSignal): Promise<void> {
  const id = await device();
  const { url, session } = await post<{ url: string; session: string }>('/unlock/checkout', { device: id });
  openStripe(url);
  for (const until = Date.now() + WAIT_MS; Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (signal?.aborted) throw new AccountError('Stopped waiting for checkout.', 'cancelled');
    try {
      return await keep((await post<{ license: string }>('/unlock/claim', { session, device: id })).license, id);
    } catch (err) {
      // 409: not paid yet. A connection that drops for a moment is not the end either.
      const e = err as AccountError;
      if (e.status !== 409 && e.code !== 'network') throw err;
    }
  }
  throw new AccountError("Checkout didn't finish here. If you paid, press Restore in a minute.", 'server');
}

/** This computer's unlock again (after a reinstall): the Worker finds it by this computer's id. */
export async function restoreUnlock(): Promise<void> {
  const id = await device();
  await keep((await post<{ license: string }>('/unlock/restore', { device: id })).license, id);
}
