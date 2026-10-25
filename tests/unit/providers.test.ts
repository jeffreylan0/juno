import { describe, expect, it } from 'vitest';
import { MemoryCacheStore, hashRequest } from '@/lib/cache';
import { callModel, type ProviderContext } from '@/lib/providers';
import { keyVault, toAnthropicBody } from '@/lib/providers/byok';
import { sseData, toChatMessages } from '@/lib/providers/openai-compat';
import type { AskChunk, AskRequest, Plan } from '@shared/payload';
import { DEFAULT_PROMPTS } from '@shared/prompts';

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

/** A context whose requests go through `over.fetch`, with these keys. */
function ctx(over: Partial<ProviderContext> = {}, keys = { anthropic: '', openai: '' }): ProviderContext {
  const fetchImpl = over.fetch ?? globalThis.fetch;
  return {
    fetch: fetchImpl,
    vault: keyVault(keys, fetchImpl),
    session: '',
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

/** OpenAI's Responses stream: the text in pieces, then its usage. */
function openAIAnswer(texts: string[], usage = { input_tokens: 0, output_tokens: 0 }): Response {
  return sseResponse([
    ...texts.map((delta) => JSON.stringify({ type: 'response.output_text.delta', delta })),
    JSON.stringify({ type: 'response.completed', response: { usage } }),
  ]);
}

describe('message shape', () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } };
  const shot = { parts: [plan().parts[1]!] };
  const quizPage = { url: 'u', title: 'Task 10 of 13 - Quiz 2.1' };

  it('sends a selection the way a chat app attaches a file: its image first, then the question, and nothing about the page', () => {
    const msgs = toChatMessages({ plan: { ...plan(), page: quizPage } });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(msgs[1]!.content).toEqual([image, { type: 'text', text: 'Selected text:\n\nHello' }, { type: 'text', text: 'Why?' }]);
    // A window titled "Quiz" made models turn students down; it, and the URL, stay on this computer.
    expect(JSON.stringify(msgs)).not.toContain('Quiz 2.1');
    expect(JSON.stringify(msgs[1])).not.toContain('"u"');
  });

  it('asks the default question when the box was empty, and "Go on." for an empty follow-up', () => {
    const opening = toChatMessages({ plan: { ...plan(), mode: 'check', question: '' }, attachments: [shot] });
    expect((opening[1]!.content as { text?: string }[]).at(-1)!.text).toBe(DEFAULT_PROMPTS.check);
    const followUp = toChatMessages({
      plan: { ...plan(), question: ' ' },
      attachments: [],
      history: [
        { role: 'user', text: 'Explain', attachments: [shot] },
        { role: 'assistant', text: 'It is…' },
      ],
    });
    expect(followUp.at(-1)!.content).toBe('Go on.');
  });

  it('a follow-up is the question alone, after the whole conversation, screenshots included; answers go back without their Read: line', () => {
    const msgs = toChatMessages({
      plan: { ...plan(), question: 'And the units?' },
      attachments: [],
      history: [
        { role: 'user', text: 'Explain this', attachments: [shot] },
        { role: 'assistant', text: 'Read: a force diagram.\n\nIt shows…' },
      ],
    });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[1]!.content).toEqual([image, { type: 'text', text: 'Explain this' }]);
    expect(msgs[2]!.content).toBe('It shows…');
    expect(msgs[3]!.content).toBe('And the units?');
    // Only one copy of the image is ever sent.
    const images = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'image_url');
    expect(images).toHaveLength(1);
  });

  it('keeps roles alternating in the Anthropic body for a multi-turn conversation', () => {
    const body = toAnthropicBody(
      toChatMessages({
        plan: { ...plan(), question: 'Next?' },
        attachments: [],
        history: [
          { role: 'user', text: 'Q1', attachments: [shot] },
          { role: 'assistant', text: 'A1' },
          { role: 'user', text: 'Q2' },
          { role: 'assistant', text: 'A2' },
        ],
      }),
      'claude-sonnet-5',
    );
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(body.system).toContain('never remark on whether a message comes with a selection');
  });

  it('converts to the Anthropic body with system split out and images first', () => {
    const body = toAnthropicBody(toChatMessages({ plan: plan() }), 'claude-sonnet-5');
    expect(body.system).toContain('Read:');
    expect(body.messages).toHaveLength(1);
    const blocks = body.messages[0]!.content as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['image', 'text', 'text']);
  });
});

describe('chats with selections from several pages', () => {
  const shot = (n: number) => ({ kind: 'image' as const, dataUrl: `data:image/png;base64,${'A'.repeat(n)}`, width: 2, height: 2, reason: 'user' as const });
  const textbook = { parts: [shot(4)] };
  // As stored by an earlier version, which also read text off the page.
  const paper = { parts: [{ kind: 'text' as const, text: 'F = ma' }] };

  it('sends every new selection with the question, each labelled, images before the question', () => {
    const msgs = toChatMessages({ plan: { ...plan(), question: 'Compare these.' }, attachments: [textbook, paper], history: [] });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(msgs[1]!.content).toEqual([
      { type: 'text', text: 'Selection 1:' },
      { type: 'image_url', image_url: { url: shot(4).dataUrl, detail: 'high' } },
      { type: 'text', text: 'Selection 2:' },
      { type: 'text', text: 'Selected text:\n\nF = ma' },
      { type: 'text', text: 'Compare these.' },
    ]);
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
    expect((msgs[1]!.content as { type: string }[]).map((c) => c.type)).toEqual(['image_url', 'text']);
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
      return openAIAnswer(['Read: hi\n\n', 'Answer: 4'], { input_tokens: 10, output_tokens: 5 });
    }) as unknown as typeof fetch;
    const c = ctx({ fetch: fetchMock }, { anthropic: '', openai: 'sk-test' });
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

  it('records nothing without a cache (the app) or for a temporary chat', async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls++;
      return openAIAnswer(['Answer: 4']);
    }) as unknown as typeof fetch;
    const opts = { provider: 'byok' as const, vendor: 'openai' as const };
    const keys = { anthropic: '', openai: 'sk-test' };

    const bare = ctx({ fetch: fetchMock, cache: undefined }, keys);
    await collect(callModel({ plan: plan() }, 'small', bare, opts));
    await collect(callModel({ plan: plan() }, 'small', bare, opts));
    expect(calls).toBe(2);

    const ghost = ctx({ fetch: fetchMock, ephemeral: true }, keys);
    await collect(callModel({ plan: plan() }, 'small', ghost, opts));
    expect((ghost.cache as MemoryCacheStore).size).toBe(0);
  });

  it('explicit model override wins over the route table', async () => {
    const fetchMock = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string };
      return openAIAnswer([body.model]);
    }) as unknown as typeof fetch;
    const c = ctx({ fetch: fetchMock }, { anthropic: '', openai: 'k' });
    const { text } = await collect(
      callModel({ plan: plan() }, 'small', c, { provider: 'byok', vendor: 'openai', model: { vendor: 'openai', model: 'gpt-6-sol' } }),
    );
    expect(text).toBe('gpt-6-sol');
  });
});
