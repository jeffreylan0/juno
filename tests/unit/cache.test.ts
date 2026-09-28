import { describe, expect, it } from 'vitest';
import { MemoryCacheStore, hashRequest, sha256Hex } from '@/lib/cache';
import type { AskRequest, Plan } from '@shared/payload';

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'p1',
    createdAt: 1,
    mode: 'explain',
    parts: [{ kind: 'text', text: 'What is 2+2?' }],
    selection: { kind: 'text', rect: { x: 0, y: 0, width: 10, height: 10 }, devicePixelRatio: 2 },
    page: { url: 'https://example.com', title: 'x' },
    route: 'small',
    estimatedTokens: 50,
    ...over,
  };
}

describe('cache hashing', () => {
  it('sha256 matches a known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('is stable across ids, timestamps, rects and key order', async () => {
    const a: AskRequest = { plan: plan() };
    const b: AskRequest = { plan: plan({ id: 'other', createdAt: 999, selection: { kind: 'box', rect: { x: 5, y: 5, width: 1, height: 1 }, devicePixelRatio: 1 } }) };
    expect(await hashRequest(a)).toBe(await hashRequest(b));
  });

  it('changes when content, mode, question, history or model change', async () => {
    const base = await hashRequest({ plan: plan() });
    expect(await hashRequest({ plan: plan({ parts: [{ kind: 'text', text: 'What is 2+3?' }] }) })).not.toBe(base);
    expect(await hashRequest({ plan: plan({ mode: 'hint' }) })).not.toBe(base);
    expect(await hashRequest({ plan: plan({ question: 'why' }) })).not.toBe(base);
    expect(await hashRequest({ plan: plan(), history: [{ role: 'user', text: 'hi' }] })).not.toBe(base);
    expect(await hashRequest({ plan: plan(), model: { vendor: 'openai', model: 'gpt-6-luna' } })).not.toBe(base);
  });

  it('memory store round-trips', async () => {
    const store = new MemoryCacheStore();
    await store.set('h', { text: 'hello', model: { vendor: 'mock', model: 'm' }, recordedAt: 0 });
    expect((await store.get('h'))?.text).toBe('hello');
    expect(await store.get('missing')).toBeUndefined();
  });
});
