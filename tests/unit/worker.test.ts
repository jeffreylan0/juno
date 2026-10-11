// @vitest-environment node
/**
 * The Worker's own logic: who is asking (a Supabase token checked against
 * the project's published keys), which models it may use, Anthropic's stream
 * re-emitted in the OpenAI shape the extension reads, and billing (Stripe's
 * events mirrored into the database, checkout, what is on offer).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifySession } from '../../worker/src/auth';
import { checkout, form, prices, webhook } from '../../worker/src/billing';
import { anthropicToOpenAI, parseAsk, toAnthropic } from '../../worker/src/models';
import type { Env } from '../../worker/src/index';

const SUPABASE_URL = 'https://proj.supabase.co';
const env = { SUPABASE_URL, SUPABASE_SECRET_KEY: 'sb_secret_x' } as Env;

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === 'string' ? new TextEncoder().encode(b) : b)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function signer() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'ES256' };
  const sign = async (claims: Record<string, unknown>, kid = 'k1') => {
    const head = b64url(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  };
  return { jwk, sign };
}

const good = (over: Record<string, unknown> = {}) => ({
  sub: 'user-1',
  email: 'a@example.com',
  exp: Math.floor(Date.now() / 1000) + 600,
  iss: `${SUPABASE_URL}/auth/v1`,
  aud: 'authenticated',
  role: 'authenticated',
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('who is asking', () => {
  it('accepts a token signed with the project’s published key, and nothing else', async () => {
    const { jwk, sign } = await signer();
    const other = await signer();
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toBe(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
      return new Response(JSON.stringify({ keys: [jwk] }));
    });
    const ask = (token: string) => verifySession(new Request('https://w/ask', { headers: { authorization: `Bearer ${token}` } }), env);

    expect(await ask(await sign(good()))).toEqual({ userId: 'user-1', email: 'a@example.com' });
    expect(await ask(await other.sign(good()))).toBeNull(); // someone else's key
    expect(await ask(await sign(good({ exp: 1 })))).toBeNull(); // expired
    expect(await ask(await sign(good({ iss: 'https://evil.supabase.co/auth/v1' })))).toBeNull();
    expect(await ask(await sign(good({ role: 'anon', aud: 'authenticated' })))).toBeNull(); // the publishable key's own token
    expect(await ask('not.a.token')).toBeNull();
  });

  it('asks Supabase about a token signed with the legacy shared secret', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
      return new Response(JSON.stringify({ id: 'user-2', email: 'b@example.com' }));
    });
    const token = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(good()))}.sig`;
    const s = await verifySession(new Request('https://w/me', { headers: { authorization: `Bearer ${token}` } }), env);
    expect(s).toEqual({ userId: 'user-2', email: 'b@example.com' });
    expect(calls).toEqual([`${SUPABASE_URL}/auth/v1/user`]);
  });
});

describe('what may be asked', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  it('allows the everyday models and refuses the rest before anything is spent', () => {
    expect(parseAsk({ model: 'anthropic/claude-sonnet-5-5', messages }).model).toBe('claude-sonnet-5-5');
    expect(parseAsk({ model: 'openai/gpt-6-luna', messages }).vendor).toBe('openai');
    expect(() => parseAsk({ model: 'anthropic/claude-opus-5-5', messages })).toThrow("can't use");
    expect(() => parseAsk({ model: 'mistral/large', messages })).toThrow("can't use");
    expect(() => parseAsk({ model: 'anthropic/claude-haiku-4-5', messages: [] })).toThrow();
  });
});

describe('Anthropic, in the OpenAI shape', () => {
  it('moves the system prompt out, turns images into base64 blocks and caches the last turn', () => {
    const { system, messages } = toAnthropic([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
    ]);
    expect(system).toBe('Be brief.');
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' }, cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
  });

  it('re-emits text deltas, then usage, then [DONE]', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      { type: 'message_delta', usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    // Split mid-event, as the network does.
    const bytes = new TextEncoder().encode(sse);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 37));
        c.enqueue(bytes.slice(37));
        c.close();
      },
    });
    const out = await new Response(body.pipeThrough(anthropicToOpenAI())).text();
    const datas = out.split('\n\n').filter(Boolean).map((l) => l.slice(6));
    expect(datas.at(-1)).toBe('[DONE]');
    const chunks = datas.slice(0, -1).map((d) => JSON.parse(d));
    expect(chunks.flatMap((c) => c.choices.map((x: { delta: { content: string } }) => x.delta.content)).join('')).toBe('Hello');
    expect(chunks.at(-1).usage).toEqual({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 90 } });
  });
});

// ── Billing ──────────────────────────────────────────────────────────────

const billingEnv = (over: Partial<Env> = {}) =>
  ({ ...env, STRIPE_SECRET_KEY: 'rk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_PRICES: '', STRIPE_TAX: '', ...over }) as Env;

/** A stand-in for Stripe and the project's REST API, recording every call. */
function fakeServices(routes: Record<string, (body: string, url: URL) => unknown>) {
  const calls: { method: string; url: URL; body: string }[] = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ method, url, body });
    const key = `${method} ${url.host === 'api.stripe.com' ? 'stripe' : 'db'}${url.pathname}`;
    const route = Object.entries(routes).find(([k]) => key.startsWith(k));
    if (!route) return new Response(JSON.stringify([]), { status: 200 });
    return new Response(JSON.stringify(route[1](body, url) ?? null), { status: 200 });
  });
  return calls;
}

async function signed(event: unknown, secret = 'whsec_x') {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`))).toString('hex');
  return new Request('https://w/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': `t=${t},v1=${mac}` } });
}

const saved = (calls: { method: string; url: URL; body: string }[], table: string) =>
  calls.filter((c) => c.method === 'POST' && c.url.pathname === `/rest/v1/${table}`).map((c) => JSON.parse(c.body));

describe('billing', () => {
  it('encodes parameters the way Stripe reads them', () => {
    expect(decodeURIComponent(form({ mode: 'payment', line_items: [{ price: 'p_1', quantity: 1 }], expand: ['data.product'], none: undefined, meta: { a: 'b c' } }))).toBe(
      'mode=payment&line_items[0][price]=p_1&line_items[0][quantity]=1&expand[0]=data.product&meta[a]=b c',
    );
  });

  it('turns away an event Stripe did not sign', async () => {
    fakeServices({});
    const bad = await signed({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } }, 'whsec_other');
    expect((await webhook(bad, billingEnv())).status).toBe(400);
  });

  it('a finished checkout links the customer and saves the subscription as Stripe has it now', async () => {
    const calls = fakeServices({
      'GET stripe/v1/subscriptions/sub_1': () => ({
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: false,
        cancel_at: null,
        metadata: {},
        items: { data: [{ current_period_end: 1_900_000_000, price: { id: 'price_1', lookup_key: 'plus_monthly', metadata: { plan: 'plus' } } }] },
      }),
    });
    const req = await signed({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', mode: 'subscription', customer: 'cus_1', client_reference_id: 'user-1', subscription: 'sub_1', metadata: {} } },
    });
    expect((await webhook(req, billingEnv())).status).toBe(200);
    expect(saved(calls, 'customers')).toEqual([{ user_id: 'user-1', stripe_customer: 'cus_1' }]);
    expect(saved(calls, 'subscriptions')).toEqual([
      expect.objectContaining({
        id: 'sub_1',
        user_id: 'user-1',
        plan: 'plus',
        kind: 'subscription',
        status: 'active',
        price: 'plus_monthly',
        period_end: new Date(1_900_000_000_000).toISOString(),
        cancel_at_period_end: false,
      }),
    ]);
  });

  it('a subscription event finds its account by the customer, and reads the newest state back', async () => {
    const calls = fakeServices({
      'GET stripe/v1/subscriptions/sub_1': () => ({
        id: 'sub_1',
        customer: 'cus_1',
        status: 'canceled',
        cancel_at_period_end: false,
        cancel_at: null,
        current_period_end: 1_800_000_000,
        metadata: {},
        items: { data: [{ price: { id: 'price_1', lookup_key: null, metadata: {} } }] },
      }),
      'GET db/rest/v1/customers': () => [{ user_id: 'user-9' }],
    });
    // The event's own copy says active: what Stripe says now wins.
    await webhook(await signed({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active' } } }), billingEnv());
    expect(saved(calls, 'subscriptions')).toEqual([expect.objectContaining({ user_id: 'user-9', status: 'canceled', price: 'price_1', period_end: new Date(1_800_000_000_000).toISOString() })]);
  });

  it('a paid pass runs pass_days from the purchase, and a full refund ends it', async () => {
    const calls = fakeServices({});
    const created = 1_700_000_000;
    await webhook(
      await signed({
        type: 'checkout.session.completed',
        data: {
          object: { id: 'cs_2', mode: 'payment', created, customer: 'cus_2', client_reference_id: 'user-2', payment_intent: 'pi_2', payment_status: 'paid', metadata: { plan: 'plus', pass_days: '120', price: 'plus_semester' } },
        },
      }),
      billingEnv(),
    );
    expect(saved(calls, 'subscriptions')).toEqual([
      expect.objectContaining({ id: 'cs_2', kind: 'pass', status: 'paid', price: 'plus_semester', payment: 'pi_2', period_end: new Date((created + 120 * 86_400) * 1000).toISOString() }),
    ]);
    await webhook(await signed({ type: 'charge.refunded', data: { object: { refunded: true, payment_intent: 'pi_2' } } }), billingEnv());
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url.search).toBe('?kind=eq.pass&payment=eq.pi_2');
    expect(JSON.parse(patch.body)).toMatchObject({ status: 'refunded' });
  });

  it('offers the lookup keys in order, with what each plan gives', async () => {
    fakeServices({
      'GET stripe/v1/prices': () => ({
        data: [
          { id: 'p_y', lookup_key: 'k_yearly', unit_amount: 5999, currency: 'usd', type: 'recurring', recurring: { interval: 'year', interval_count: 1 }, metadata: {}, product: { name: 'Plus', metadata: { plan: 'plus' } } },
          { id: 'p_s', lookup_key: 'k_semester', unit_amount: 2499, currency: 'usd', type: 'one_time', recurring: null, metadata: { pass_days: '120' }, product: { name: 'Plus', metadata: {} } },
          { id: 'p_m', lookup_key: 'k_monthly', unit_amount: 799, currency: 'usd', type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, metadata: { plan: 'nope' }, product: { name: 'Plus', metadata: {} } },
        ],
      }),
      'GET db/rest/v1/plans': () => [{ id: 'plus', name: 'Plus', monthly_questions: 600, cloud: true }],
    });
    const list = await prices(billingEnv({ STRIPE_PRICES: 'k_monthly, k_yearly,k_semester' }));
    // k_monthly names a plan that does not exist: left out rather than sold.
    expect(list.map((o) => [o.key, o.amount, o.interval, o.passDays, o.plan.monthly_questions])).toEqual([
      ['k_yearly', 5999, 'year', null, 600],
      ['k_semester', 2499, null, 120, 600],
    ]);
    expect(await prices(billingEnv({ STRIPE_SECRET_KEY: '' }))).toEqual([]);
  });

  it('checks out a subscription for the signed-in account, once', async () => {
    let active = false;
    const calls = fakeServices({
      'GET stripe/v1/prices': () => ({
        data: [{ id: 'p_m', lookup_key: 'c_monthly', unit_amount: 799, currency: 'usd', type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, metadata: {}, product: { name: 'Plus', metadata: {} } }],
      }),
      'GET db/rest/v1/plans': () => [{ id: 'plus', name: 'Plus', monthly_questions: 600, cloud: true }],
      'POST db/rest/v1/rpc/account_of': () => ({ plan: active ? 'plus' : 'free', plan_name: active ? 'Plus' : 'Free', billing: active ? { active: true } : null }),
      'GET db/rest/v1/customers': () => [{ stripe_customer: 'cus_1' }],
      'POST stripe/v1/checkout/sessions': () => ({ url: 'https://checkout.stripe.com/c/pay/cs_1' }),
    });
    const session = { userId: 'user-1', email: 'a@example.com' };
    const e = billingEnv({ STRIPE_PRICES: 'c_monthly' });
    const buy = (price: string) => checkout(new Request('https://w.example/billing/checkout', { method: 'POST', body: JSON.stringify({ price }) }), session, e);

    expect(await buy('c_monthly')).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    const sent = new URLSearchParams(calls.find((c) => c.url.pathname === '/v1/checkout/sessions')!.body);
    expect(Object.fromEntries(sent)).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      client_reference_id: 'user-1',
      'line_items[0][price]': 'p_m',
      success_url: 'https://w.example/billing/done?result=paid',
      'subscription_data[metadata][user_id]': 'user-1',
      'subscription_data[metadata][plan]': 'plus',
    });
    await expect(buy('not_offered')).rejects.toMatchObject({ status: 404 });
    active = true;
    await expect(buy('c_monthly')).rejects.toMatchObject({ status: 409 });
  });
});
