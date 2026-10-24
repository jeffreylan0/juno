/**
 * The unlock: the app's extras (every colour theme, placing the bar and the
 * panel, more than two macros) for one payment, on one computer, for
 * students who would rather not have an account. With no account there is
 * no session: the app sends its computer's id (a salted hash:
 * desktop/src-tauri/src/device.rs), the Worker puts it on the payment, and
 * once Stripe says it is paid, signs a license for that id alone (ECDSA
 * P-256, the UNLOCK_SIGNING_KEY secret). The app checks the signature with
 * the public half built into it, and that the id is its own, so a license
 * copied to another computer opens nothing there. Its price is the one-time
 * Stripe price whose lookup key is UNLOCK_PRICE; without it, or without the
 * signing key, nothing is on offer.
 *
 * Routes (index.ts), all without a session:
 *   GET  /unlock           { amount, currency }, or 404 when it isn't on offer
 *   POST /unlock/checkout  { device }: a Stripe Checkout page → { url, session }
 *   POST /unlock/claim     { session, device }: once paid → { license }; 409 until then
 *   POST /unlock/restore   { device }: this computer's unlock again, after a reinstall → { license }
 *   GET  /unlock/done      where Stripe sends the browser back
 */
import { BillingError, page, stripe, type CheckoutSession } from './billing';
import { readBody } from './body';
import type { Env } from './index';

const DEVICE = /^[0-9a-f]{64}$/;
const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const PRICE_TTL_MS = 5 * 60_000;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let signing: { jwk: string; key: Promise<CryptoKey> } | null = null;

/** The signing key, from the secret (a P-256 private JWK: worker/scripts/unlock-key.mjs). */
function signingKey(env: Env): Promise<CryptoKey> | null {
  const jwk = (env.UNLOCK_SIGNING_KEY ?? '').trim();
  if (!jwk) return null;
  if (signing?.jwk !== jwk) {
    signing = { jwk, key: crypto.subtle.importKey('jwk', JSON.parse(jwk) as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  }
  return signing.key;
}

/** `{ d: device, p: payment, t: seconds }`, then its signature: what the app checks (lib/account/unlock.ts). */
export async function license(env: Env, device: string, payment: string): Promise<string> {
  const key = signingKey(env);
  if (!key) throw notOnOffer();
  const body = b64url(new TextEncoder().encode(JSON.stringify({ d: device, p: payment, t: Math.floor(Date.now() / 1000) })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

interface Price {
  id: string;
  amount: number;
  currency: string;
}

let cached: { key: string; at: number; price: Price | null } | null = null;

async function price(env: Env): Promise<Price | null> {
  const key = (env.UNLOCK_PRICE ?? '').trim();
  if (!key || !env.STRIPE_SECRET_KEY || !signingKey(env)) return null;
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

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readBody(request, 2048)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function deviceOf(raw: unknown): string {
  if (typeof raw !== 'string' || !DEVICE.test(raw)) throw new BillingError('This computer could not be identified.', 400, 'no-device');
  return raw;
}

/** A Checkout page for the unlock, for this computer. */
export async function unlockCheckout(request: Request, env: Env): Promise<{ url: string; session: string }> {
  const device = deviceOf((await body(request)).device);
  const p = await price(env);
  if (!p) throw notOnOffer();
  const origin = new URL(request.url).origin;
  const metadata = { kind: 'unlock', unlock_device: device };
  const made = await stripe<{ id: string; url: string }>(env, 'POST', '/checkout/sessions', {
    mode: 'payment',
    line_items: [{ price: p.id, quantity: 1 }],
    success_url: `${origin}/unlock/done?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/billing/done?result=cancelled`,
    metadata,
    // On the payment too, where restoring finds it.
    payment_intent_data: { metadata, description: 'Juno unlock, one computer' },
    ...(env.STRIPE_TAX === 'on' ? { automatic_tax: { enabled: true } } : {}),
  });
  return { url: made.url, session: made.id };
}

/** The checkout, once Stripe says it is paid; null while it isn't. Only an unlock's checkout counts. */
async function paidCheckout(env: Env, session: unknown): Promise<CheckoutSession | null> {
  if (typeof session !== 'string' || !SESSION.test(session)) throw notOnOffer();
  const s = await stripe<CheckoutSession>(env, 'GET', `/checkout/sessions/${encodeURIComponent(session)}`);
  if (s.metadata?.kind !== 'unlock' || !DEVICE.test(s.metadata.unlock_device ?? '')) throw notOnOffer();
  return s.payment_status === 'paid' ? s : null;
}

/** The app asks, while its checkout is open, whether it has been paid: then the license, for the computer that paid. */
export async function unlockClaim(request: Request, env: Env): Promise<{ license: string }> {
  const sent = await body(request);
  const device = deviceOf(sent.device);
  const s = await paidCheckout(env, sent.session);
  if (!s) throw new BillingError('Not paid yet.', 409, 'pending');
  // A checkout made for another computer gives this one nothing.
  if (s.metadata.unlock_device !== device) throw notOnOffer();
  return { license: await license(env, device, s.payment_intent ?? s.id) };
}

interface PaymentIntent {
  id: string;
  metadata: Record<string, string>;
  latest_charge: { refunded: boolean; disputed: boolean } | null;
}

/** This computer's unlock again (the app reinstalled): if a payment for it went through and was not refunded or disputed. */
export async function unlockRestore(request: Request, env: Env): Promise<{ license: string }> {
  const device = deviceOf((await body(request)).device);
  // The id is checked against DEVICE above, so it can't break out of the query's quotes.
  const found = await stripe<{ data: PaymentIntent[] }>(env, 'GET', '/payment_intents/search', {
    query: `metadata['unlock_device']:'${device}' AND status:'succeeded'`,
    expand: ['data.latest_charge'],
  });
  const paid = found.data.find((pi) => pi.metadata.kind === 'unlock' && !pi.latest_charge?.refunded && !pi.latest_charge?.disputed);
  if (!paid) throw new BillingError("No unlock was bought on this computer. If you bought one, write to info@humanbn.com.", 404, 'no-unlock');
  return { license: await license(env, device, paid.id) };
}

/** Where Stripe sends the browser back. The app unlocks by itself. */
export async function unlockDone(request: Request, env: Env): Promise<Response> {
  const paid = await paidCheckout(env, new URL(request.url).searchParams.get('session_id')).catch(() => null);
  return paid
    ? page('Unlocked', 'Thank you! Go back to Juno: it unlocks by itself on this computer. You can close this tab.')
    : page('Almost there', 'Your payment is being confirmed. Juno unlocks by itself once it is; you can close this tab.');
}
