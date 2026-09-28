/**
 * Cloudflare Worker for hosted plans (week 9). It exists only so students who
 * do not want to manage an API key can pay a subscription instead; the
 * bring-your-own-key and local paths never touch it.
 *
 * Routes:
 *   POST /ask            streamed answer, OpenAI-compatible SSE
 *   POST /stripe/webhook subscription state (week 11)
 *   GET  /me             plan and remaining quota
 *
 * Provider keys live as Worker secrets and are never sent to the extension.
 */
import { verifySession, type Session } from './auth';
import { checkAndCount, quotaFor } from './quota';
import { callVendor } from './models';

export interface Env {
  ENVIRONMENT: string;
  AI_GATEWAY_ID: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      if (url.pathname === '/stripe/webhook') {
        const { handleWebhook } = await import('./stripe');
        return await handleWebhook(request, env);
      }

      const session = await verifySession(request, env);
      if (!session) return json({ error: 'Sign in required' }, 401);

      if (url.pathname === '/me') return json(await quotaFor(session, env));
      if (url.pathname === '/ask') return await handleAsk(request, session, env);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleAsk(request: Request, session: Session, env: Env): Promise<Response> {
  const body = (await request.json()) as { model: string; messages: unknown[]; route?: 'small' | 'large' };
  const allowed = await checkAndCount(session, env);
  if (!allowed.ok) return json({ error: allowed.reason }, 429);
  return await callVendor(body, env);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } });
}
