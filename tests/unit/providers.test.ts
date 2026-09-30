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
  it('attaches the selection once, to the opening user turn', () => {
    const msgs = toChatMessages({ plan: plan() });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    const content = msgs[1]!.content as { type: string; text?: string }[];
    expect(content.map((c) => c.type)).toEqual(['text', 'image_url']);
    expect(content[0]!.text).toContain('Selected content:');
    expect(content[0]!.text).toContain('Question: Why?');
  });

  it('sends a follow-up as text after the history, with the selection still in the first turn', () => {
    const msgs = toChatMessages({
      plan: { ...plan(), question: 'And the units?' },
      history: [
        { role: 'user', text: 'Explain this' },
        { role: 'assistant', text: 'Read: a force diagram. It shows…' },
      ],
    });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    const opening = msgs[1]!.content as { type: string; text?: string }[];
    expect(opening.map((c) => c.type)).toEqual(['text', 'image_url']);
    // The opening turn carries the student's original question, not the follow-up.
    expect(opening[0]!.text).toContain('Question: Explain this');
    expect(msgs[2]!.content).toBe('Read: a force diagram. It shows…');
    expect(msgs[3]!.content).toBe('And the units?');
    // Only one copy of the image is ever sent.
    const images = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'image_url');
    expect(images).toHaveLength(1);
  });

  it('keeps roles alternating in the Anthropic body for a multi-turn conversation', () => {
    const body = toAnthropicBody(
      toChatMessages({
        plan: { ...plan(), question: 'Next?' },
        history: [
          { role: 'user', text: 'Q1' },
          { role: 'assistant', text: 'A1' },
          { role: 'user', text: 'Q2' },
          { role: 'assistant', text: 'A2' },
        ],
      }),
      'claude-sonnet-5',
    );
    const roles = body.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(body.system).toContain('no new selection');
  });

  it('converts to the Anthropic body with system split out and images first', () => {
    const body = toAnthropicBody(toChatMessages({ plan: plan() }), 'claude-sonnet-5');
    expect(body.system).toContain('Read:');
    expect(body.messages).toHaveLength(1);
    const blocks = body.messages[0]!.content as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['image', 'text']);
  });
});

describe('chats with selections from several pages', () => {
  const shot = (n: number) => ({ kind: 'image' as const, dataUrl: `data:image/png;base64,${'A'.repeat(n)}`, width: 2, height: 2, reason: 'user' as const });
  const textbook = { kind: 'box' as const, page: { url: 'https://a.test/', title: 'Textbook' }, parts: [shot(4)] };
  const paper = { kind: 'text' as const, page: { url: 'https://b.test/', title: 'Paper' }, parts: [{ kind: 'text' as const, text: 'F = ma' }] };

  it('sends every new selection with the question, each named by its page', () => {
    const msgs = toChatMessages({ plan: { ...plan(), question: 'Compare these.' }, attachments: [textbook, paper], history: [] });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    const content = msgs[1]!.content as { type: string; text?: string }[];
    expect(content.map((c) => c.type)).toEqual(['text', 'image_url']);
    expect(content[0]!.text).toContain('The student selected 2 things');
    expect(content[0]!.text).toContain('from "Textbook"');
    expect(content[0]!.text).toContain('from "Paper"');
    expect(content[0]!.text).toContain('F = ma');
    expect(content[0]!.text).toContain('Question: Compare these.');
  });

  it('keeps each earlier selection with the question that carried it, and a follow-up with none is plain text', () => {
    const msgs = toChatMessages({
      plan: { ...plan(), question: 'And now?' },
      attachments: [],
      history: [
        { role: 'user', text: 'Explain', attachments: [textbook] },
        { role: 'assistant', text: 'Read: a box. It shows…' },
        { role: 'user', text: 'What about this?', attachments: [paper] },
        { role: 'assistant', text: 'Read: F = ma. …' },
      ],
    });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect((msgs[1]!.content as { type: string }[]).map((c) => c.type)).toEqual(['text', 'image_url']);
    expect((msgs[3]!.content as { type: string; text?: string }[])[0]!.text).toContain('F = ma');
    expect(msgs[5]!.content).toBe('And now?');
    const images = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'image_url');
    expect(images).toHaveLength(1);
    // Anthropic still gets strictly alternating roles.
    expect(toAnthropicBody(msgs, 'claude-sonnet-5-5').messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('hashes differently when the selections differ, so a replay never answers the wrong ones', async () => {
    const base = { plan: plan(), history: [] };
    const one = await hashRequest({ ...base, attachments: [textbook] });
    const two = await hashRequest({ ...base, attachments: [textbook, paper] });
    expect(one).not.toBe(two);
    // A request without attachments hashes as it always did (recorded evals stay valid).
    expect(await hashRequest({ plan: plan() })).toBe(await hashRequest({ plan: plan() }));
  });

  it('the mock answer counts the new selections and the earlier ones', async () => {
    const { text } = await collect(
      callModel(
        {
          plan: { ...plan(), question: 'More?' },
          attachments: [paper],
          history: [
            { role: 'user', text: 'Explain', attachments: [textbook] },
            { role: 'assistant', text: 'A' },
          ],
        },
        'large',
        ctx(),
        { provider: 'mock', vendor: 'anthropic' },
      ),
    );
    expect(text).toContain('Read: 1 part(s)');
    expect(text).toContain('plus 1 earlier selection(s)');
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
    await c.cache!.set(await hashRequest(req), { text: 'recorded', model: { vendor: 'anthropic', model: 'x' }, recordedAt: 0 });
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

  it('records nothing without a cache (the extension) or for a temporary chat', async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls++;
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'Answer: 4' } }] }), '[DONE]']);
    }) as unknown as typeof fetch;
    const opts = { provider: 'byok' as const, vendor: 'openai' as const };
    const keys = { anthropic: '', openai: 'sk-test', session: '' };

    const bare = ctx({ fetch: fetchMock, keys, cache: undefined });
    await collect(callModel({ plan: plan() }, 'small', bare, opts));
    await collect(callModel({ plan: plan() }, 'small', bare, opts));
    expect(calls).toBe(2);

    const ghost = ctx({ fetch: fetchMock, keys, ephemeral: true });
    await collect(callModel({ plan: plan() }, 'small', ghost, opts));
    expect((ghost.cache as MemoryCacheStore).size).toBe(0);
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
