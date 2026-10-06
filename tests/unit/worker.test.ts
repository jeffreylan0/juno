// @vitest-environment node
/**
 * The hosted-answer Worker's own logic: who is asking (a Supabase token
 * checked against the project's published keys), which models it may use,
 * and Anthropic's stream re-emitted in the OpenAI shape the extension reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifySession } from '../../worker/src/auth';
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
