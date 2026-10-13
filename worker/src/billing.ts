/**
 * Subscriptions and passes, with Stripe (no SDK: a few form-encoded calls).
 *
 * Stripe is the source of truth for who pays; the webhook mirrors it into
 * public.subscriptions, which public.account_of() reads with everything
 * else an account has. Each subscription event, and each pass bought, is
 * answered by reading its state back from Stripe, so events that arrive
 * late, twice or out of order never leave an old state behind. Only
 * checkouts this Worker made give a plan.
 *
 * Prices are made in the Stripe dashboard and found by their lookup keys
 * (STRIPE_PRICES, in the order shown), so a new price never needs a new
 * Worker. A price names the plan it gives in its metadata (`plan`, default
 * plus); a one-time price is a pass for `pass_days` days (default 120, a
 * semester).
 *
 * Routes (index.ts):
 *   GET  /billing/prices    what is on offer, and what each plan gives
 *   POST /billing/checkout  { price }: a Stripe Checkout page → { url }
 *   POST /billing/portal    Stripe's customer portal (card, cancel, invoices) → { url }
 *   GET  /billing/done      where Stripe sends the browser back
 *   POST /billing/close     ends the account's billing, before the account is deleted
 *   POST /stripe/webhook    Stripe's events
 */
import type { Session } from './auth';
import { readBody } from './body';
import type { Env } from './index';
import { accountOf, rest, upsert } from './supabase';

const STRIPE = 'https://api.stripe.com/v1';
/** Stripe signs with a timestamp; older events are replays. */
const TOLERANCE_S = 300;
const DEFAULT_PLAN = 'plus';
const DEFAULT_PASS_DAYS = 120;
const PRICES_TTL_MS = 5 * 60_000;
/** Stripe's events are a few KB; nothing near this is real. */
const MAX_EVENT_BYTES = 1024 * 1024;

export class BillingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

// ── Stripe's API ─────────────────────────────────────────────────────────

type Params = { [key: string]: string | number | boolean | null | undefined | Params | (string | Params)[] };

/** Stripe's form encoding: nested keys in brackets, arrays by index. */
export function form(params: Params, prefix = ''): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => out.push(typeof item === 'object' ? form(item, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`));
    } else if (typeof v === 'object') {
      out.push(form(v, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out.filter(Boolean).join('&');
}

async function stripe<T>(env: Env, method: 'GET' | 'POST' | 'DELETE', path: string, params?: Params): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new BillingError("Payments aren't set up yet.", 503, 'no-billing');
  const query = params ? form(params) : '';
  const res = await fetch(method === 'POST' || !query ? `${STRIPE}${path}` : `${STRIPE}${path}?${query}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? query : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    console.error(`stripe ${method} ${path} ${res.status}: ${data.error?.message ?? ''}`);
    throw new BillingError("Payments aren't available right now. Try again in a minute.", res.status === 404 ? 404 : 502, 'billing');
  }
  return data;
}

// ── What is on offer ─────────────────────────────────────────────────────

interface StripePrice {
  id: string;
  lookup_key: string | null;
  unit_amount: number | null;
  currency: string;
  type: 'recurring' | 'one_time';
  recurring: { interval: 'day' | 'week' | 'month' | 'year'; interval_count: number } | null;
  metadata: Record<string, string>;
  product: { name: string; metadata: Record<string, string> } | string;
}

interface Plan {
  id: string;
  name: string;
  monthly_questions: number;
  cloud: boolean;
}

export interface Offer {
  /** The price's lookup key: what the apps ask to buy. */
  key: string;
  priceId: string;
  name: string;
  /** In the currency's smallest unit (cents). */
  amount: number;
  currency: string;
  /** How often it renews; null for a pass. */
  interval: 'month' | 'year' | null;
  intervalCount: number;
  /** A pass's length; null for a subscription. */
  passDays: number | null;
  plan: Plan;
}

let offers: { key: string; at: number; list: Offer[] } | null = null;

const lookupKeys = (env: Env) =>
  (env.STRIPE_PRICES ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

/** The prices on offer, in STRIPE_PRICES order, with what their plans give. None when billing is not set up. */
export async function prices(env: Env): Promise<Offer[]> {
  const keys = lookupKeys(env);
  if (!env.STRIPE_SECRET_KEY || !keys.length) return [];
  const cacheKey = keys.join(',');
  if (offers && offers.key === cacheKey && Date.now() - offers.at < PRICES_TTL_MS) return offers.list;
  const [found, plans] = await Promise.all([
    stripe<{ data: StripePrice[] }>(env, 'GET', '/prices', { active: true, limit: 20, lookup_keys: keys, expand: ['data.product'] }),
    rest(env, 'plans?select=id,name,monthly_questions,cloud').then((r) => r.json() as Promise<Plan[]>),
  ]);
  const list: Offer[] = [];
  for (const key of keys) {
    const p = found.data.find((x) => x.lookup_key === key);
    if (!p || p.unit_amount === null) continue;
    const product = typeof p.product === 'string' ? { name: '', metadata: {} } : p.product;
    const plan = plans.find((x) => x.id === (p.metadata.plan || product.metadata.plan || DEFAULT_PLAN));
    if (!plan) continue;
    const interval = p.recurring?.interval === 'month' || p.recurring?.interval === 'year' ? p.recurring.interval : null;
    if (p.type === 'recurring' && !interval) continue;
    list.push({
      key,
      priceId: p.id,
      name: product.name || plan.name,
      amount: p.unit_amount,
      currency: p.currency,
      interval,
      intervalCount: p.recurring?.interval_count ?? 1,
      passDays: p.type === 'one_time' ? Number(p.metadata.pass_days || product.metadata.pass_days) || DEFAULT_PASS_DAYS : null,
      plan,
    });
  }
  offers = { key: cacheKey, at: Date.now(), list };
  return list;
}

// ── Buying, managing, closing ────────────────────────────────────────────

/** The account's Stripe customer, made the first time it is needed. */
async function customerFor(env: Env, session: Session, create: boolean): Promise<string | null> {
  const find = async () =>
    ((await (await rest(env, `customers?user_id=eq.${session.userId}&select=stripe_customer`)).json()) as { stripe_customer: string }[])[0]
      ?.stripe_customer ?? null;
  const known = await find();
  if (known || !create) return known;
  const made = await stripe<{ id: string }>(env, 'POST', '/customers', { email: session.email, metadata: { user_id: session.userId } });
  // Two clicks at once: the first saved wins; the other customer stays empty.
  await rest(env, 'customers?on_conflict=user_id', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: session.userId, stripe_customer: made.id }),
  });
  return (await find()) ?? made.id;
}

/** A Checkout page for one price on offer. */
export async function checkout(request: Request, session: Session, env: Env): Promise<{ url: string }> {
  let price: unknown;
  try {
    ({ price } = JSON.parse(await readBody(request, 8 * 1024)) as { price?: unknown });
  } catch {
    // Not a plan on offer: refused below.
  }
  const offer = (await prices(env)).find((o) => o.key === price);
  if (!offer) throw new BillingError("That plan isn't on offer.", 404, 'no-price');
  const account = await accountOf(env, session.userId);
  if (account.billing?.active) {
    throw new BillingError(`You already have ${account.plan_name}. Manage it from Settings.`, 409, 'already');
  }
  const customer = await customerFor(env, session, true);
  const back = `${new URL(request.url).origin}/billing/done`;
  const metadata = { user_id: session.userId, plan: offer.plan.id, price: offer.key, ...(offer.passDays ? { pass_days: offer.passDays } : {}) };
  const made = await stripe<{ url: string }>(env, 'POST', '/checkout/sessions', {
    mode: offer.interval ? 'subscription' : 'payment',
    customer,
    client_reference_id: session.userId,
    line_items: [{ price: offer.priceId, quantity: 1 }],
    success_url: `${back}?result=paid`,
    cancel_url: `${back}?result=cancelled`,
    allow_promotion_codes: true,
    metadata,
    ...(offer.interval ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
    ...(env.STRIPE_TAX === 'on' ? { automatic_tax: { enabled: true }, customer_update: { address: 'auto', name: 'auto' } } : {}),
  });
  return { url: made.url };
}

/** Stripe's customer portal: the card, invoices, switching or cancelling. */
export async function portal(request: Request, session: Session, env: Env): Promise<{ url: string }> {
  const customer = await customerFor(env, session, false);
  if (!customer) throw new BillingError("You haven't subscribed yet.", 404, 'no-customer');
  const made = await stripe<{ url: string }>(env, 'POST', '/billing_portal/sessions', {
    customer,
    return_url: `${new URL(request.url).origin}/billing/done?result=managed`,
  });
  return { url: made.url };
}

/**
 * Before an account is deleted: its Stripe customer goes, which ends every
 * subscription at once (nothing more is charged). Stripe keeps its own
 * records of past payments, as the law requires.
 */
export async function close(session: Session, env: Env): Promise<{ ok: true }> {
  const customer = await customerFor(env, session, false);
  if (customer) {
    await stripe(env, 'DELETE', `/customers/${encodeURIComponent(customer)}`).catch((err) => {
      if (!(err instanceof BillingError && err.status === 404)) throw err;
    });
    await rest(env, `customers?user_id=eq.${session.userId}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
  }
  return { ok: true };
}

/** Where Stripe sends the browser back: the app shows the change by itself. */
export function donePage(request: Request): Response {
  const result = new URL(request.url).searchParams.get('result');
  const [title, line] =
    result === 'paid'
      ? ["You're all set", 'Thank you! Go back to Juno: your plan is on within a few seconds.']
      : result === 'managed'
        ? ['Done', 'Go back to Juno. Any change shows there within a few seconds.']
        : ['Nothing was charged', 'Checkout was cancelled. Go back to Juno whenever you like.'];
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Juno</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf9f5;color:#141413;font:16px/1.5 system-ui,sans-serif}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0;color:#5e5d59}
@media (prefers-color-scheme:dark){body{background:#262624;color:#faf9f5}p{color:#b7b5a9}}</style>
<main><h1>${title}</h1><p>${line} You can close this tab.</p></main></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Fixed text only, but the page still allows nothing it doesn't use.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

// ── Stripe's events ──────────────────────────────────────────────────────

interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  current_period_end?: number;
  metadata: Record<string, string>;
  items: { data: { current_period_end?: number; price: { id: string; lookup_key: string | null; metadata: Record<string, string> } }[] };
}

const iso = (seconds: number | null | undefined) => (typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null);

/** A plan the database knows, so a typo in a price's metadata never blocks the webhook. */
async function knownPlan(env: Env, wanted: string | undefined): Promise<string> {
  if (!wanted || wanted === DEFAULT_PLAN) return DEFAULT_PLAN;
  const rows = (await (await rest(env, `plans?id=eq.${encodeURIComponent(wanted)}&select=id`)).json()) as unknown[];
  return rows.length ? wanted : DEFAULT_PLAN;
}

async function userForCustomer(env: Env, customer: string): Promise<string | null> {
  const rows = (await (await rest(env, `customers?stripe_customer=eq.${encodeURIComponent(customer)}&select=user_id`)).json()) as { user_id: string }[];
  return rows[0]?.user_id ?? null;
}

async function linkCustomer(env: Env, userId: string, customer: string): Promise<void> {
  await rest(env, 'customers?on_conflict=user_id', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, stripe_customer: customer }),
  });
}

/** Reads the subscription back from Stripe and saves it as it is now. */
async function syncSubscription(env: Env, id: string, userHint?: string): Promise<void> {
  const sub = await stripe<StripeSubscription>(env, 'GET', `/subscriptions/${encodeURIComponent(id)}`);
  const userId = sub.metadata.user_id || userHint || (await userForCustomer(env, sub.customer));
  if (!userId) {
    console.warn(`subscription ${sub.id}: no account for customer ${sub.customer}`);
    return;
  }
  const item = sub.items.data[0];
  await saveFor(env, userId, 'subscriptions', {
    id: sub.id,
    user_id: userId,
    plan: await knownPlan(env, item?.price.metadata.plan || sub.metadata.plan),
    kind: 'subscription',
    status: sub.status,
    price: item?.price.lookup_key ?? item?.price.id ?? null,
    // Newer API versions keep the period on the item.
    period_end: iso(item?.current_period_end ?? sub.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end || sub.cancel_at !== null,
    updated_at: new Date().toISOString(),
  });
}

interface CheckoutSession {
  id: string;
  mode: 'subscription' | 'payment' | 'setup';
  created: number;
  customer: string | null;
  client_reference_id: string | null;
  subscription: string | null;
  payment_intent: string | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  metadata: Record<string, string>;
}

/**
 * Saves a row for an account, unless the account is gone: the events its
 * deletion sets off (the closed subscription) arrive after it, and must not
 * be retried for days.
 */
async function saveFor(env: Env, userId: string, table: string, row: Record<string, unknown>): Promise<void> {
  try {
    await upsert(env, table, 'id', row);
  } catch (err) {
    if (/\b23503\b/.test(String(err))) return console.warn(`${table} ${String(row.id)}: account ${userId} no longer exists`);
    throw err;
  }
}

interface PaymentIntent {
  status: string;
  latest_charge: { refunded: boolean; disputed: boolean } | null;
}

/** What a pass's payment is now, from Stripe (never the event's copy): paid, refunded or disputed. */
async function passStatus(env: Env, paymentIntent: string | null): Promise<string> {
  if (!paymentIntent) return 'paid';
  const pi = await stripe<PaymentIntent>(env, 'GET', `/payment_intents/${encodeURIComponent(paymentIntent)}`, { expand: ['latest_charge'] });
  if (pi.latest_charge?.disputed) return 'disputed';
  if (pi.latest_charge?.refunded) return 'refunded';
  return pi.status === 'succeeded' ? 'paid' : pi.status;
}

/** A pass bought (paid): it runs pass_days from when it was bought. */
async function savePass(env: Env, s: CheckoutSession, userId: string): Promise<void> {
  const days = Number(s.metadata.pass_days) || DEFAULT_PASS_DAYS;
  await saveFor(env, userId, 'subscriptions', {
    id: s.id,
    user_id: userId,
    plan: await knownPlan(env, s.metadata.plan),
    kind: 'pass',
    status: await passStatus(env, s.payment_intent),
    price: s.metadata.price ?? null,
    period_end: new Date((s.created + days * 86_400) * 1000).toISOString(),
    cancel_at_period_end: true,
    payment: s.payment_intent,
    updated_at: new Date().toISOString(),
  });
}

async function setPassStatus(env: Env, paymentIntent: unknown, status: string, from?: string): Promise<void> {
  if (typeof paymentIntent !== 'string') return;
  await rest(env, `subscriptions?kind=eq.pass&payment=eq.${encodeURIComponent(paymentIntent)}${from ? `&status=eq.${from}` : ''}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  });
}

export async function webhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return new Response('Bad signature', { status: 400 });
  const payload = await readBody(request, MAX_EVENT_BYTES);
  if (!(await verify(payload, signature, env.STRIPE_WEBHOOK_SECRET))) {
    return new Response('Bad signature', { status: 400 });
  }
  const event = JSON.parse(payload) as { type: string; data: { object: Record<string, unknown> } };
  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const s = obj as unknown as CheckoutSession;
      // Only checkouts this Worker made (both set from the session at
      // checkout): a Payment Link or any other integration, whose reference
      // the buyer can choose, never gives a plan.
      const userId = s.metadata?.user_id;
      if (!userId || s.client_reference_id !== userId) {
        console.warn(`checkout ${s.id}: not made by Juno, ignored`);
        break;
      }
      if (s.customer) await linkCustomer(env, userId, s.customer);
      if (s.mode === 'subscription' && s.subscription) await syncSubscription(env, s.subscription, userId);
      else if (s.mode === 'payment' && s.payment_status === 'paid') await savePass(env, s, userId);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      await syncSubscription(env, obj.id as string);
      break;
    case 'charge.refunded':
      // A pass refunded in full ends at once.
      if (obj.refunded) await setPassStatus(env, obj.payment_intent, 'refunded');
      break;
    case 'charge.dispute.created':
      // A chargeback ends a pass while it is open; one won gives it back.
      await setPassStatus(env, obj.payment_intent, 'disputed');
      break;
    case 'charge.dispute.closed':
      if (obj.status === 'won') await setPassStatus(env, obj.payment_intent, 'paid', 'disputed');
      break;
  }
  return new Response('ok');
}

/** Stripe's scheme: HMAC-SHA256 over `${timestamp}.${payload}`, any of the v1 signatures. */
export async function verify(payload: string, header: string, secret: string, now = Date.now()): Promise<boolean> {
  if (!secret) return false;
  const pairs = header.split(',').map((p) => p.split('=') as [string, string]);
  const timestamp = pairs.find(([k]) => k === 't')?.[1];
  const sigs = pairs.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || !sigs.length || !Number.isFinite(Number(timestamp)) || Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => timingSafeEqual(hex, s));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
