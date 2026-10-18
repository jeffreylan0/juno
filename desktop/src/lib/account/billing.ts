/**
 * Plans and payment, through the Worker (worker/src/billing.ts): what is on
 * offer, Stripe Checkout to buy, Stripe's customer portal to change the card,
 * see invoices or cancel. Payment pages open in the student's browser; no
 * card details ever pass through the app.
 *
 * What the account then gets arrives the usual way: Stripe tells the Worker,
 * the Worker the database, and refreshEntitlement() reads it.
 */
import { GATEWAY_URL } from '../storage';
import { AccountError, currentSession } from './session';

/** A price on offer (the Worker's Offer). */
export interface Offer {
  key: string;
  name: string;
  /** In the currency's smallest unit (cents). */
  amount: number;
  currency: string;
  /** How often it renews; null for a pass. */
  interval: 'month' | 'year' | null;
  intervalCount: number;
  /** A pass's length in days; null for a subscription. */
  passDays: number | null;
  plan: { id: string; name: string; monthly_questions: number; cloud: boolean };
}

const base = () => GATEWAY_URL.replace(/\/$/, '');

/** The plans on offer; none when billing is not set up or cannot be reached. */
export async function offers(): Promise<Offer[]> {
  try {
    const res = await fetch(`${base()}/billing/prices`, { signal: AbortSignal.timeout(8000) });
    return res.ok ? ((await res.json()) as Offer[]) : [];
  } catch {
    return [];
  }
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const s = await currentSession();
  if (!s) throw new AccountError('Signed out. Sign in again.', 'signed-out');
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AccountError("Couldn't reach the payment service. Check your connection.", 'network');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new AccountError(data.error?.message ?? `The payment service said ${res.status}.`, 'server', res.status);
  return data;
}

/** Only ever Stripe's own pages: whatever the Worker answers, nothing else is opened. */
const STRIPE_HOSTS = ['checkout.stripe.com', 'billing.stripe.com'];

function openStripe(url: unknown): void {
  let page: URL | null = null;
  try {
    page = new URL(String(url));
  } catch {
    // Not a URL: refused below.
  }
  if (page?.protocol !== 'https:' || !STRIPE_HOSTS.includes(page.hostname)) {
    throw new AccountError("The payment service answered with a page that isn't Stripe's.", 'server');
  }
  window.open(page.href, '_blank', 'noopener');
}

/** Opens Stripe Checkout for one price, in the browser. */
export async function startCheckout(key: string): Promise<void> {
  openStripe((await post<{ url: string }>('/billing/checkout', { price: key })).url);
}

/** Opens Stripe's customer portal, in the browser. */
export async function openPortal(): Promise<void> {
  openStripe((await post<{ url: string }>('/billing/portal')).url);
}

/** Ends the account's billing (its subscriptions stop at once), before the account is deleted. */
export async function closeBilling(): Promise<void> {
  await post('/billing/close');
}

/** "$7.99 a month", "$59.99 a year", "$24.99 for 4 months". */
export function priceLabel(o: Offer, locale?: string): string {
  const amount = new Intl.NumberFormat(locale, { style: 'currency', currency: o.currency.toUpperCase() }).format(o.amount / 100);
  if (o.interval) return o.intervalCount > 1 ? `${amount} every ${o.intervalCount} ${o.interval}s` : `${amount} a ${o.interval}`;
  const days = o.passDays ?? 0;
  if (days >= 360 && days <= 366) return `${amount} for a year`;
  const months = Math.round(days / 30);
  return `${amount} for ${days % 30 === 0 || months >= 2 ? `${months} months` : `${days} days`}`;
}
