/**
 * Bring-your-own-key provider: direct calls to Anthropic (Messages API, with the
 * direct-browser-access header) and OpenAI (chat.completions) using the key the
 * student typed into settings. The key never leaves the core window.
 *
 * Neither vendor trains on API traffic by default. What each keeps, and what
 * a temporary chat changes, is noted at each call below.
 *
 * Only standard headers plus the ones each vendor documents are sent: the
 * background's fetch is a cross-origin request, so an unexpected header means
 * a CORS preflight the vendor may refuse.
 */
import type { AskRequest, ModelRef } from '@shared/payload';
import { COMPANY, estimateCostUsd } from '../router';
import { describeStreamError, ensureVendorOk, vendorFetch } from './errors';
import { sseData, streamOpenAIChat, toChatMessages, type ChatMessage, type ContentPart } from './openai-compat';
import { ProviderError, type ProviderContext, type ProviderDriver, type StreamResult } from './types';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
export const ANTHROPIC_VERSION = '2023-06-01';
/** Room for a full worked solution; most answers use a fraction of it. */
export const MAX_OUTPUT_TOKENS = 4096;

type CacheControl = { type: 'ephemeral' };

type AnthropicBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: CacheControl };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export function anthropicHeaders(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    // Required for calls made from a web page (the app's windows are); the key is the user's own.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

function dataUrlToSource(url: string): { media_type: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) throw new ProviderError('Image part is not a base64 data URL', 'unsupported');
  return { media_type: m[1]!, data: m[2]! };
}

/**
 * Converts the shared OpenAI-compatible shape into an Anthropic request body.
 *
 * The last user message carries a prompt-cache breakpoint. A conversation is
 * one growing prefix — system, the selection (often a screenshot), then the
 * turns — so each follow-up reads everything before it from cache at a tenth
 * of the input price instead of paying for the image again. Below the model's
 * minimum (512 tokens on Sonnet, 4096 on Haiku) the marker is simply ignored.
 */
export function toAnthropicBody(messages: ChatMessage[], model: string, maxTokens = MAX_OUTPUT_TOKENS) {
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

  const last = out[out.length - 1];
  if (last?.role === 'user') {
    const blocks: AnthropicBlock[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1]!, cache_control: { type: 'ephemeral' } };
    last.content = blocks;
  }
  return { model, max_tokens: maxTokens, system, messages: out, stream: true as const };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicEvent {
  type: string;
  message?: { usage?: AnthropicUsage };
  delta?: { type?: string; text?: string; stop_reason?: string };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

/**
 * Anthropic deletes API inputs and outputs within 30 days and has no
 * per-request setting that shortens that (zero retention is an agreement with
 * an organisation). Its prompt cache lives in memory only, is never written to
 * disk and expires within minutes, so a temporary chat keeps it: dropping it
 * would cost more and keep nothing less.
 */
async function* streamAnthropic(
  req: AskRequest,
  model: ModelRef,
  ctx: ProviderContext,
): AsyncGenerator<string, StreamResult, void> {
  if (!ctx.keys.anthropic) throw new ProviderError('Add your Anthropic API key in Settings to get answers.', 'no-key');
  const res = await vendorFetch(ctx.fetch, 'Anthropic', ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...anthropicHeaders(ctx.keys.anthropic) },
    body: JSON.stringify(toAnthropicBody(toChatMessages(req), model.model)),
    signal: ctx.signal,
  });
  await ensureVendorOk(res, 'Anthropic', model.model);
  // `input_tokens` counts only what came after the last cache breakpoint;
  // the cached share is reported separately and billed at its own rate.
  let plain = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let outputTokens = 0;
  let sawText = false;
  for await (const data of sseData(res)) {
    let ev: AnthropicEvent;
    try {
      ev = JSON.parse(data) as AnthropicEvent;
    } catch {
      continue;
    }
    switch (ev.type) {
      case 'message_start': {
        const u = ev.message?.usage ?? {};
        plain = u.input_tokens ?? 0;
        cacheWrite = u.cache_creation_input_tokens ?? 0;
        cacheRead = u.cache_read_input_tokens ?? 0;
        outputTokens = u.output_tokens ?? 0;
        break;
      }
      case 'content_block_delta':
        if (ev.delta?.type === 'text_delta' && ev.delta.text) {
          sawText = true;
          yield ev.delta.text;
        }
        break;
      case 'message_delta':
        outputTokens = ev.usage?.output_tokens ?? outputTokens;
        break;
      case 'error':
        throw describeStreamError('Anthropic', ev.error);
    }
  }
  if (!sawText) throw new ProviderError('Anthropic sent back an empty answer. Try again.', 'empty');
  const inputTokens = plain + cacheWrite + cacheRead;
  return {
    usage: {
      inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(model.model, inputTokens, outputTokens, { read: cacheRead, write: cacheWrite }),
    },
  };
}

/**
 * Models that turned down `prompt_cache_retention: "in_memory"` (newer
 * OpenAI models keep prompt caches for 24 hours and take no shorter setting).
 * Remembered so a temporary chat asks once, not every time.
 */
const NO_MEMORY_ONLY_CACHE = new Set<string>();

async function* streamOpenAI(
  req: AskRequest,
  model: ModelRef,
  ctx: ProviderContext,
): AsyncGenerator<string, StreamResult, void> {
  if (!ctx.keys.openai) throw new ProviderError('Add your OpenAI API key in Settings to get answers.', 'no-key');
  // OpenAI caches long prompt prefixes by itself; nothing to mark. It never
  // trains on API traffic unless the key's organisation opted in. `store:
  // false` keeps the answer out of its stored completions; a temporary chat
  // also asks for the prompt cache to stay in memory, where the model allows.
  const base = { model: model.model, messages: toChatMessages(req), max_completion_tokens: MAX_OUTPUT_TOKENS, store: false };
  const memoryOnly = ctx.ephemeral && !NO_MEMORY_ONLY_CACHE.has(model.model);
  const call = (body: Record<string, unknown>) =>
    streamOpenAIChat(ctx.fetch, OPENAI_URL, 'OpenAI', { authorization: `Bearer ${ctx.keys.openai}` }, body, ctx.signal);
  let usage: { inputTokens: number; outputTokens: number; cacheRead?: number };
  try {
    usage = yield* call(memoryOnly ? { ...base, prompt_cache_retention: 'in_memory' } : base);
  } catch (err) {
    // Refused before a word was streamed, so asking again cannot repeat anything.
    const e = err as ProviderError;
    if (!memoryOnly || e.status !== 400 || !/prompt_cache_retention/.test(`${e.detail ?? ''} ${e.message}`)) throw err;
    NO_MEMORY_ONLY_CACHE.add(model.model);
    usage = yield* call(base);
  }
  return {
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: estimateCostUsd(model.model, usage.inputTokens, usage.outputTokens, { read: usage.cacheRead }),
    },
  };
}

export const byokDriver: ProviderDriver = {
  name: 'byok',
  stream(req, model, ctx) {
    if (model.vendor === 'anthropic') return streamAnthropic(req, model, ctx);
    if (model.vendor === 'openai') return streamOpenAI(req, model, ctx);
    throw new ProviderError(`BYOK cannot call vendor "${model.vendor}"`, 'unsupported');
  },
};

/** A model a key can use, as the settings page lists it. */
export interface KeyModel {
  id: string;
  name: string;
  /** Whether it reads images; box selections are screenshots, so this matters. */
  vision: boolean;
}

export type KeyTestResult = { ok: true; models: KeyModel[] } | { ok: false; error: string; code: string };

/**
 * Checks a key by listing the vendor's models: free, fast, and it proves the
 * key is real without spending a token.
 */
export async function testKey(fetchImpl: typeof fetch, vendor: 'anthropic' | 'openai', key: string): Promise<KeyTestResult> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: 'Paste a key first.', code: 'no-key' };
  const name = COMPANY[vendor];
  try {
    const res =
      vendor === 'anthropic'
        ? await vendorFetch(fetchImpl, name, `${ANTHROPIC_MODELS_URL}?limit=100`, { headers: anthropicHeaders(trimmed) })
        : await vendorFetch(fetchImpl, name, OPENAI_MODELS_URL, { headers: { authorization: `Bearer ${trimmed}` } });
    await ensureVendorOk(res, name);
    const body = (await res.json()) as { data?: unknown[] };
    const models = (body.data ?? []).map((m) => toKeyModel(vendor, m)).filter((m): m is KeyModel => m !== null);
    return { ok: true, models: sortModels(models) };
  } catch (err) {
    const e = err as ProviderError;
    return { ok: false, error: e.message, code: e.code ?? 'http' };
  }
}

function toKeyModel(vendor: 'anthropic' | 'openai', raw: unknown): KeyModel | null {
  const m = raw as { id?: string; display_name?: string; capabilities?: { image_input?: { supported?: boolean } } };
  if (!m?.id) return null;
  if (vendor === 'anthropic') {
    return { id: m.id, name: m.display_name ?? m.id, vision: m.capabilities?.image_input?.supported ?? true };
  }
  // OpenAI lists everything a key can call: embeddings, speech, images.
  // Keep the chat models; vision is not reported, so infer it from the family.
  if (!/^(gpt-|o\d|chatgpt-)/.test(m.id)) return null;
  if (/embedding|tts|whisper|audio|realtime|transcribe|image|dall-e|search|moderation|instruct/.test(m.id)) return null;
  return { id: m.id, name: m.id, vision: /^(gpt-6|gpt-5|gpt-4o|gpt-4\.1|o3|o4)/.test(m.id) };
}

function sortModels(models: KeyModel[]): KeyModel[] {
  return [...models].sort((a, b) => Number(b.vision) - Number(a.vision) || a.name.localeCompare(b.name));
}
