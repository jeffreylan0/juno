/**
 * Subscriptions, from Stripe's webhook, written to public.entitlements.
 *
 * The checkout itself is not built yet. When it is: create a Checkout
 * Session (mode "subscription") with client_reference_id set to the
 * student's Supabase user id, so the first event below can tie the Stripe
 * customer to the account. After that, subscription events find the account
 * by its Stripe customer id.
 *
 * Webhook endpoint in Stripe: https://<worker>/stripe/webhook, sending
 * checkout.session.completed, customer.subscription.updated and
 * customer.subscription.deleted. Its signing secret is STRIPE_WEBHOOK_SECRET.
 */
import type { Env } from './index';

/** The plan a paid subscription gives (see public.monthly_quota). */
const PAID_PLAN = 'student';
/** Stripe signs with a timestamp; older events are replays. */
const TOLERANCE_S = 300;

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  const payload = await request.text();
  if (!signature || !(await verify(payload, signature, env.STRIPE_WEBHOOK_SECRET))) {
    return new Response('Bad signature', { status: 400 });
  }
  const event = JSON.parse(payload) as { type: string; data: { object: Record<string, unknown> } };
  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = obj.client_reference_id as string | undefined;
      const customer = obj.customer as string | undefined;
      if (userId && customer) await upsert(env, { user_id: userId, stripe_customer: customer, plan: PAID_PLAN });
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const customer = obj.customer as string | undefined;
      const status = obj.status as string | undefined;
      const active = event.type === 'customer.subscription.updated' && (status === 'active' || status === 'trialing');
      const renews = typeof obj.current_period_end === 'number' ? new Date(obj.current_period_end * 1000).toISOString() : null;
      if (customer) await patchByCustomer(env, customer, { plan: active ? PAID_PLAN : null, plan_renews_at: active ? renews : null });
      break;
    }
  }
  return new Response('ok');
}

function headers(env: Env): Record<string, string> {
  const key = env.SUPABASE_SECRET_KEY;
  return { apikey: key, 'content-type': 'application/json', ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}) };
}

async function upsert(env: Env, row: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/entitlements?on_conflict=user_id`, {
    method: 'POST',
    headers: { ...headers(env), prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`entitlements upsert failed (${res.status})`);
}

async function patchByCustomer(env: Env, customer: string, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/entitlements?stripe_customer=eq.${encodeURIComponent(customer)}`, {
    method: 'PATCH',
    headers: { ...headers(env), prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`entitlements update failed (${res.status})`);
}

/** Stripe's scheme: HMAC-SHA256 over `${timestamp}.${payload}`, any of the v1 signatures. */
async function verify(payload: string, header: string, secret: string): Promise<boolean> {
  if (!secret) return false;
  const pairs = header.split(',').map((p) => p.split('=') as [string, string]);
  const timestamp = pairs.find(([k]) => k === 't')?.[1];
  const sigs = pairs.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || !sigs.length || Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_S) return false;
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
