/**
 * Bring-your-own-key provider: Anthropic (Messages API) and OpenAI
 * (Responses API) with the student's own key. Requests go through the
 * Vault (types.ts), which adds the key: in the app the native core does
 * (src-tauri/src/vault.rs), so the key is never in a page. Both answers are
 * read by the same code the hosted service uses (shared/vendors.ts), web
 * search included.
 *
 * Neither vendor trains on API traffic by default. What each keeps, and what
 * a temporary chat changes, is noted at each call below.
 */
import { SERVER_FALLBACK } from '@shared/models';
import type { AskRequest, ModelRef } from '@shared/payload';
import { anthropicReader, anthropicSearch, openAISearch, responsesReader, toAnthropic, toResponses, type AnswerReader } from '@shared/vendors';
import { COMPANY, estimateCostUsd } from '../router';
import { cutOff, declined, describeStreamError, ensureVendorOk, vendorFetch, type VendorName } from './errors';
import { sseData, toChatMessages, type ChatMessage } from './openai-compat';
import { ProviderError, type KeyStatus, type KeyVendor, type ProviderContext, type ProviderDriver, type StreamResult, type Vault } from './types';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
export const OPENAI_URL = 'https://api.openai.com/v1/responses';
export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
/** What lets a request carry `fallbacks` (below); the native core sends the same (vault.rs). */
export const ANTHROPIC_BETA = 'server-side-fallback-2026-07-01';
/**
 * Room for the thinking as well as the answer. Every current model thinks
 * before it answers, and the thinking counts toward this limit: at 4,096 a
 * hard question could use it all up, leaving an answer cut short or none.
 * Most answers use a fraction of it, and room not used costs nothing.
 */
export const MAX_OUTPUT_TOKENS = 32_000;

/** Models the key's account turned the fallback down for: asked again without it, and remembered. */
const NO_FALLBACK = new Set<string>();

/** Each company's key headers (the native core adds the same: vault.rs). */
function keyHeaders(vendor: KeyVendor, key: string): Record<string, string> {
  return vendor === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-beta': ANTHROPIC_BETA }
    : { authorization: `Bearer ${key}` };
}

/** Keys the caller holds (the eval, tests): each request carries its key itself. */
export function keyVault(keys: Record<KeyVendor, string>, fetchImpl: typeof fetch): Vault {
  const hint = (k: string) => (k.trim() ? `…${k.trim().slice(-4)}` : null);
  return {
    status: async (): Promise<KeyStatus> => ({ anthropic: hint(keys.anthropic), openai: hint(keys.openai) }),
    fetch: (vendor, url, init) =>
      fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...keyHeaders(vendor, keys[vendor].trim()) } }),
  };
}

/** fetch to `vendor` with the student's key, or a "no key" error. */
async function keyed(vault: Vault, vendor: KeyVendor): Promise<typeof fetch> {
  if (!(await vault.status())[vendor]) throw new ProviderError(`Add your ${COMPANY[vendor]} API key in Settings to get answers.`, 'no-key');
  return (input, init) => vault.fetch(vendor, String(input), init ?? {});
}

/** An Anthropic request for a chat (shared/vendors.ts toAnthropic: the latest question is cached). */
export function toAnthropicBody(messages: ChatMessage[], model: string, maxTokens = MAX_OUTPUT_TOKENS) {
  return { model, max_tokens: maxTokens, ...toAnthropic(messages), stream: true as const };
}

/** A web search costs $10 per 1,000 at either company, on top of the tokens. */
const SEARCH_USD = 0.01;

/**
 * Reads a vendor's streamed answer (shared/vendors.ts): its text, then the
 * sources it cited; a search starting is passed on (ctx.onSearch). How it
 * ended decides whether it was an answer at all.
 */
async function* readAnswer(
  res: Response,
  reader: AnswerReader,
  vendor: VendorName,
  model: string,
  ctx: ProviderContext,
): AsyncGenerator<string, StreamResult, void> {
  for await (const data of sseData(res)) {
    const step = reader.read(data);
    if (step.error) throw describeStreamError(vendor, step.error);
    if (step.searching) ctx.onSearch?.();
    if (step.text) yield step.text;
  }
  const end = reader.end();
  // A fallback that answered ends normally; only a decline nothing rescued says `refusal`.
  if (end.stop === 'refusal') throw declined(vendor === 'Anthropic' ? 'Claude' : 'ChatGPT', end.category);
  // Even an answer cut short keeps the sources it cited.
  if (end.sawText && end.sources) yield end.sources;
  if (end.stop === 'length') throw cutOff(end.sawText);
  if (!end.sawText) throw new ProviderError(`${vendor} sent back an empty answer. Try again.`, 'empty');
  const { input, output, cacheRead, cacheWrite } = end.usage;
  const cost = estimateCostUsd(model, input, output, { read: cacheRead, write: cacheWrite });
  return { usage: { inputTokens: input, outputTokens: output, costUsd: cost === undefined ? undefined : cost + end.searches * SEARCH_USD } };
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
  const send = await keyed(ctx.vault, 'anthropic');
  const body = { ...toAnthropicBody(toChatMessages(req), model.model), ...(req.search ? anthropicSearch() : {}) };
  const call = async (b: object) => {
    const res = await vendorFetch(send, 'Anthropic', ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
      signal: ctx.signal,
    });
    await ensureVendorOk(res, 'Anthropic', model.model);
    return res;
  };
  let res: Response;
  if (SERVER_FALLBACK.has(model.model) && !NO_FALLBACK.has(model.model)) {
    try {
      res = await call({ ...body, fallbacks: 'default' });
    } catch (err) {
      // Turned down before a word was streamed, so asking again repeats nothing.
      const e = err as ProviderError;
      if (e.status !== 400 || !/fallback/i.test(`${e.detail ?? ''} ${e.message}`)) throw err;
      NO_FALLBACK.add(model.model);
      res = await call(body);
    }
  } else {
    res = await call(body);
  }
  return yield* readAnswer(res, anthropicReader(), 'Anthropic', model.model, ctx);
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
  const send = await keyed(ctx.vault, 'openai');
  // OpenAI caches long prompt prefixes by itself; nothing to mark. It never
  // trains on API traffic unless the key's organisation opted in. `store:
  // false` keeps the answer out of its stored responses; a temporary chat
  // also asks for the prompt cache to stay in memory, where the model allows.
  const body = {
    model: model.model,
    input: toResponses(toChatMessages(req)),
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
    stream: true,
    ...(req.search ? openAISearch() : {}),
  };
  const call = async (b: object) => {
    const res = await vendorFetch(send, 'OpenAI', OPENAI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
      signal: ctx.signal,
    });
    await ensureVendorOk(res, 'OpenAI', model.model);
    return res;
  };
  const memoryOnly = ctx.ephemeral && !NO_MEMORY_ONLY_CACHE.has(model.model);
  let res: Response;
  try {
    res = await call(memoryOnly ? { ...body, prompt_cache_retention: 'in_memory' } : body);
  } catch (err) {
    // Refused before a word was streamed, so asking again cannot repeat anything.
    const e = err as ProviderError;
    if (!memoryOnly || e.status !== 400 || !/prompt_cache_retention/.test(`${e.detail ?? ''} ${e.message}`)) throw err;
    NO_MEMORY_ONLY_CACHE.add(model.model);
    res = await call(body);
  }
  return yield* readAnswer(res, responsesReader(), 'OpenAI', model.model, ctx);
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
 * Checks the stored key by listing the vendor's models: free, fast, and it
 * proves the key is real without spending a token.
 */
export async function testKey(vault: Vault, vendor: KeyVendor, signal?: AbortSignal): Promise<KeyTestResult> {
  const name = COMPANY[vendor];
  try {
    const send = await keyed(vault, vendor);
    const res = await vendorFetch(send, name, vendor === 'anthropic' ? `${ANTHROPIC_MODELS_URL}?limit=100` : OPENAI_MODELS_URL, { signal });
    await ensureVendorOk(res, name);
    const body = (await res.json()) as { data?: unknown[] };
    const models = (body.data ?? []).map((m) => toKeyModel(vendor, m)).filter((m): m is KeyModel => m !== null);
    return { ok: true, models: sortModels(models) };
  } catch (err) {
    const e = err as ProviderError;
    return { ok: false, error: e.message, code: e.code ?? 'http' };
  }
}

function toKeyModel(vendor: KeyVendor, raw: unknown): KeyModel | null {
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
