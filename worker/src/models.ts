/**
 * Asks OpenAI (Responses) or Anthropic (Messages) with the service's own
 * keys (Worker secrets, never sent anywhere else) and streams the answer
 * back in the OpenAI chat-chunk shape the app already reads
 * (openai-compat.ts), so it has one parser. Both are read by the same code
 * as the student's own key is (shared/vendors.ts), web search and its
 * sources included.
 *
 * What may be asked is checked before anything is spent: only the models a
 * plan offers (each answer taking what it costs from the allowance:
 * ANSWER_COST), only text and screenshots, and no more of either than a
 * long chat has. Optionally through Cloudflare's AI Gateway
 * (AI_GATEWAY_ID) for spend analytics. Its request logging and its response
 * cache are switched off on every call: hosted answers keep no copy of what
 * was asked, and never hand one student an answer made for another.
 *
 * Prompt caching: every hosted student shares the service's one OpenAI
 * organisation and one Anthropic workspace, where a cached prompt prefix
 * would serve anyone sending the same bytes, and how fast an answer starts
 * could tell them someone had. So each chat gets its own cache scope
 * (cacheScope): a line at the very start of the prompt, and OpenAI's
 * prompt_cache_key. Follow-ups in a chat still hit its cache; nothing is
 * shared between chats or students, and the scope says nothing about who
 * asked (a hash the vendors cannot link from one chat to the next).
 */
import { ANSWER_COST, SERVER_FALLBACK, vendorOf } from '@selection-ai/shared/models';
import { systemPrompt } from '@selection-ai/shared/prompts';
import {
  anthropicReader,
  anthropicSearch,
  openAISearch,
  responsesReader,
  sseSplitter,
  toAnthropic,
  toResponses,
  type AnswerReader,
  type ChatMessage,
  type ChatPart,
  type Ending,
} from '@selection-ai/shared/vendors';
import type { Env } from './index';

export interface AskBody {
  /** "anthropic/<model>" or "openai/<model>". */
  model: string;
  messages: ChatMessage[];
  /** A temporary chat: nothing cached anywhere it can be avoided. */
  ephemeral?: boolean;
  /** The student asked with web search on (shared/vendors.ts); each search is paid for (index.ts). */
  search?: boolean;
}

/** Models hosted answers may use, by vendor: the ones a plan offers, nothing else. */
export const HOSTED_MODELS: Record<'anthropic' | 'openai', string[]> = {
  anthropic: Object.keys(ANSWER_COST).filter((m) => vendorOf(m) === 'anthropic'),
  openai: Object.keys(ANSWER_COST).filter((m) => vendorOf(m) === 'openai'),
};

/**
 * The most one hosted answer may carry. A long chat with its screenshots
 * fits easily (answers are at most MAX_OUTPUT_TOKENS each); anything bigger
 * would cost far more than a plan's answer is worth.
 */
export const LIMITS = { messages: 100, images: 20, imageChars: 7_000_000, textChars: 200_000 };

/**
 * Room for the thinking as well as the answer (the fast models think a little
 * first, and it counts toward this): at most about $0.008 an answer at the
 * fast models' price, where 4,096 could cut a hard answer short.
 */
const MAX_OUTPUT_TOKENS = 16_000;
const ROLES = ['user', 'assistant'] as const;
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
 * Hosted answers are Juno's answers: the service's own system prompt, the
 * app's (shared/prompts.ts), whatever a request says. A client's own is
 * dropped, so the service's keys never answer to someone else's instructions.
 */
const SYSTEM = systemPrompt('ask');

/**
 * The request, rebuilt from the parts it may have: anything else (other
 * content types, remote image URLs, extra fields) is refused, never passed on.
 */
export function parseAsk(raw: unknown): { vendor: 'anthropic' | 'openai'; model: string; body: AskBody } {
  const body = raw as { model?: unknown; messages?: unknown; ephemeral?: unknown; search?: unknown } | null;
  if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new BadRequest('A model and messages are needed.');
  }
  const [vendor, model] = body.model.split('/') as [string, string | undefined];
  if ((vendor !== 'anthropic' && vendor !== 'openai') || !model || !HOSTED_MODELS[vendor].includes(model)) {
    throw new BadRequest(`Hosted answers can't use ${body.model}.`);
  }
  let images = 0;
  let text = 0;
  const turns = (body.messages as unknown[]).filter((m) => (m as { role?: unknown } | null)?.role !== 'system');
  if (!turns.length) throw new BadRequest('A model and messages are needed.');
  const messages = turns.map((m): ChatMessage => {
    const { role, content } = (m ?? {}) as { role?: unknown; content?: unknown };
    if (!ROLES.includes(role as (typeof ROLES)[number])) throw malformed();
    if (typeof content === 'string') {
      text += content.length;
      return { role: role as ChatMessage['role'], content };
    }
    if (!Array.isArray(content)) throw malformed();
    return {
      role: role as ChatMessage['role'],
      content: content.map((p): ChatPart => {
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
  return {
    vendor,
    model,
    body: {
      model: body.model,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      ...(body.ephemeral === true ? { ephemeral: true } : {}),
      ...(body.search === true ? { search: true } : {}),
    },
  };
}

function base(env: Env, vendor: 'anthropic' | 'openai'): string {
  if (env.AI_GATEWAY_ID) return `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ID}/juno/${vendor}`;
  return vendor === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1';
}

function gatewayHeaders(env: Env): Record<string, string> {
  if (!env.AI_GATEWAY_ID) return {};
  return {
    'cf-aig-collect-log': 'false',
    'cf-aig-skip-cache': 'true',
    // An authenticated gateway takes only requests carrying its token (supabase/README.md, step 5).
    ...(env.AI_GATEWAY_TOKEN ? { 'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}` } : {}),
  };
}

/**
 * One chat's own prompt-cache scope (see the top of this file): the same for
 * every turn of a chat, different for every chat and every student. A hash
 * of who asks and the chat's first question, which a chat never changes;
 * the account id is the service's own, so the vendors can neither reverse
 * it nor link two chats of one student.
 */
export async function cacheScope(userId: string, messages: ChatMessage[]): Promise<string> {
  const first = messages.find((m) => m.role !== 'system');
  const bytes = new TextEncoder().encode(`juno prompt cache\0${userId}\0${JSON.stringify(first?.content ?? '')}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** OpenAI models that refused `prompt_cache_retention: "in_memory"`. */
const NO_MEMORY_ONLY_CACHE = new Set<string>();

/** The messages, the cache scope first: a cached prefix then starts with it. */
export function scoped(messages: ChatMessage[], scope: string): ChatMessage[] {
  return [{ role: 'system', content: `Chat ${scope}.` }, ...messages];
}

/**
 * The vendor's own response: an error to say in the student's terms, or its
 * stream (relay). With `searches`, the model may search the web that many
 * times at most: what was paid for (index.ts).
 */
export async function callVendor(vendor: 'anthropic' | 'openai', model: string, body: AskBody, env: Env, scope: string, searches = 0): Promise<Response> {
  if (vendor === 'openai') {
    const send = (memoryOnly: boolean) =>
      fetch(`${base(env, 'openai')}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}`, ...gatewayHeaders(env) },
        body: JSON.stringify({
          model,
          input: toResponses(scoped(body.messages, scope)),
          max_output_tokens: MAX_OUTPUT_TOKENS,
          store: false,
          stream: true,
          prompt_cache_key: scope,
          ...(memoryOnly ? { prompt_cache_retention: 'in_memory' } : {}),
          ...(searches ? openAISearch(searches) : {}),
        }),
      });
    // A temporary chat asks for the prompt cache to stay in memory, as with
    // the student's own key (byok.ts). A model that refuses (some keep only
    // the 24-hour cache) is asked again without, before anything was
    // streamed; once that works, it isn't asked again while this Worker runs.
    const memoryOnly = !!body.ephemeral && !NO_MEMORY_ONLY_CACHE.has(model);
    const res = await send(memoryOnly);
    if (!memoryOnly || res.status !== 400) return res;
    const retried = await send(false);
    if (retried.ok) NO_MEMORY_ONLY_CACHE.add(model);
    return retried;
  }

  const { system, messages } = toAnthropic(scoped(body.messages, scope));
  return await fetch(`${base(env, 'anthropic')}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      ...gatewayHeaders(env),
    },
    // Low effort: hosted answers are meant to be quick, and ANSWER_COST counts on it.
    body: JSON.stringify({
      model,
      system,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { effort: 'low' },
      ...(SERVER_FALLBACK.has(model) ? { fallbacks: 'default' } : {}),
      ...(searches ? anthropicSearch(searches) : {}),
      stream: true,
    }),
  });
}

/** How a vendor's stream is read (shared/vendors.ts). */
export const readerFor = (vendor: 'anthropic' | 'openai'): AnswerReader => (vendor === 'openai' ? responsesReader() : anthropicReader());

/**
 * The vendor's stream, said again as OpenAI chat chunks: the text (with its
 * sources at the end), a search starting (`searching`, Juno's own), why it
 * stopped early, then usage and [DONE]. `ended` hears how it went once,
 * when the stream ends or the student stops it, to settle what the searches
 * cost.
 */
export function relay(upstream: ReadableStream<Uint8Array>, reader: AnswerReader, ended: (end: Ending) => void): ReadableStream<Uint8Array> {
  const source = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const split = sseSplitter();
  let over = false;
  const end = () => {
    const ending = reader.end();
    if (!over) ended(ending);
    over = true;
    return ending;
  };
  return new ReadableStream<Uint8Array>({
    // Reads until there is something to send: a pull that sends nothing isn't called again.
    async pull(controller) {
      let sent = false;
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`));
        sent = true;
      };
      while (true) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await source.read();
        } catch (err) {
          // The vendor's stream broke: what it did so far is settled all the same.
          end();
          return controller.error(err);
        }
        if (over) return; // stopped by the student meanwhile
        const { value, done } = next;
        if (done) break;
        for (const data of split(decoder.decode(value, { stream: true }))) {
          const step = reader.read(data);
          if (step.searching) send({ choices: [], searching: true });
          if (step.text) send({ choices: [{ index: 0, delta: { content: step.text } }] });
          if (step.error) send({ error: { message: step.error.message ?? 'The AI stopped partway.', type: step.error.type } });
        }
        if (sent) return;
      }
      const { sources, sawText, stop, usage } = end();
      if (sawText && sources) send({ choices: [{ index: 0, delta: { content: sources } }] });
      // Why it stopped, as OpenAI says it: cut off at the limit, or declined by a safeguard.
      if (stop) send({ choices: [{ index: 0, delta: {}, finish_reason: stop === 'length' ? 'length' : 'content_filter' }] });
      send({ choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, prompt_tokens_details: { cached_tokens: usage.cacheRead } } });
      send('[DONE]');
      controller.close();
    },
    async cancel(reason) {
      end();
      await source.cancel(reason);
    },
  });
}
