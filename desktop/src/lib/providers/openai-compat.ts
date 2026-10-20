/**
 * OpenAI-compatible chat message shape, used verbatim by OpenAI, Ollama and the
 * Worker, and converted by byok.ts for Anthropic.
 */
import type { AskRequest, Attachment, Mode, Plan } from '@shared/payload';
import { attachmentsPrompt, defaultQuestion, selectionPrompt, systemPrompt } from '@shared/prompts';
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
 * Builds a conversation. Each selection is attached exactly once, to the user
 * turn it was asked with, the way a chat app attaches a file to a message:
 *
 *   system · user(selection A + Q1) · assistant(A1) · user(Q2) · assistant(A2)
 *          · user(selections B, C + Q3) · …
 *
 * A chat can collect selections from several pages. Turns without one are
 * plain text; nothing is re-attached, so the model never wonders whether a
 * "new" selection arrived. (The whole conversation is resent each time, as
 * every chat API requires; prompt caching makes the repeated part cheap.)
 */
export function toChatMessages(req: AskRequest): ChatMessage[] {
  const { plan, history = [] } = req;
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(plan.mode) }];

  if (req.attachments !== undefined || history.some((t) => t.attachments?.length)) {
    for (const turn of history) {
      messages.push(turn.role === 'user' ? { role: 'user', content: userTurn(turn.attachments ?? [], turn.text, plan.mode, true) } : { role: 'assistant', content: turn.text });
    }
    messages.push({ role: 'user', content: userTurn(req.attachments ?? [], plan.question, plan.mode, history.length > 0) });
    return messages;
  }

  // Single-selection form (the eval, older callers): plan.parts is the one
  // selection, attached to the opening question. History must open with that
  // question; anything else means there is no usable opening turn.
  const opensWithUser = history[0]?.role === 'user';
  if (!opensWithUser || history.length === 0) {
    messages.push({ role: 'user', content: openingTurn(plan, plan.question) });
    return messages;
  }

  const [first, ...rest] = history;
  messages.push({ role: 'user', content: openingTurn(plan, first!.text) });
  for (const turn of rest) messages.push({ role: turn.role, content: turn.text });
  messages.push({ role: 'user', content: plan.question?.trim() || 'Go on.' });
  return messages;
}

/** A user turn: plain text, or its selections' text and images followed by the question. */
function userTurn(attachments: Attachment[], question: string | undefined, mode: Mode, followUp: boolean): string | ContentPart[] {
  if (!attachments.length) return question?.trim() || (followUp ? 'Go on.' : defaultQuestion(mode));
  const content: ContentPart[] = [{ type: 'text', text: attachmentsPrompt(attachments, question, mode) }];
  for (const a of attachments) {
    for (const part of a.parts) {
      if (part.kind === 'image') content.push({ type: 'image_url', image_url: { url: part.dataUrl, detail: 'high' } });
    }
  }
  return content;
}

function openingTurn(plan: Plan, question: string | undefined): ContentPart[] {
  const content: ContentPart[] = [{ type: 'text', text: selectionPrompt(plan, question) }];
  for (const part of plan.parts) {
    if (part.kind === 'image') content.push({ type: 'image_url', image_url: { url: part.dataUrl, detail: 'high' } });
  }
  return content;
}

/** Parses a text/event-stream body into `data:` payload strings. */
export async function* sseData(res: Response): AsyncGenerator<string, void, void> {
  if (!res.body) throw new ProviderError('Response has no body', 'empty', res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface OpenAIChunk {
  choices?: { delta?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  error?: { message?: string; type?: string; code?: string };
}

/**
 * Streams an OpenAI-style chat.completions response.
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
