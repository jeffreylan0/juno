/**
 * The OpenAI chat shape a conversation is built in: sent as it is to a local
 * model (Ollama) and the Worker, and turned into Anthropic's Messages or
 * OpenAI's Responses for a key (shared/vendors.ts).
 */
import type { AskRequest, Attachment, Mode } from '@shared/payload';
import { DEFAULT_PROMPTS, partToText, splitWhatIRead, systemPrompt } from '@shared/prompts';
import { sseSplitter } from '@shared/vendors';
import { cutOff, declined, ensureVendorOk, vendorFetch, type VendorName } from './errors';
import { ProviderError } from './types';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/**
 * Builds a conversation the way the Claude and ChatGPT apps send one: each
 * selection attached to the message it was asked with, its images first and
 * the question after, and the whole conversation each time, earlier
 * screenshots included (prompt caching makes the repeated part cheap):
 *
 *   system · user(selection A, Q1) · assistant(A1) · user(Q2) · assistant(A2)
 *          · user(selections B, C, Q3) · …
 *
 * Nothing is said about a selection beyond the selection itself: no page
 * title (a window called "Quiz 2.1" made models refuse students), no sizes.
 * Earlier answers go back without their "Read:" line, so a follow-up isn't
 * coaxed into describing a selection it doesn't have.
 */
export function toChatMessages(req: AskRequest): ChatMessage[] {
  const { plan, history = [] } = req;
  // The app always says which selections go with the question; the eval's single selection is the plan's own.
  const attachments = req.attachments ?? [{ parts: plan.parts }];
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(plan.mode) }];
  history.forEach((turn, i) => {
    messages.push(
      turn.role === 'user'
        ? { role: 'user', content: userTurn(turn.attachments ?? [], turn.text, plan.mode, i > 0) }
        : { role: 'assistant', content: splitWhatIRead(turn.text).body || turn.text },
    );
  });
  messages.push({ role: 'user', content: userTurn(attachments, plan.question, plan.mode, history.length > 0) });
  return messages;
}

/** A user turn: the question alone, or after its selections (labelled when there are several). */
function userTurn(attachments: Attachment[], question: string | undefined, mode: Mode, followUp: boolean): string | ContentPart[] {
  const q = question?.trim() || (followUp ? 'Go on.' : DEFAULT_PROMPTS[mode]);
  const selections = attachments.filter((a) => a.parts.length);
  if (!selections.length) return q;
  const content: ContentPart[] = [];
  selections.forEach((a, i) => {
    if (selections.length > 1) content.push({ type: 'text', text: `Selection ${i + 1}:` });
    const text: string[] = [];
    for (const part of a.parts) {
      if (part.kind === 'image') content.push({ type: 'image_url', image_url: { url: part.dataUrl, detail: 'high' } });
      else text.push(partToText(part));
    }
    if (text.length) content.push({ type: 'text', text: `Selected text:\n\n${text.join('\n\n')}` });
  });
  content.push({ type: 'text', text: q });
  return content;
}

/** Parses a text/event-stream body into `data:` payload strings. */
export async function* sseData(res: Response): AsyncGenerator<string, void, void> {
  if (!res.body) throw new ProviderError('Response has no body', 'empty', res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const split = sseSplitter();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      yield* split(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

interface OpenAIChunk {
  choices?: { delta?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  /** The hosted service's own: a web search began (worker/src/models.ts). */
  searching?: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  error?: { message?: string; type?: string; code?: string };
}

/**
 * Streams an OpenAI-style chat.completions response: a local model's, or
 * the hosted service's (which also says when a web search begins: `onSearch`).
 *
 * `vendor` names the server in error messages only. It is deliberately not a
 * request header: any non-standard header makes the browser send a CORS
 * preflight, and a vendor that does not list it would fail every call.
 */
export async function* streamOpenAIChat(
  fetchImpl: typeof fetch,
  url: string,
  vendor: VendorName,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  onSearch?: () => void,
): AsyncGenerator<string, { inputTokens: number; outputTokens: number; cacheRead?: number }, void> {
  const res = await vendorFetch(fetchImpl, vendor, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    signal,
  });
  await ensureVendorOk(res, vendor, typeof body.model === 'string' ? body.model : undefined);
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead: number | undefined;
  let sawText = false;
  let finish: string | null | undefined;
  for await (const data of sseData(res)) {
    if (data === '[DONE]') break;
    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(data) as OpenAIChunk;
    } catch {
      continue;
    }
    if (chunk.error) throw new ProviderError(`${vendor} stopped partway: ${chunk.error.message ?? 'unknown error'}. Try again.`, 'http');
    if (chunk.searching) onSearch?.();
    finish = chunk.choices?.[0]?.finish_reason ?? finish;
    const delta = chunk.choices?.[0]?.delta;
    const text = delta?.content || delta?.refusal;
    if (text) {
      sawText = true;
      yield text;
    }
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens ?? cacheRead;
    }
  }
  if (finish === 'content_filter') throw declined(vendor === 'OpenAI' ? 'ChatGPT' : 'The AI');
  if (finish === 'length') throw cutOff(sawText);
  if (!sawText) throw new ProviderError(`${vendor} sent back an empty answer. Try again.`, 'empty');
  return { inputTokens, outputTokens, cacheRead };
}
