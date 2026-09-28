import { describe, expect, it } from 'vitest';
import { MemoryCacheStore, hashRequest } from '@/lib/cache';
import { callModel, type ProviderContext } from '@/lib/providers';
import { toAnthropicBody } from '@/lib/providers/byok';
import { sseData, toChatMessages } from '@/lib/providers/openai-compat';
import type { AskChunk, AskRequest, Plan } from '@shared/payload';

function plan(): Plan {
  return {
    id: 'p',
    createdAt: 0,
    mode: 'explain',
    question: 'Why?',
    parts: [
      { kind: 'text', text: 'Hello' },
      { kind: 'image', dataUrl: 'data:image/png;base64,AAAA', width: 2, height: 2, reason: 'user' },
    ],
    selection: { kind: 'box', rect: { x: 0, y: 0, width: 1, height: 1 }, devicePixelRatio: 1 },
    page: { url: 'u', title: 't' },
    route: 'large',
    estimatedTokens: 10,
  };
}

function ctx(over: Partial<ProviderContext> = {}): ProviderContext {
  return {
    fetch: globalThis.fetch,
    keys: { anthropic: '', openai: '', session: '' },
    settings: { localBaseUrl: 'http://localhost:11434/v1', localModel: 'm', gatewayUrl: '' },
    cache: new MemoryCacheStore(),
    ...over,
  };
}

async function collect(gen: AsyncIterable<AskChunk>) {
  const chunks: AskChunk[] = [];
  for await (const c of gen) chunks.push(c);
  const text = chunks.filter((c) => c.type === 'delta').map((c) => (c as { text: string }).text).join('');
  const done = chunks.find((c) => c.type === 'done') as Extract<AskChunk, { type: 'done' }> | undefined;
  const error = chunks.find((c) => c.type === 'error') as Extract<AskChunk, { type: 'error' }> | undefined;
  return { text, done, error };
}

function sseResponse(events: string[]): Response {
  const body = events.map((e) => `data: ${e}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('message shape', () => {
  it('builds one OpenAI-compatible user turn with text then images', () => {
    const msgs = toChatMessages({ plan: plan(), history: [{ role: 'user', text: 'earlier' }, { role: 'assistant', text: 'ok' }] });
    expect(msgs[0]?.role).toBe('system');
    expect(msgs).toHaveLength(4);
    const last = msgs[3]!;
    expect(Array.isArray(last.content)).toBe(true);
    const content = last.content as { type: string }[];
    expect(content.map((c) => c.type)).toEqual(['text', 'image_url']);
    expect((content[0] as { text: string }).text).toContain('Question: Why?');
  });

  it('converts to the Anthropic body with system split out and images first', () => {
    const body = toAnthropicBody(toChatMessages({ plan: plan() }), 'claude-sonnet-5');
    expect(body.system).toContain('Read:');
    expect(body.messages).toHaveLength(1);
    const blocks = body.messages[0]!.content as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['image', 'text']);
  });
});

describe('sse parsing', () => {
  it('yields data payloads across chunk boundaries', async () => {
    const out: string[] = [];
    for await (const d of sseData(sseResponse(['{"a":1}', '[DONE]']))) out.push(d);
    expect(out).toEqual(['{"a":1}', '[DONE]']);
  });
});

describe('callModel', () => {
  it('mock streams a placeholder with a Read: line and never records', async () => {
    const c = ctx();
    const { text, done } = await collect(callModel({ plan: plan() }, 'small', c, { provider: 'mock', vendor: 'anthropic' }));
    expect(text.startsWith('Read:')).toBe(true);
    expect(done?.model.vendor).toBe('mock');
    expect((c.cache as MemoryCacheStore).size).toBe(0);
  });

  it('mock replays a recorded answer for the same payload hash', async () => {
    const c = ctx();
    const req: AskRequest = { plan: plan(), model: { vendor: 'mock', model: 'mock-1' } };
    await c.cache.set(await hashRequest(req), { text: 'recorded', model: { vendor: 'anthropic', model: 'x' }, recordedAt: 0 });
    const { text } = await collect(callModel({ plan: plan() }, 'small', c, { provider: 'mock', vendor: 'anthropic' }));
    expect(text).toBe('recorded');
  });

  it('byok without a key yields a no-key error instead of throwing', async () => {
    const { error } = await collect(callModel({ plan: plan() }, 'large', ctx(), { provider: 'byok', vendor: 'anthropic' }));
    expect(error?.code).toBe('no-key');
  });

  it('records paid answers and replays them on the next call', async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls++;
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Read: hi\n\n' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Answer: 4' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        '[DONE]',
      ]);
    }) as unknown as typeof fetch;
    const c = ctx({ fetch: fetchMock, keys: { anthropic: '', openai: 'sk-test', session: '' } });
    const opts = { provider: 'byok' as const, vendor: 'openai' as const };
    const first = await collect(callModel({ plan: plan() }, 'small', c, opts));
    expect(first.text).toBe('Read: hi\n\nAnswer: 4');
    expect(first.done?.cached).toBe(false);
    expect(first.done?.model.model).toBe('gpt-6-luna');
    expect(first.done?.usage?.costUsd).toBeCloseTo((10 * 0.1 + 5 * 0.5) / 1e6);
    const second = await collect(callModel({ plan: plan() }, 'small', c, opts));
    expect(second.text).toBe('Read: hi\n\nAnswer: 4');
    expect(second.done?.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('explicit model override wins over the route table', async () => {
    const fetchMock = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string };
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: body.model } }] }), '[DONE]']);
    }) as unknown as typeof fetch;
    const c = ctx({ fetch: fetchMock, keys: { anthropic: '', openai: 'k', session: '' } });
    const { text } = await collect(
      callModel({ plan: plan() }, 'small', c, { provider: 'byok', vendor: 'openai', model: { vendor: 'openai', model: 'gpt-6-sol' } }),
    );
    expect(text).toBe('gpt-6-sol');
  });
});
