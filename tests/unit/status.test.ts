import { describe, expect, it } from 'vitest';
import { keyVault } from '@/lib/providers/byok';
import { checkStatus as check, statusFromAnswer } from '@/lib/status';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/storage';

const keys = (anthropic = '', openai = '') => ({ anthropic, openai });
/** A check with these keys, each request through `f`. */
const checkStatus = (f: typeof fetch, settings: Settings, k: { anthropic: string; openai: string }) => check(f, settings, keyVault(k, f), '');
const byok = (vendor: 'anthropic' | 'openai' = 'anthropic'): Settings => ({ ...DEFAULT_SETTINGS, provider: 'byok', vendor });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('checkStatus', () => {
  it('needs no network with no AI picked or a missing key', async () => {
    const never = (() => {
      throw new Error('no network expected');
    }) as unknown as typeof fetch;
    expect((await checkStatus(never, DEFAULT_SETTINGS, keys())).state).toBe('unset');
    const noKey = await checkStatus(never, byok(), keys());
    expect(noKey).toMatchObject({ state: 'no-key', who: 'Claude', choice: 'anthropic:auto' });
  });

  it('lists the models (free) to prove the key works', async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      return json(200, { data: [] });
    }) as unknown as typeof fetch;
    expect((await checkStatus(f, byok(), keys('sk-ant'))).state).toBe('ok');
    expect(seen[0]).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
  });

  it('says disconnected when the vendor cannot be reached or is down', async () => {
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await checkStatus(offline, byok('openai'), keys('', 'sk-x'))).toMatchObject({
      state: 'disconnected',
      message: "Can't reach OpenAI. Check your internet connection.",
    });
    const down = (async () => json(503, { error: { message: 'unavailable' } })) as unknown as typeof fetch;
    expect((await checkStatus(down, byok(), keys('sk-ant'))).state).toBe('disconnected');
  });

  it('tells a rejected key apart from a connection problem', async () => {
    const f = (async () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })) as unknown as typeof fetch;
    expect(await checkStatus(f, byok(), keys('sk-bad'))).toMatchObject({ state: 'bad-key', message: 'Anthropic rejected your API key.' });
  });

  it('checks a local server by its model list', async () => {
    const local: Settings = { ...DEFAULT_SETTINGS, provider: 'local' };
    const up = (async () => json(200, { data: [] })) as unknown as typeof fetch;
    const down = (async () => {
      throw new TypeError('refused');
    }) as unknown as typeof fetch;
    expect((await checkStatus(up, local, keys())).state).toBe('ok');
    expect(await checkStatus(down, local, keys())).toMatchObject({ state: 'disconnected', who: 'the local model' });
  });
});

describe('statusFromAnswer', () => {
  it('an answer that arrives proves the connection; a network failure disproves it', () => {
    expect(statusFromAnswer(byok(), { ok: true })?.state).toBe('ok');
    expect(statusFromAnswer(byok(), { ok: false, code: 'network', message: 'x' })?.state).toBe('disconnected');
    expect(statusFromAnswer(byok(), { ok: false, code: 'bad-key', message: 'x' })?.state).toBe('bad-key');
  });

  it('a refused request or a rate limit says nothing about the connection', () => {
    expect(statusFromAnswer(byok(), { ok: false, code: 'rate-limit', message: 'x' })).toBeNull();
    expect(statusFromAnswer(byok(), { ok: false, code: 'overloaded', message: 'x' })).toBeNull();
    expect(statusFromAnswer(byok(), { ok: false, code: 'too-large', message: 'x' })).toBeNull();
    expect(statusFromAnswer(DEFAULT_SETTINGS, { ok: true })).toBeNull();
  });
});
