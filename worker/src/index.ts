/**
 * The Cloudflare Worker: what needs a secret the apps must not hold. Hosted
 * answers (signed-in students on a plan ask with the service's own AI keys)
 * and billing (Stripe). Bring-your-own-key, local models and cloud storage
 * never touch it (cloud storage talks to Supabase directly, under row level
 * security).
 *
 * Routes:
 *   POST /auth/google       Google sign-in's code → an ID token (google.ts)
 *   GET  /me                what the account gets (plan, cloud storage, hosted answers, billing)
 *   POST /ask               a streamed answer (OpenAI-compatible SSE), counted against the plan
 *   GET  /billing/prices    plans on offer          (billing.ts, as are the next five)
 *   POST /billing/checkout  a Stripe Checkout page
 *   POST /billing/portal    Stripe's customer portal
 *   GET  /billing/done      where Stripe sends the browser back
 *   POST /billing/close     ends billing before the account is deleted
 *   POST /stripe/webhook    Stripe's events
 *   GET  /unlock, POST /unlock/checkout, /unlock/claim, /unlock/restore, GET /unlock/done
 *                           the one-time unlock, without an account (unlock.ts)
 *
 * Secrets (`wrangler secret put …`, never committed):
 *   SUPABASE_URL          https://<project>.supabase.co
 *   SUPABASE_SECRET_KEY   the project's secret key (sb_secret_…); bypasses row level security
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY
 *   STRIPE_SECRET_KEY     a restricted key (supabase/README.md)
 *   STRIPE_WEBHOOK_SECRET the webhook endpoint's signing secret (whsec_…)
 *   GOOGLE_CLIENT_SECRET  the Google desktop sign-in client's secret (supabase/README.md, step 3)
 *   UNLOCK_SIGNING_KEY    the unlock's signing key, a P-256 private JWK (scripts/unlock-key.mjs)
 */
import { stillSignedIn, verifySession, type Session } from './auth';
import { BillingError, checkout, close, donePage, portal, prices, webhook } from './billing';
import { googleToken } from './google';
import { readBody } from './body';
import { BadRequest, cacheScope, callVendor, parseAsk } from './models';
import { refundAnswer, useAnswer } from './quota';
import { accountOf } from './supabase';
import { unlockCheckout, unlockClaim, unlockDone, unlockPrice, unlockRestore } from './unlock';

export interface Env {
  /** Cloudflare account id of an AI Gateway named "juno"; empty to call the vendors directly. */
  AI_GATEWAY_ID: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  /** The prices on offer: Stripe lookup keys, comma-separated, in the order shown. */
  STRIPE_PRICES: string;
  /** "on": Stripe Tax works out and adds sales tax / VAT at checkout. */
  STRIPE_TAX: string;
  /** The unlock's one-time price, by its lookup key, and the key its licenses are signed with; either empty: not on offer (unlock.ts). */
  UNLOCK_PRICE: string;
  UNLOCK_SIGNING_KEY: string;
  /** Google sign-in's desktop client (wrangler.toml) and its secret; empty: the app uses Supabase's sign-in page. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Hosted answers a minute per account (wrangler.toml [[ratelimits]]); absent in tests. */
  ASK_LIMIT?: RateLimit;
}

/** A request body bigger than this is refused (a long chat's screenshots fit easily). */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

const CORS = {
  // Bearer tokens, no cookies: any origin may ask, only a valid token gets answers.
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-max-age': '86400',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      // No session needed: Stripe signs its events; prices and the page back are public.
      if (url.pathname === '/stripe/webhook' && request.method === 'POST') return await webhook(request, env);
      if (url.pathname === '/billing/prices' && request.method === 'GET') return json(await prices(env));
      if (url.pathname === '/billing/done' && request.method === 'GET') return donePage(request);
      if (url.pathname === '/auth/google' && request.method === 'POST') return json(await googleToken(request, env));
      // The unlock is bought without an account: its code is what proves it.
      if (url.pathname === '/unlock' && request.method === 'GET') return json(await unlockPrice(env));
      if (url.pathname === '/unlock/done' && request.method === 'GET') return await unlockDone(request, env);
      if (url.pathname === '/unlock/checkout' && request.method === 'POST') return json(await unlockCheckout(request, env));
      if (url.pathname === '/unlock/claim' && request.method === 'POST') return json(await unlockClaim(request, env));
      if (url.pathname === '/unlock/restore' && request.method === 'POST') return json(await unlockRestore(request, env));

      const session = await verifySession(request, env);
      if (!session) return error(401, 'Sign in again.', 'signed-out');

      if (request.method === 'GET' && url.pathname === '/me') return json(await accountOf(env, session.userId));
      if (request.method === 'POST') {
        if (url.pathname === '/ask') return await ask(request, session, env);
        if (url.pathname.startsWith('/billing/') && !(await stillSignedIn(request, session, env))) return error(401, 'Sign in again.', 'signed-out');
        if (url.pathname === '/billing/checkout') return json(await checkout(request, session, env));
        if (url.pathname === '/billing/portal') return json(await portal(request, session, env));
        if (url.pathname === '/billing/close') return json(await close(session, env));
      }
      return error(404, 'Not found.', 'not-found');
    } catch (err) {
      if (err instanceof BadRequest) return error(err.status, err.message, err.code);
      if (err instanceof BillingError) return error(err.status, err.message, err.code);
      console.error(err);
      return error(500, 'The hosted service had a problem. Try again.', 'server');
    }
  },
} satisfies ExportedHandler<Env>;

async function ask(request: Request, session: Session, env: Env): Promise<Response> {
  if (env.ASK_LIMIT && !(await env.ASK_LIMIT.limit({ key: session.userId })).success) {
    return error(429, "You're asking very quickly. Wait a minute, then try again.", 'rate-limited');
  }
  const raw = await readBody(request, MAX_BODY_BYTES, 'That selection is too large to send. Try a smaller box.');
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // parseAsk says what is wrong.
  }
  const { vendor, model, body } = parseAsk(parsed);

  const use = await useAnswer(session, env);
  if (!use.ok) {
    return use.quota > 0
      ? error(402, `You've used all ${use.quota} hosted answers this month.`, 'quota')
      : error(403, "Your account doesn't include hosted answers.", 'no-plan');
  }

  let upstream: Response;
  try {
    upstream = await callVendor(vendor, model, body, env, await cacheScope(session.userId, body.messages));
  } catch (err) {
    await refundAnswer(session, use.period, env);
    throw err;
  }
  if (!upstream.ok || !upstream.body) {
    await refundAnswer(session, use.period, env);
    // The vendor's error type only: its message can quote what was asked.
    const said = (await upstream.json().catch(() => null)) as { error?: { type?: string } } | null;
    console.error(`vendor ${vendor} ${upstream.status} ${said?.error?.type ?? ''}`);
    if (upstream.status === 429 || upstream.status === 529 || upstream.status === 503) {
      return error(503, 'The hosted service is busy right now. Try again in a minute.', 'overloaded');
    }
    if (upstream.status === 400 || upstream.status === 413) return error(400, 'The AI refused that request. Try a smaller selection.', 'refused');
    return error(502, "The AI didn't answer. Try again.", 'upstream');
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...CORS },
  });
}

/** Errors in OpenAI's shape, which the app already reads. */
function error(status: number, message: string, code: string): Response {
  return json({ error: { message, code } }, status);
}
