/**
 * Asks OpenAI or Anthropic with the service's own keys (Worker secrets, never
 * sent anywhere else) and streams the answer back in the OpenAI chat-chunk
 * shape the extension already reads (openai-compat.ts), so it has one parser.
 *
 * What may be asked is checked before anything is spent: only the models the
 * apps choose themselves, only text and screenshots, and no more of either
 * than a long chat has. Optionally through Cloudflare's AI Gateway
 * (AI_GATEWAY_ID) for spend analytics. Its request logging is switched off on
 * every call: hosted answers keep no copy of what was asked.
 */
import { MODEL_TABLE } from '@selection-ai/shared/models';
import type { Env } from './index';

export interface AskBody {
  /** "anthropic/<model>" or "openai/<model>". */
  model: string;
  messages: ChatMessage[];
  /** A temporary chat: nothing cached anywhere it can be avoided. */
  ephemeral?: boolean;
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } };
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/** Models hosted answers may use: the apps' own automatic choice, nothing else. */
export const HOSTED_MODELS: Record<'anthropic' | 'openai', string[]> = {
  anthropic: Object.values(MODEL_TABLE.anthropic),
  openai: Object.values(MODEL_TABLE.openai),
};

/**
 * The most one hosted answer may carry. A long chat with its screenshots
 * fits easily (answers are at most MAX_OUTPUT_TOKENS each); anything bigger
 * would cost far more than a plan's answer is worth.
 */
export const LIMITS = { messages: 100, images: 20, imageChars: 7_000_000, textChars: 200_000 };

const MAX_OUTPUT_TOKENS = 4096;
const ROLES = ['system', 'user', 'assistant'] as const;
/** A screenshot, inline: never a URL the vendor would fetch. */
const IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

export class BadRequest extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'bad-request',
  ) {
    super(message);
  }
}

const malformed = () => new BadRequest('A message is malformed.');

/**
 * The request, rebuilt from the parts it may have: anything else (other
 * content types, remote image URLs, extra fields) is refused, never passed on.
 */
export function parseAsk(raw: unknown): { vendor: 'anthropic' | 'openai'; model: string; body: AskBody } {
  const body = raw as { model?: unknown; messages?: unknown; ephemeral?: unknown } | null;
  if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new BadRequest('A model and messages are needed.');
  }
  const [vendor, model] = body.model.split('/') as [string, string | undefined];
  if ((vendor !== 'anthropic' && vendor !== 'openai') || !model || !HOSTED_MODELS[vendor].includes(model)) {
    throw new BadRequest(`Hosted answers can't use ${body.model}.`);
  }
  let images = 0;
  let text = 0;
  const messages = (body.messages as unknown[]).map((m): ChatMessage => {
    const { role, content } = (m ?? {}) as { role?: unknown; content?: unknown };
    if (!ROLES.includes(role as ChatMessage['role'])) throw malformed();
    if (typeof content === 'string') {
      text += content.length;
      return { role: role as ChatMessage['role'], content };
    }
    if (!Array.isArray(content)) throw malformed();
    return {
      role: role as ChatMessage['role'],
      content: content.map((p): ContentPart => {
        const part = (p ?? {}) as { type?: unknown; text?: unknown; image_url?: { url?: unknown; detail?: unknown } };
        if (part.type === 'text' && typeof part.text === 'string') {
          text += part.text.length;
          return { type: 'text', text: part.text };
        }
        const url = part.image_url?.url;
        if (part.type === 'image_url' && typeof url === 'string' && url.length <= LIMITS.imageChars && IMAGE.test(url)) {
          images += 1;
          const detail = part.image_url?.detail;
          return { type: 'image_url', image_url: { url, ...(detail === 'auto' || detail === 'low' || detail === 'high' ? { detail } : {}) } };
        }
        throw malformed();
      }),
    };
  });
  if (messages.length > LIMITS.messages || images > LIMITS.images || text > LIMITS.textChars) {
    throw new BadRequest('This chat is too long for hosted answers. Start a new chat.', 413, 'too-large');
  }
  return { vendor, model, body: { model: body.model, messages, ...(body.ephemeral === true ? { ephemeral: true } : {}) } };
}

function base(env: Env, vendor: 'anthropic' | 'openai'): string {
  if (env.AI_GATEWAY_ID) return `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ID}/selection-ai/${vendor}`;
  return vendor === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1';
}

function gatewayHeaders(env: Env, ephemeral: boolean | undefined): Record<string, string> {
  if (!env.AI_GATEWAY_ID) return {};
  return { 'cf-aig-collect-log': 'false', ...(ephemeral ? { 'cf-aig-skip-cache': 'true' } : {}) };
}

/** The vendor's response: an error as is, or a 200 whose body is OpenAI-shaped SSE. */
export async function callVendor(vendor: 'anthropic' | 'openai', model: string, body: AskBody, env: Env): Promise<Response> {
  if (vendor === 'openai') {
    return await fetch(`${base(env, 'openai')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}`, ...gatewayHeaders(env, body.ephemeral) },
      body: JSON.stringify({
        model,
        messages: body.messages,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        store: false,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  }

  const { system, messages } = toAnthropic(body.messages);
  const res = await fetch(`${base(env, 'anthropic')}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      ...gatewayHeaders(env, body.ephemeral),
    },
    body: JSON.stringify({ model, system, messages, max_tokens: MAX_OUTPUT_TOKENS, stream: true }),
  });
  if (!res.ok || !res.body) return res;
  return new Response(res.body.pipeThrough(anthropicToOpenAI()), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

type AnthropicBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: { type: 'ephemeral' } };

/** OpenAI messages to Anthropic's: system apart, images as base64 blocks, the last turn cached. */
export function toAnthropic(input: ChatMessage[]): { system: string; messages: { role: 'user' | 'assistant'; content: string | AnthropicBlock[] }[] } {
  const text = (c: ChatMessage['content']) => (typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join('\n'));
  const system = input.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n\n');
  const messages = input
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (typeof m.content === 'string') return { role: m.role as 'user' | 'assistant', content: m.content };
      const blocks: AnthropicBlock[] = m.content.flatMap((p): AnthropicBlock[] => {
        if (p.type === 'text') return [{ type: 'text', text: p.text }];
        const match = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url.url);
        return match ? [{ type: 'image', source: { type: 'base64', media_type: match[1]!, data: match[2]! } }] : [];
      });
      return { role: m.role as 'user' | 'assistant', content: blocks };
    });
  // A conversation is one growing prefix: cache up to the latest question.
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
    else if (last.content.length) last.content[last.content.length - 1]!.cache_control = { type: 'ephemeral' };
  }
  return { system, messages };
}

/** Anthropic's message events, re-emitted as OpenAI chat chunks with usage at the end. */
export function anthropicToOpenAI(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let input = 0;
  let cached = 0;
  let output = 0;
  const send = (c: TransformStreamDefaultController<Uint8Array>, data: unknown) =>
    c.enqueue(encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`));

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        let msg: {
          type?: string;
          delta?: { type?: string; text?: string };
          message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
          usage?: { output_tokens?: number };
          error?: { type?: string; message?: string };
        };
        try {
          msg = JSON.parse(data);
        } catch {
          continue;
        }
        if (msg.type === 'message_start') {
          const u = msg.message?.usage ?? {};
          cached = u.cache_read_input_tokens ?? 0;
          input = (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
        } else if (msg.type === 'content_block_delta' && msg.delta?.type === 'text_delta' && msg.delta.text) {
          send(controller, { choices: [{ index: 0, delta: { content: msg.delta.text } }] });
        } else if (msg.type === 'message_delta') {
          output = msg.usage?.output_tokens ?? output;
        } else if (msg.type === 'error') {
          send(controller, { error: { message: msg.error?.message ?? 'The AI stopped partway.', type: msg.error?.type } });
        }
      }
    },
    flush(controller) {
      send(controller, {
        choices: [],
        usage: { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: { cached_tokens: cached } },
      });
      send(controller, '[DONE]');
    },
  });
}
