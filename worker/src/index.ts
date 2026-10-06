/**
 * Cloudflare Worker for hosted answers: signed-in students on a plan ask
 * through here, with the service's own AI keys, instead of bringing a key.
 * Bring-your-own-key, local models and cloud storage never touch it (cloud
 * storage talks to Supabase directly, under row level security).
 *
 * Routes:
 *   GET  /me              plan, cloud storage, and hosted answers used this month
 *   POST /ask             a streamed answer (OpenAI-compatible SSE), counted against the plan
 *   POST /stripe/webhook  subscription changes from Stripe (stripe.ts)
 *
 * Secrets (`wrangler secret put …`, never committed):
 *   SUPABASE_URL          https://<project>.supabase.co
 *   SUPABASE_SECRET_KEY   the project's secret key (sb_secret_…); bypasses row level security
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY
 *   STRIPE_WEBHOOK_SECRET (once billing exists)
 */
import { verifySession, type Session } from './auth';
import { BadRequest, callVendor, parseAsk } from './models';
import { me, refundAnswer, useAnswer } from './quota';

export interface Env {
  ENVIRONMENT: string;
  /** Cloudflare account id of an AI Gateway named "selection-ai"; empty to call the vendors directly. */
  AI_GATEWAY_ID: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

/** A request body bigger than this is refused (a few screenshots fit easily). */
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
      if (url.pathname === '/stripe/webhook' && request.method === 'POST') {
        const { handleWebhook } = await import('./stripe');
        return await handleWebhook(request, env);
      }

      const session = await verifySession(request, env);
      if (!session) return error(401, 'Sign in again.', 'signed-out');

      if (url.pathname === '/me' && request.method === 'GET') return json(await me(session, env));
      if (url.pathname === '/ask' && request.method === 'POST') return await ask(request, session, env);
      return error(404, 'Not found.', 'not-found');
    } catch (err) {
      if (err instanceof BadRequest) return error(400, err.message, 'bad-request');
      console.error(err);
      return error(500, 'The hosted service had a problem. Try again.', 'server');
    }
  },
} satisfies ExportedHandler<Env>;

async function ask(request: Request, session: Session, env: Env): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return error(413, 'That selection is too large to send. Try a smaller box.', 'too-large');
  }
  const { vendor, model, body } = parseAsk(await request.json().catch(() => null));

  const use = await useAnswer(session, env);
  if (!use.ok) {
    return use.quota > 0
      ? error(402, `You've used all ${use.quota} hosted answers this month.`, 'quota')
      : error(403, "Your account doesn't include hosted answers.", 'no-plan');
  }

  const upstream = await callVendor(vendor, model, body, env);
  if (!upstream.ok || !upstream.body) {
    await refundAnswer(session, use.period, env);
    const text = await upstream.text().catch(() => '');
    console.error(`vendor ${vendor} ${upstream.status}: ${text.slice(0, 300)}`);
    if (upstream.status === 429 || upstream.status === 529 || upstream.status === 503) {
      return error(503, 'The hosted service is busy right now. Try again in a minute.', 'overloaded');
    }
    if (upstream.status === 400 || upstream.status === 413) return error(400, 'The AI refused that request. Try a smaller selection.', 'refused');
    return error(502, "The AI didn't answer. Try again.", 'upstream');
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-answers-left': String(use.quota - use.used) },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
}

/** Errors in OpenAI's shape, which the extension already reads. */
function error(status: number, message: string, code: string): Response {
  return json({ error: { message, code } }, status);
}
