/**
 * Talking to Anthropic and OpenAI, once for both places that do it: the app
 * with the student's own key (desktop/src/lib/providers/byok.ts) and the
 * Worker for hosted answers (worker/src/models.ts). What each sends (an
 * OpenAI-shaped chat turned into Anthropic's Messages or OpenAI's
 * Responses), and how each reads the answer that streams back: Anthropic's
 * events and OpenAI's alike come out as the same steps (text, a web search
 * starting, an error) and end the same way (why it stopped, what it used,
 * the sources it cited).
 *
 * Web search: both companies require what an answer drew from the web to be
 * shown with it, clickable. Claude's citations come apart from its text, so
 * each passage it cites is followed by numbered links ([1]); OpenAI writes
 * its links into the text itself. Either way the answer ends with its
 * sources as a numbered Markdown list: part of the answer, copied and sent
 * back with it like any other text (the search results themselves never
 * are, so a later question doesn't pay to read them again).
 */

/** The OpenAI chat shape the app builds a conversation in (providers/openai-compat.ts). */
export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } };
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatPart[];
}

/** The most web searches one answer may make: each costs (models.ts, SEARCH_COST). */
export const MAX_SEARCHES = 3;

/** Anthropic's web search tool (basic: every model has it), for at most `n` searches. It takes queries only: it opens no address it is given. */
export const anthropicSearch = (n = MAX_SEARCHES) => ({ tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: n }] });

/**
 * OpenAI's (Responses), for at most `n` searches. From its index only
 * (`external_web_access: false`): it could otherwise open any address the
 * model names, and text planted on screen could name one carrying the chat.
 */
export const openAISearch = (n = MAX_SEARCHES) => ({ tools: [{ type: 'web_search', external_web_access: false }], max_tool_calls: n });

type CacheControl = { type: 'ephemeral' };
type AnthropicBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: CacheControl };
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

const textOf = (c: ChatMessage['content']) => (typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join('\n'));

/**
 * A chat as Anthropic takes it: the system prompt apart, images as base64
 * blocks (only screenshots inline; never a URL Anthropic would fetch), and a
 * prompt-cache breakpoint on the latest question. A conversation is one
 * growing prefix (system, the screenshot, the turns), so each follow-up
 * reads everything before it from the cache at a tenth of the price; below
 * the model's minimum the mark is ignored.
 */
export function toAnthropic(input: readonly ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system = input.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const messages = input
    .filter((m) => m.role !== 'system')
    .map((m): AnthropicMessage => {
      const role = m.role as AnthropicMessage['role'];
      if (typeof m.content === 'string') return { role, content: m.content };
      const blocks = m.content.flatMap((p): AnthropicBlock[] => {
        if (p.type === 'text') return [{ type: 'text', text: p.text }];
        const match = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url.url);
        return match ? [{ type: 'image', source: { type: 'base64', media_type: match[1]!, data: match[2]! } }] : [];
      });
      return { role, content: blocks };
    });
  const last = messages.at(-1);
  if (last?.role === 'user') {
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
    else if (last.content.length) last.content[last.content.length - 1]!.cache_control = { type: 'ephemeral' };
  }
  return { system, messages };
}

type ResponsesPart = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: string };
interface ResponsesInput {
  role: 'system' | 'user' | 'assistant';
  content: string | ResponsesPart[];
}

/** A chat as OpenAI's Responses API takes it: the same turns, its own names for the parts. */
export function toResponses(messages: readonly ChatMessage[]): ResponsesInput[] {
  return messages.map((m) => {
    if (typeof m.content === 'string' || m.role === 'assistant') return { role: m.role, content: textOf(m.content) };
    return {
      role: m.role,
      content: m.content.map((p): ResponsesPart =>
        p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: p.image_url.url, detail: p.image_url.detail ?? 'auto' },
      ),
    };
  });
}

/** Splits a text/event-stream into its events' data as the bytes arrive (fed decoded text, in any pieces). */
export function sseSplitter(): (text: string) => string[] {
  let buffer = '';
  return (text) => {
    buffer += text;
    const out: string[] = [];
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) out.push(data);
    }
    return out;
  };
}

/** What one event adds to an answer. */
interface Step {
  text?: string;
  /** A web search began. */
  searching?: true;
  error?: { type?: string; message?: string };
}

/** How an answer ended. */
export interface Ending {
  /** The sources it cited, as a Markdown list to end it with; '' for none. */
  sources: string;
  /** Cut off at the length limit, or declined by a safeguard; absent: it finished. */
  stop?: 'length' | 'refusal';
  /** Why a safeguard declined (Anthropic's stop_details). */
  category?: string | null;
  /** Whether any of the answer itself came (not only the marks and sources added to it). */
  sawText: boolean;
  /** Web searches made, as the company counts them for its bill. */
  searches: number;
  /** Tokens: every input token (cached or not), what was read from and written to the cache, and the output. */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface AnswerReader {
  /** What one event's data adds to the answer. */
  read(data: string): Step;
  /** After the last event. */
  end(): Ending;
}

function parse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/** The web pages an answer cited, numbered in the order first cited. */
function sourceList() {
  const urls: string[] = [];
  const titles: string[] = [];
  return {
    /** The page's number, from 1; 0 for anything that isn't a web page's address. */
    number(url: unknown, title: unknown): number {
      const href = webAddress(url);
      if (!href) return 0;
      let i = urls.indexOf(href);
      if (i < 0) i = urls.push(href) - 1;
      titles[i] ||= plainTitle(title) || plainTitle(new URL(href).hostname);
      return i + 1;
    },
    /** Numbered links to some of them ([1]), to follow the passage that cites them. */
    marks(numbers: Iterable<number>): string {
      return [...numbers].map((n) => ` [&#91;${n}&#93;](<${urls[n - 1]}>)`).join('');
    },
    list(): string {
      if (!urls.length) return '';
      return `\n\n**Sources**\n\n${urls.map((u, i) => `${i + 1}. [${titles[i]}](<${u}>)`).join('\n')}\n`;
    },
  };
}

/**
 * A web page's address, safe inside a Markdown link: http(s) only, as the
 * URL parser writes it (no spaces, `<` or `>`), with `$` and `\` encoded so
 * the answer's maths ($…$, \(…\), \[…\]: lib/render.ts) never starts
 * inside a link.
 */
function webAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return url.href.replace(/\$/g, '%24').replace(/\\/g, '%5C');
  } catch {
    return null;
  }
}

/**
 * A page's title as plain text in Markdown: one line, not too long, and
 * every character Markdown or the maths could read as syntax written as a
 * character reference, which both leave as text.
 */
function plainTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const line = raw.replace(/\s+/g, ' ').trim();
  const short = line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line;
  return short.replace(/[\\`*_[\]<>()#|~&!$]/g, (c) => `&#${c.charCodeAt(0)};`);
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: { type?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    citation?: { url?: unknown; title?: unknown };
    stop_reason?: string | null;
    stop_details?: { category?: string | null } | null;
  };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

/**
 * Reads Anthropic's Messages events. Usage comes at the start and again,
 * added up, at the end (with what the searches brought in); `input_tokens`
 * counts only what came after the last cache breakpoint, the cached share
 * apart.
 */
export function anthropicReader(): AnswerReader {
  const sources = sourceList();
  /** Sources cited by each text block still streaming, by its index. */
  const cited = new Map<number, Set<number>>();
  let plain = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let output = 0;
  let started = 0;
  let billed: number | undefined;
  let sawText = false;
  let stop: string | null | undefined;
  let category: string | null | undefined;
  const take = (u: AnthropicUsage | undefined) => {
    plain = u?.input_tokens ?? plain;
    cacheWrite = u?.cache_creation_input_tokens ?? cacheWrite;
    cacheRead = u?.cache_read_input_tokens ?? cacheRead;
    output = u?.output_tokens ?? output;
    billed = u?.server_tool_use?.web_search_requests ?? billed;
  };
  return {
    read(data) {
      const ev = parse<AnthropicEvent>(data);
      switch (ev?.type) {
        case 'message_start':
          take(ev.message?.usage);
          break;
        case 'content_block_start':
          if (ev.content_block?.type === 'server_tool_use' && ev.content_block.name === 'web_search') {
            started += 1;
            return { searching: true };
          }
          break;
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            sawText = true;
            return { text: ev.delta.text };
          }
          if (ev.delta?.type === 'citations_delta' && ev.index !== undefined) {
            const n = sources.number(ev.delta.citation?.url, ev.delta.citation?.title);
            if (n) cited.set(ev.index, (cited.get(ev.index) ?? new Set()).add(n));
          }
          break;
        case 'content_block_stop': {
          const numbers = ev.index !== undefined ? cited.get(ev.index) : undefined;
          if (numbers) {
            cited.delete(ev.index!);
            return { text: sources.marks(numbers) };
          }
          break;
        }
        case 'message_delta':
          take(ev.usage);
          stop = ev.delta?.stop_reason ?? stop;
          category = ev.delta?.stop_details?.category ?? category;
          break;
        case 'error':
          return { error: ev.error ?? {} };
      }
      return {};
    },
    end: () => ({
      sources: sources.list(),
      stop: stop === 'max_tokens' ? 'length' : stop === 'refusal' ? 'refusal' : undefined,
      category,
      sawText,
      // A search that failed isn't billed; the count at the end says so.
      searches: billed ?? started,
      usage: { input: plain + cacheWrite + cacheRead, output, cacheRead, cacheWrite },
    }),
  };
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  annotation?: { type?: string; url?: unknown; title?: unknown };
  item?: { type?: string };
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    incomplete_details?: { reason?: string } | null;
    error?: { code?: string; message?: string } | null;
  };
  code?: string | null;
  message?: string;
}

/**
 * Reads OpenAI's Responses events. A refusal comes as text of its own and is
 * shown as the answer, as the chat API's was.
 */
export function responsesReader(): AnswerReader {
  const sources = sourceList();
  let sawText = false;
  let searches = 0;
  let stop: Ending['stop'];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    read(data) {
      const ev = parse<ResponsesEvent>(data);
      switch (ev?.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          if (ev.delta) {
            sawText = true;
            return { text: ev.delta };
          }
          break;
        case 'response.output_text.annotation.added':
          if (ev.annotation?.type === 'url_citation') sources.number(ev.annotation.url, ev.annotation.title);
          break;
        case 'response.output_item.added':
          if (ev.item?.type === 'web_search_call') return { searching: true };
          break;
        case 'response.output_item.done':
          // Every call counts (max_tool_calls caps them all): a search, or opening a page it found.
          if (ev.item?.type === 'web_search_call') searches += 1;
          break;
        case 'response.completed':
        case 'response.incomplete': {
          const u = ev.response?.usage;
          usage.input = u?.input_tokens ?? usage.input;
          usage.output = u?.output_tokens ?? usage.output;
          usage.cacheRead = u?.input_tokens_details?.cached_tokens ?? usage.cacheRead;
          const reason = ev.response?.incomplete_details?.reason;
          stop = reason === 'max_output_tokens' ? 'length' : reason === 'content_filter' ? 'refusal' : stop;
          break;
        }
        case 'response.failed':
          return { error: { type: ev.response?.error?.code, message: ev.response?.error?.message } };
        case 'error':
          return { error: { type: ev.code ?? undefined, message: ev.message } };
      }
      return {};
    },
    end: () => ({ sources: sources.list(), stop, sawText, searches, usage: { ...usage } }),
  };
}
