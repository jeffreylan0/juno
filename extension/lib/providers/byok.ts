/**
 * Bring-your-own-key provider: direct calls to Anthropic (Messages API, with the
 * direct-browser-access header) and OpenAI (chat.completions) using the key the
 * student typed into Options. The key never leaves the background script.
 */
import type { AskRequest, ModelRef } from '@shared/payload';
import { estimateCostUsd } from '../router';
import { ensureOk, sseData, streamOpenAIChat, toChatMessages, type ChatMessage, type ContentPart } from './openai-compat';
import { ProviderError, type ProviderContext, type ProviderDriver, type StreamResult } from './types';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const ANTHROPIC_VERSION = '2023-06-01';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

function dataUrlToSource(url: string): { media_type: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) throw new ProviderError('Image part is not a base64 data URL', 'unsupported');
  return { media_type: m[1]!, data: m[2]! };
}

/** Converts the shared OpenAI-compatible shape into an Anthropic request body. */
export function toAnthropicBody(messages: ChatMessage[], model: string, maxTokens = 2048) {
  let system = '';
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + (typeof m.content === 'string' ? m.content : '');
      continue;
    }
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks: AnthropicBlock[] = m.content.map((c: ContentPart) =>
      c.type === 'text'
        ? { type: 'text', text: c.text }
        : { type: 'image', source: { type: 'base64', ...dataUrlToSource(c.image_url.url) } },
    );
    // Anthropic prefers images before the text that refers to them.
    blocks.sort((a, b) => (a.type === 'image' ? 0 : 1) - (b.type === 'image' ? 0 : 1));
    out.push({ role: m.role, content: blocks });
  }
  return { model, max_tokens: maxTokens, system, messages: out, stream: true as const };
}

interface AnthropicEvent {
  type: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  delta?: { type?: string; text?: string };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}

async function* streamAnthropic(
  req: AskRequest,
  model: ModelRef,
  ctx: ProviderContext,
): AsyncGenerator<string, StreamResult, void> {
  if (!ctx.keys.anthropic) throw new ProviderError('No Anthropic key set in Options', 'no-key');
  const res = await ctx.fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ctx.keys.anthropic,
      'anthropic-version': ANTHROPIC_VERSION,
      // Required for calls made from a browser extension; the key is the user's own.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(toAnthropicBody(toChatMessages(req), model.model)),
    signal: ctx.signal,
  });
  await ensureOk(res, 'Anthropic');
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const data of sseData(res)) {
    let ev: AnthropicEvent;
    try {
      ev = JSON.parse(data) as AnthropicEvent;
    } catch {
      continue;
    }
    switch (ev.type) {
      case 'message_start':
        inputTokens = ev.message?.usage?.input_tokens ?? 0;
        break;
      case 'content_block_delta':
        if (ev.delta?.type === 'text_delta' && ev.delta.text) yield ev.delta.text;
        break;
      case 'message_delta':
        outputTokens = ev.usage?.output_tokens ?? outputTokens;
        break;
      case 'error':
        throw new ProviderError(ev.error?.message ?? 'Anthropic stream error', 'http');
    }
  }
  return { usage: { inputTokens, outputTokens, costUsd: estimateCostUsd(model.model, inputTokens, outputTokens) } };
}

async function* streamOpenAI(
  req: AskRequest,
  model: ModelRef,
  ctx: ProviderContext,
): AsyncGenerator<string, StreamResult, void> {
  if (!ctx.keys.openai) throw new ProviderError('No OpenAI key set in Options', 'no-key');
  const usage = yield* streamOpenAIChat(
    ctx.fetch,
    OPENAI_URL,
    { authorization: `Bearer ${ctx.keys.openai}`, 'x-vendor': 'OpenAI' },
    { model: model.model, messages: toChatMessages(req) },
    ctx.signal,
  );
  return { usage: { ...usage, costUsd: estimateCostUsd(model.model, usage.inputTokens, usage.outputTokens) } };
}

export const byokDriver: ProviderDriver = {
  name: 'byok',
  stream(req, model, ctx) {
    if (model.vendor === 'anthropic') return streamAnthropic(req, model, ctx);
    if (model.vendor === 'openai') return streamOpenAI(req, model, ctx);
    throw new ProviderError(`BYOK cannot call vendor "${model.vendor}"`, 'unsupported');
  },
};
