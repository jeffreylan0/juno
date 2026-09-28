/**
 * OpenAI-compatible chat message shape, used verbatim by OpenAI, Ollama and the
 * Worker, and converted by byok.ts for Anthropic.
 */
import type { AskRequest } from '@shared/payload';
import { systemPrompt, userPromptText } from '@shared/prompts';
import { ProviderError } from './types';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export function toChatMessages(req: AskRequest): ChatMessage[] {
  const { plan, history = [] } = req;
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(plan.mode) }];
  for (const turn of history) messages.push({ role: turn.role, content: turn.text });
  const content: ContentPart[] = [{ type: 'text', text: userPromptText(plan) }];
  for (const part of plan.parts) {
    if (part.kind === 'image') content.push({ type: 'image_url', image_url: { url: part.dataUrl, detail: 'high' } });
  }
  messages.push({ role: 'user', content });
  return messages;
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
