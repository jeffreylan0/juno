/**
 * The unlock: the app's extras (every colour theme, placing the bar and the
 * panel, more than two macros) for one payment, for students who would
 * rather not have an account. With no account there is no session, so what
 * proves a purchase is its code: a random JUNO-XXXX-XXXX-XXXX this Worker
 * puts on the payment (metadata) and shows the buyer, who can enter it on
 * another computer. Its price is the one-time Stripe price whose lookup key
 * is UNLOCK_PRICE; empty, nothing is on offer.
 *
 * Routes (index.ts), all without a session:
 *   GET  /unlock           { amount, currency }, or 404 when it isn't on offer
 *   POST /unlock/checkout  a Stripe Checkout page → { url, session }
 *   POST /unlock/claim     { session }: once paid → { code }; 409 until then
 *   POST /unlock/restore   { code }: a code paid for, and not refunded → { code }
 *   GET  /unlock/done      where Stripe sends the browser back, with the code
 */
import { BillingError, page, stripe, type CheckoutSession } from './billing';
import { readBody } from './body';
import type { Env } from './index';

/** Crockford's base32: no I, L, O or U to misread. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE = /^JUNO-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const PRICE_TTL_MS = 5 * 60_000;

/** A new code, 60 random bits. */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
  return `JUNO-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** A code as typed (any case, spaces, the dashes or not) in its one form, or null. */
export function cleanCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const chars = raw.toUpperCase().replace(/[\s-]/g, '').replace(/^JUNO/, '');
  const code = chars.length === 12 ? `JUNO-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}` : '';
  return CODE.test(code) ? code : null;
}

interface Price {
  id: string;
  amount: number;
  currency: string;
}

let cached: { key: string; at: number; price: Price | null } | null = null;

async function price(env: Env): Promise<Price | null> {
  const key = (env.UNLOCK_PRICE ?? '').trim();
  if (!key || !env.STRIPE_SECRET_KEY) return null;
  if (cached && cached.key === key && Date.now() - cached.at < PRICE_TTL_MS) return cached.price;
  const found = await stripe<{ data: { id: string; type: string; unit_amount: number | null; currency: string }[] }>(env, 'GET', '/prices', {
    active: true,
    limit: 1,
    lookup_keys: [key],
  });
  const p = found.data[0];
  const one = p && p.type === 'one_time' && p.unit_amount !== null ? { id: p.id, amount: p.unit_amount, currency: p.currency } : null;
  cached = { key, at: Date.now(), price: one };
  return one;
}

const notOnOffer = () => new BillingError("The unlock isn't on offer.", 404, 'no-unlock');

/** What it costs. */
export async function unlockPrice(env: Env): Promise<{ amount: number; currency: string }> {
  const p = await price(env);
  if (!p) throw notOnOffer();
  return { amount: p.amount, currency: p.currency };
}

async function field(request: Request, name: string): Promise<unknown> {
  try {
    return (JSON.parse(await readBody(request, 2048)) as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/** A Checkout page for the unlock, carrying a new code. */
export async function unlockCheckout(request: Request, env: Env): Promise<{ url: string; session: string }> {
  // No account to count against: the caller's address is (Checkout pages cost nothing, but are not for a script).
  const who = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (env.ASK_LIMIT && !(await env.ASK_LIMIT.limit({ key: `unlock:${who}` })).success) {
    throw new BillingError('Too many tries. Wait a minute, then try again.', 429, 'rate-limited');
  }
  const p = await price(env);
  if (!p) throw notOnOffer();
  const code = newCode();
  const origin = new URL(request.url).origin;
  const metadata = { kind: 'unlock', unlock_code: code };
  const made = await stripe<{ id: string; url: string }>(env, 'POST', '/checkout/sessions', {
    mode: 'payment',
    line_items: [{ price: p.id, quantity: 1 }],
    success_url: `${origin}/unlock/done?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/billing/done?result=cancelled`,
    metadata,
    // On the payment too, where restoring finds it.
    payment_intent_data: { metadata, description: `Juno unlock code ${code}` },
    ...(env.STRIPE_TAX === 'on' ? { automatic_tax: { enabled: true } } : {}),
  });
  return { url: made.url, session: made.id };
}

/** The checkout's code, once Stripe says it is paid. */
async function paidCode(env: Env, session: unknown): Promise<string> {
  if (typeof session !== 'string' || !SESSION.test(session)) throw notOnOffer();
  const s = await stripe<CheckoutSession>(env, 'GET', `/checkout/sessions/${encodeURIComponent(session)}`);
  const code = s.metadata?.kind === 'unlock' ? cleanCode(s.metadata.unlock_code) : null;
  if (!code) throw notOnOffer();
  if (s.payment_status !== 'paid') throw new BillingError('Not paid yet.', 409, 'pending');
  return code;
}

/** The app asks, while its checkout is open, whether it has been paid. */
export async function unlockClaim(request: Request, env: Env): Promise<{ code: string }> {
  return { code: await paidCode(env, await field(request, 'session')) };
}

interface PaymentIntent {
  metadata: Record<string, string>;
  latest_charge: { refunded: boolean; disputed: boolean } | null;
}

/** A code entered by hand: taken if its payment went through and was not refunded or disputed. */
export async function unlockRestore(request: Request, env: Env): Promise<{ code: string }> {
  const code = cleanCode(await field(request, 'code'));
  const missing = new BillingError("That code didn't work. Check it, or write to info@humanbn.com.", 404, 'no-code');
  if (!code) throw missing;
  // The code is checked against CODE above, so it can't break out of the query's quotes.
  const found = await stripe<{ data: PaymentIntent[] }>(env, 'GET', '/payment_intents/search', {
    query: `metadata['unlock_code']:'${code}' AND status:'succeeded'`,
    expand: ['data.latest_charge'],
  });
  const paid = found.data.some((pi) => pi.metadata.kind === 'unlock' && !pi.latest_charge?.refunded && !pi.latest_charge?.disputed);
  if (!paid) throw missing;
  return { code };
}

/** Where Stripe sends the browser back: the code, for another computer. The app unlocks by itself. */
export async function unlockDone(request: Request, env: Env): Promise<Response> {
  let code: string | null = null;
  try {
    code = await paidCode(env, new URL(request.url).searchParams.get('session_id'));
  } catch {
    // Not paid yet (a slow card), or not an unlock: the page says so without a code.
  }
  if (!code) return page('Almost there', "Your payment is being confirmed. Juno unlocks by itself once it is; you can close this tab.");
  return page(
    'Unlocked',
    'Thank you! Go back to Juno: it is unlocked. To unlock it on another computer, enter this code in its settings.',
    `<code>${code}</code><p>Keep it somewhere safe.</p>`,
  );
}
