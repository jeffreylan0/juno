/**
 * The unlock, for students who would rather not have an account
 * (worker/src/unlock.ts): one payment opens the extras (lib/extras.ts) on
 * this computer, and on any other its code is entered on. What is kept is
 * the code, once the Worker has said it was paid for.
 */
import { storage } from '@wxt-dev/storage';
import { GATEWAY_URL } from '../storage';
import { openStripe } from './billing';
import { AccountError } from './session';

export interface Unlock {
  /** JUNO-XXXX-XXXX-XXXX: what proves the purchase, here and on another computer. */
  code: string;
  /** When it was kept, in ms. */
  at: number;
}

export const unlockItem = storage.defineItem<Unlock | null>('local:unlock', { fallback: null });

/** How often an open checkout is asked about, and for how long. */
const POLL_MS = 3000;
const WAIT_MS = 20 * 60_000;

const base = () => GATEWAY_URL.replace(/\/$/, '');

/** What it costs; null when it isn't on offer, or the Worker can't be reached. */
export async function unlockOffer(): Promise<{ amount: number; currency: string } | null> {
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

async function keep(code: string): Promise<Unlock> {
  const unlock = { code, at: Date.now() };
  await unlockItem.setValue(unlock);
  return unlock;
}

/**
 * Opens Stripe Checkout in the browser, then asks every few seconds whether
 * it was paid; resolves once it was. `signal` stops the asking.
 */
export async function buyUnlock(signal?: AbortSignal): Promise<Unlock> {
  const { url, session } = await post<{ url: string; session: string }>('/unlock/checkout', {});
  openStripe(url);
  for (const until = Date.now() + WAIT_MS; Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (signal?.aborted) throw new AccountError('Stopped waiting for checkout.', 'cancelled');
    try {
      return await keep((await post<{ code: string }>('/unlock/claim', { session })).code);
    } catch (err) {
      // 409: not paid yet. A connection that drops for a moment is not the end either.
      const e = err as AccountError;
      if (e.status !== 409 && e.code !== 'network') throw err;
    }
  }
  throw new AccountError("Checkout didn't finish here. If you paid, enter the code the page showed you.", 'server');
}

/** A code from another computer (or this one, again). */
export async function restoreUnlock(code: string): Promise<Unlock> {
  return await keep((await post<{ code: string }>('/unlock/restore', { code })).code);
}
