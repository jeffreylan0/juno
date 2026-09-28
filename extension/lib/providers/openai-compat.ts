/**
 * OpenAI-compatible chat message shape, used verbatim by OpenAI, Ollama and the
 * Worker, and converted by byok.ts for Anthropic.
 */
import type { AskRequest, Plan } from '@shared/payload';
import { selectionPrompt, systemPrompt } from '@shared/prompts';
import { ProviderError } from './types';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/**
 * Builds a conversation. The selection is attached exactly once, to the
 * opening user turn, the way a chat app attaches a file to the first message:
 *
 *   system · user(selection + Q1) · assistant(A1) · user(Q2) · …
 *
 * Follow-ups are plain text. Re-attaching the selection to every turn would
 * resend the image each time, cost tokens for nothing, and leave the model
 * unsure whether a "new" selection had arrived.
 */
export function toChatMessages(req: AskRequest): ChatMessage[] {
  const { plan, history = [] } = req;
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(plan.mode) }];

  // History must open with the student's first question; anything else means
  // there is no usable opening turn, so treat this as the start of a thread.
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

export async function ensureOk(res: Response, vendor: string): Promise<void> {
  if (res.ok) return;
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  throw new ProviderError(`${vendor} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, 'http', res.status);
}

interface OpenAIChunk {
  choices?: { delta?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** Streams an OpenAI-style chat.completions response. */
export async function* streamOpenAIChat(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<string, { inputTokens: number; outputTokens: number }, void> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    signal,
  });
  await ensureOk(res, headers['x-vendor'] ?? url);
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const data of sseData(res)) {
    if (data === '[DONE]') break;
    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(data) as OpenAIChunk;
    } catch {
      continue;
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }
  }
  return { inputTokens, outputTokens };
}
