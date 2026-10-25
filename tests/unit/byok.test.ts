/**
 * Real-AI answers with the student's own key: request shape, prompt caching,
 * streaming usage, and — most of all — errors a student can act on.
 */
import { describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '@/lib/cache';
import { callModel, type ProviderContext } from '@/lib/providers';
import { keyVault, testKey, toAnthropicBody, ANTHROPIC_URL, OPENAI_URL } from '@/lib/providers/byok';
import { describeHttpError, isTransient, needsSettings } from '@/lib/providers/errors';
import { toChatMessages } from '@/lib/providers/openai-compat';
import type { AskChunk, Plan } from '@shared/payload';

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'p',
    createdAt: 0,
    mode: 'ask',
    question: 'Explain this step by step.',
    parts: [{ kind: 'image', dataUrl: 'data:image/png;base64,AAAA', width: 2, height: 2, reason: 'user' }],
    selection: { kind: 'box', rect: { x: 0, y: 0, width: 1, height: 1 }, devicePixelRatio: 1 },
    page: { url: 'u', title: 't' },
    route: 'large',
    estimatedTokens: 10,
    ...over,
  };
}

function sse(events: { event?: string; data: unknown }[]): Response {
  const body = events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

interface Call {
  url: string;
  init: RequestInit;
}

function ctx(respond: (call: Call) => Response | Promise<Response>, calls: Call[] = [], keys = { anthropic: 'sk-ant-test', openai: 'sk-test' }): ProviderContext {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return {
    fetch: fetchImpl,
    vault: keyVault(keys, fetchImpl),
    session: '',
    settings: { localBaseUrl: '', localModel: '', gatewayUrl: '' },
    cache: new MemoryCacheStore(),
  };
}

async function collect(gen: AsyncIterable<AskChunk>) {
  const chunks: AskChunk[] = [];
  for await (const c of gen) chunks.push(c);
  return {
    text: chunks.filter((c) => c.type === 'delta').map((c) => (c as { text: string }).text).join(''),
    done: chunks.find((c) => c.type === 'done') as Extract<AskChunk, { type: 'done' }> | undefined,
    error: chunks.find((c) => c.type === 'error') as Extract<AskChunk, { type: 'error' }> | undefined,
  };
}

const anthropicStream = (text: string, usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }) =>
  sse([
    { event: 'message_start', data: { type: 'message_start', message: { usage: { ...usage, output_tokens: 1 } } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
    { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 30 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

describe('Anthropic requests', () => {
  it('sends only the headers Anthropic documents, the current large model for screenshots, room to think, and a fallback', async () => {
    const calls: Call[] = [];
    const c = ctx(() => anthropicStream('Read: a box\n\nAnswer: 4'), calls);
    const { text, done } = await collect(callModel({ plan: plan() }, 'large', c, { provider: 'byok', vendor: 'anthropic' }));
    expect(text).toContain('Answer: 4');
    expect(calls[0]!.url).toBe(ANTHROPIC_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    // No browser-access header: no page sends it (the native core does: vault.rs).
    expect(Object.keys(headers).sort()).toEqual(['anthropic-beta', 'anthropic-version', 'content-type', 'x-api-key']);
    expect(headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; max_tokens: number; fallbacks?: string };
    expect(body.model).toBe('claude-sonnet-5-5');
    // Thinking counts toward it: 4,096 cut hard answers off, or left none.
    expect(body.max_tokens).toBe(32_000);
    expect(body.fallbacks).toBe('default');
    expect(done?.model).toEqual({ vendor: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('marks the last user message for prompt caching, so follow-ups reuse the screenshot', () => {
    const opening = toAnthropicBody(toChatMessages({ plan: plan() }), 'claude-sonnet-5-5');
    const first = opening.messages[0]!.content as { type: string; cache_control?: unknown }[];
    expect(first.map((b) => b.type)).toEqual(['image', 'text']);
    expect(first[1]!.cache_control).toEqual({ type: 'ephemeral' });

    const followUp = toAnthropicBody(
      toChatMessages({
        plan: plan({ question: 'Why?' }),
        attachments: [],
        history: [
          { role: 'user', text: 'Explain this step by step.', attachments: [{ parts: plan().parts }] },
          { role: 'assistant', text: 'Read: …\n\nIt is…' },
        ],
      }),
      'claude-sonnet-5-5',
    );
    const last = followUp.messages[followUp.messages.length - 1]!.content as { text: string; cache_control?: unknown }[];
    expect(last).toEqual([{ type: 'text', text: 'Why?', cache_control: { type: 'ephemeral' } }]);
    // Exactly one breakpoint per request; the vendor allows four.
    expect(JSON.stringify(followUp).match(/cache_control/g)).toHaveLength(1);
  });

  it('counts cached input and prices it at the cache rate', async () => {
    const c = ctx(() => anthropicStream('ok', { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 }));
    const { done } = await collect(callModel({ plan: plan() }, 'large', c, { provider: 'byok', vendor: 'anthropic' }));
    expect(done?.usage?.inputTokens).toBe(1010);
    // 10 plain at $2/M, 1000 cached at a tenth of that, 30 out at $10/M.
    expect(done?.usage?.costUsd).toBeCloseTo((10 * 2 + 1000 * 0.2 + 30 * 10) / 1e6);
  });

  it('turns a mid-stream overload into a retryable error', async () => {
    const c = ctx(() =>
      sse([
        { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 5 } } } },
        { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
      ]),
    );
    const { error } = await collect(callModel({ plan: plan() }, 'large', c, { provider: 'byok', vendor: 'anthropic' }));
    expect(error?.code).toBe('overloaded');
    expect(isTransient(error?.code)).toBe(true);
  });

  it('reads the answer after the thinking, which streams first (and empty)', async () => {
    const c = ctx(() =>
      sse([
        { data: { type: 'message_start', message: { usage: { input_tokens: 5 } } } },
        { data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
        { data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } } },
        { data: { type: 'content_block_stop', index: 0 } },
        { data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
        { data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer: 4' } } },
        { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 900 } } },
        { data: { type: 'message_stop' } },
      ]),
    );
    const { text, error, done } = await collect(callModel({ plan: plan() }, 'large', c, { provider: 'byok', vendor: 'anthropic' }));
    expect(error).toBeUndefined();
    expect(text).toBe('Answer: 4');
    expect(done?.usage?.outputTokens).toBe(900);
  });

  const stopping = (stop: string, text?: string, category?: string) =>
    sse([
      { data: { type: 'message_start', message: { usage: { input_tokens: 5 } } } },
      ...(text ? [{ data: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }] : []),
      { data: { type: 'message_delta', delta: { stop_reason: stop, stop_details: category ? { type: 'refusal', category } : null }, usage: { output_tokens: 9 } } },
      { data: { type: 'message_stop' } },
    ]);

  it('says a safeguard declined, in words, instead of "an empty answer"', async () => {
    const c = ctx(() => stopping('refusal', undefined, 'bio'));
    const { error } = await collect(callModel({ plan: plan() }, 'large', c, { provider: 'byok', vendor: 'anthropic' }));
    expect(error?.code).toBe('declined');
    expect(error?.message).toBe('Claude declined to answer this (its biology safeguard). Try rewording it, or pick another model.');
    expect(isTransient(error?.code)).toBe(false);
    const asked = await collect(callModel({ plan: plan() }, 'large', ctx(() => stopping('refusal', 'Partial', 'reasoning_extraction')), { provider: 'byok', vendor: 'anthropic' }));
    expect(asked.error?.message).toContain('Ask for the steps of the solution instead');
  });

  it('says when the length limit cut an answer short, or left none', async () => {
    const cut = await collect(callModel({ plan: plan() }, 'large', ctx(() => stopping('max_tokens', 'The first half')), { provider: 'byok', vendor: 'anthropic' }));
    expect(cut.text).toBe('The first half');
    expect(cut.error).toMatchObject({ code: 'cut-off', message: 'The answer reached its length limit and stops here. Ask it to go on.' });
    const none = await collect(callModel({ plan: plan() }, 'large', ctx(() => stopping('max_tokens')), { provider: 'byok', vendor: 'anthropic' }));
    expect(none.error?.message).toContain('spent its whole length limit thinking');
    expect(isTransient(none.error?.code)).toBe(true);
  });

  it('asks Haiku without a fallback, and again without one when an account turns it down', async () => {
    const calls: Call[] = [];
    await collect(callModel({ plan: plan({ parts: [{ kind: 'text', text: 'x' }], route: 'small' }) }, 'small', ctx(() => anthropicStream('ok'), calls), { provider: 'byok', vendor: 'anthropic' }));
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe('claude-haiku-5-5');
    expect(JSON.parse(String(calls[0]!.init.body))).not.toHaveProperty('fallbacks');

    const tries: Call[] = [];
    const refuses = ctx(
      (call) =>
        JSON.parse(String(call.init.body)).fallbacks
          ? json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not available for this organization' } })
          : anthropicStream('ok'),
      tries,
    );
    const opus = { provider: 'byok' as const, vendor: 'anthropic' as const, model: { vendor: 'anthropic' as const, model: 'claude-opus-5-5' } };
    const first = await collect(callModel({ plan: plan() }, 'large', refuses, opus));
    expect(first.error).toBeUndefined();
    expect(first.text).toBe('ok');
    expect((await collect(callModel({ plan: plan({ question: 'And why?' }) }, 'large', refuses, opus))).text).toBe('ok');
    // Asked with it once, then without it from then on.
    expect(tries.map((t) => 'fallbacks' in JSON.parse(String(t.init.body)))).toEqual([true, false, false]);
  });

  it('treats a stream with no text as a failure, not an empty answer', async () => {
    const c = ctx(() => sse([{ data: { type: 'message_start', message: { usage: {} } } }, { data: { type: 'message_stop' } }]));
    const { error } = await collect(callModel({ plan: plan() }, 'large', c, { provider: 'byok', vendor: 'anthropic' }));
    expect(error?.code).toBe('empty');
  });
});

/** OpenAI's Responses stream: the text, then how it ended. */
const openAIAnswer = (text: string, completed: object = { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }) =>
  sse([...(text ? [{ data: { type: 'response.output_text.delta', delta: text } }] : []), { data: completed }]);

describe('OpenAI requests', () => {
  it('asks the Responses API, with no custom headers, which would trigger a CORS preflight OpenAI may refuse', async () => {
    const calls: Call[] = [];
    const c = ctx(() => openAIAnswer('hi'), calls);
    const { text } = await collect(callModel({ plan: plan() }, 'large', c, { provider: 'byok', vendor: 'openai' }));
    expect(text).toBe('hi');
    expect(calls[0]!.url).toBe(OPENAI_URL);
    expect(Object.keys(calls[0]!.init.headers as Record<string, string>).sort()).toEqual(['authorization', 'content-type']);
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; max_output_tokens: number; input: { role: string; content: unknown }[]; tools?: unknown };
    expect(body.model).toBe('gpt-6-sol');
    expect(body.max_output_tokens).toBe(32_000);
    expect(body.input.map((m) => m.role)).toEqual(['system', 'user']);
    expect((body.input[1]!.content as { type: string }[]).map((p) => p.type)).toEqual(['input_image', 'input_text']);
    expect(body.tools).toBeUndefined();
  });

  it('says when a filter stopped the answer, or the length limit cut it short', async () => {
    const ending = (reason: string, text = '') => openAIAnswer(text, { type: 'response.incomplete', response: { incomplete_details: { reason } } });
    const filtered = await collect(callModel({ plan: plan() }, 'large', ctx(() => ending('content_filter', 'Part')), { provider: 'byok', vendor: 'openai' }));
    expect(filtered.error).toMatchObject({ code: 'declined', message: 'ChatGPT declined to answer this. Try rewording it, or pick another model.' });
    const cut = await collect(callModel({ plan: plan() }, 'large', ctx(() => ending('max_output_tokens')), { provider: 'byok', vendor: 'openai' }));
    expect(cut.error?.code).toBe('cut-off');
    const failed = await collect(
      callModel({ plan: plan() }, 'large', ctx(() => openAIAnswer('', { type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } })), {
        provider: 'byok',
        vendor: 'openai',
      }),
    );
    expect(failed.error?.message).toBe('OpenAI stopped partway: boom. Try again.');
  });

  it('never asks OpenAI to store the answer; a temporary chat also asks for an in-memory prompt cache', async () => {
    const calls: Call[] = [];
    const ok = () => openAIAnswer('hi');
    await collect(callModel({ plan: plan() }, 'large', ctx(ok, calls), { provider: 'byok', vendor: 'openai' }));
    const saved = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(saved.store).toBe(false);
    expect('prompt_cache_retention' in saved).toBe(false);

    await collect(callModel({ plan: plan() }, 'large', { ...ctx(ok, calls), ephemeral: true }, { provider: 'byok', vendor: 'openai' }));
    const ghost = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect(ghost).toMatchObject({ store: false, prompt_cache_retention: 'in_memory' });
  });

  it('asks again without the in-memory cache when a model only offers the 24-hour one, and remembers', async () => {
    const calls: Call[] = [];
    const c = {
      ...ctx(({ init }) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.prompt_cache_retention) {
          return json(400, { error: { message: "Invalid value for 'prompt_cache_retention': this model supports only '24h'.", type: 'invalid_request_error', param: 'prompt_cache_retention' } });
        }
        return openAIAnswer('fine');
      }, calls),
      ephemeral: true,
    };
    const opts = { provider: 'byok' as const, vendor: 'openai' as const, model: { vendor: 'openai' as const, model: 'gpt-6-sol-24h-only' } };
    const first = await collect(callModel({ plan: plan() }, 'large', c, opts));
    expect(first.text).toBe('fine');
    expect(calls).toHaveLength(2);
    const second = await collect(callModel({ plan: plan() }, 'large', c, opts));
    expect(second.text).toBe('fine');
    expect(calls).toHaveLength(3); // straight to the plain request this time
  });

  it('says "out of credit" for insufficient_quota rather than "rate limited"', async () => {
    const c = ctx(() => json(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }));
    const { error } = await collect(callModel({ plan: plan() }, 'large', c, { provider: 'byok', vendor: 'openai' }));
    expect(error?.code).toBe('no-credit');
    expect(error?.message).toMatch(/out of credit/);
    expect(needsSettings(error?.code)).toBe(true);
  });
});

describe('web search', () => {
  const ev = (data: Record<string, unknown>) => ({ event: String(data.type), data });

  it('gives Claude its search tool only when asked, and turns its citations into numbered links and a list of sources', async () => {
    const calls: Call[] = [];
    const searches: number[] = [];
    const c = {
      ...ctx(
        () =>
          sse([
            ev({ type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } }),
            ev({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search' } }),
            ev({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: [] } }),
            ev({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
            ev({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'It opened in 1889' } }),
            ev({ type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.com/tower', title: 'The [Tower] $5' } } }),
            ev({ type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'javascript:alert(1)', title: 'x' } } }),
            ev({ type: 'content_block_stop', index: 2 }),
            ev({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '.' } }),
            ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 9000, output_tokens: 30, server_tool_use: { web_search_requests: 1 } } }),
          ]),
        calls,
      ),
      onSearch: () => searches.push(1),
    };
    const { text, done } = await collect(callModel({ plan: plan(), search: true }, 'large', c, { provider: 'byok', vendor: 'anthropic' }));
    expect(JSON.parse(String(calls[0]!.init.body)).tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
    expect(searches).toHaveLength(1);
    expect(text).toBe('It opened in 1889 [&#91;1&#93;](<https://example.com/tower>).\n\n**Sources**\n\n1. [The &#91;Tower&#93; &#36;5](<https://example.com/tower>)\n');
    // The search's own fee is counted with the tokens it read.
    expect(done?.usage?.inputTokens).toBe(9000);
    expect(done?.usage?.costUsd).toBeGreaterThan(0.01);

    await collect(callModel({ plan: plan() }, 'large', c, { provider: 'byok', vendor: 'anthropic' }));
    expect(JSON.parse(String(calls[1]!.init.body)).tools).toBeUndefined();
  });

  it('gives OpenAI its search tool, capped, and lists the pages it cited', async () => {
    const calls: Call[] = [];
    const c = ctx(
      () =>
        sse([
          { data: { type: 'response.output_item.added', item: { type: 'web_search_call' } } },
          { data: { type: 'response.output_item.done', item: { type: 'web_search_call', action: { type: 'search' } } } },
          { data: { type: 'response.output_text.delta', delta: 'Paris ([example.com](https://example.com/a)).' } },
          { data: { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://example.com/a', title: 'A' } } },
          { data: { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://example.com/a', title: 'A' } } },
          { data: { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } } },
        ]),
      calls,
    );
    const { text } = await collect(callModel({ plan: plan(), search: true }, 'large', c, { provider: 'byok', vendor: 'openai' }));
    const body = JSON.parse(String(calls[0]!.init.body)) as { tools: unknown; max_tool_calls: number };
    // From OpenAI's index only: no page the model names is opened live.
    expect(body.tools).toEqual([{ type: 'web_search', external_web_access: false }]);
    expect(body.max_tool_calls).toBe(3);
    expect(text).toBe('Paris ([example.com](https://example.com/a)).\n\n**Sources**\n\n1. [A](<https://example.com/a>)\n');
  });
});

describe('describeHttpError', () => {
  const cases: [number, unknown, string, RegExp][] = [
    [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'bad-key', /rejected the API key/],
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 'no-credit', /out of credit/],
    [404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } }, 'model', /no model "claude-x"/],
    [413, { type: 'error', error: { type: 'request_too_large', message: 'too big' } }, 'too-large', /smaller box/],
    [429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'rate-limit', /in 12 s/],
    [529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'overloaded', /overloaded/],
    [500, { type: 'error', error: { type: 'api_error', message: 'boom' } }, 'http', /server error \(500\)/],
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages: roles must alternate' } }, 'http', /roles must alternate/],
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'Web search is not enabled for this organization.' } }, 'unsupported', /Turn off the globe/],
  ];
  it.each(cases)('HTTP %i → a sentence and a code the panel can act on', (status, body, code, message) => {
    const e = describeHttpError('Anthropic', status, JSON.stringify(body), { model: 'claude-x', retryAfter: '12' });
    expect(e.code).toBe(code);
    expect(e.message).toMatch(message);
  });

  it('keeps the request id for a support ticket', () => {
    const e = describeHttpError('Anthropic', 500, JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'x' }, request_id: 'req_1' }));
    expect(e.requestId).toBe('req_1');
  });

  it('copes with a body that is not JSON', () => {
    expect(describeHttpError('OpenAI', 502, '<html>Bad gateway</html>').code).toBe('http');
  });
});

describe('network failures', () => {
  it('say what to check instead of "Failed to fetch"', async () => {
    const c = ctx(() => {
      throw new TypeError('Failed to fetch');
    });
    const { error } = await collect(callModel({ plan: plan() }, 'large', c, { provider: 'byok', vendor: 'anthropic' }));
    expect(error?.code).toBe('network');
    expect(error?.message).toMatch(/Could not reach Anthropic/);
    expect(error?.message).toContain('api.anthropic.com');
  });
});

describe('testKey', () => {
  it('lists Anthropic models without spending a token', async () => {
    const calls: Call[] = [];
    const { vault } = ctx(
      () =>
        json(200, {
          data: [
            { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', capabilities: { image_input: { supported: true } } },
            { id: 'claude-text-only', display_name: 'Text Only', capabilities: { image_input: { supported: false } } },
          ],
        }),
      calls,
      { anthropic: '  sk-ant-x  ', openai: '' },
    );
    const r = await testKey(vault, 'anthropic');
    expect(calls[0]!.url).toContain('/v1/models');
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-x');
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
    expect(r).toEqual({
      ok: true,
      models: [
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', vision: true },
        { id: 'claude-text-only', name: 'Text Only', vision: false },
      ],
    });
  });

  it('keeps only OpenAI chat models', async () => {
    const { vault } = ctx(() =>
      json(200, { data: [{ id: 'gpt-6-sol' }, { id: 'text-embedding-3-large' }, { id: 'gpt-4o-mini-tts' }, { id: 'o4-mini' }, { id: 'dall-e-3' }] }),
    );
    const r = await testKey(vault, 'openai');
    expect(r.ok && r.models.map((m) => m.id)).toEqual(['gpt-6-sol', 'o4-mini']);
  });

  it('reports a rejected key in words', async () => {
    const { vault } = ctx(() => json(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
    const r = await testKey(vault, 'openai');
    expect(r).toEqual({ ok: false, error: 'OpenAI rejected the API key. Check it in Settings.', code: 'bad-key' });
  });

  it('asks for a key before calling anyone', async () => {
    const calls: Call[] = [];
    const r = await testKey(ctx(() => json(200, {}), calls, { anthropic: '   ', openai: '' }).vault, 'anthropic');
    expect(r).toMatchObject({ ok: false, code: 'no-key' });
    expect(calls).toHaveLength(0);
  });
});
