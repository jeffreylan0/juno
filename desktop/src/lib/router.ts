/**
 * Route decision and the model table. Anything with an image (every
 * selection: they are screenshots), or multi-step reasoning, goes to a large
 * model; text-only asks go to a small one, which only the eval's experiments
 * and chats saved by earlier versions (text selections) still make.
 */
import { MODEL_TABLE } from '@shared/models';
import type { ModelRef, Part, Plan, Route } from '@shared/payload';

/** The automatic choice's models (shared with the Worker, which allows only these). */
export { MODEL_TABLE };

/**
 * The models offered in the panel's picker, cheapest first. Any other model a
 * key can use is available in settings after a key check.
 */
export const MAJOR_MODELS: Record<'anthropic' | 'openai', string[]> = {
  anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'],
  openai: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'],
};

/**
 * Short names for the panel's picker, which shares a row with the macros in
 * a side panel that can be ~340 px wide. The vendor is the option group.
 */
export const SHORT_NAMES: Record<string, string> = {
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-6-sol': 'GPT-6 Sol',
  'gpt-6-astra': 'GPT-6 Astra',
};

/** Friendly names for the model table, used where the student sees a choice. */
export const MODEL_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(SHORT_NAMES).map(([id, name]) => [id, id.startsWith('claude-') ? `Claude ${name}` : name]),
);

/** How students know each vendor: by its assistant ("No Claude API key yet"), and by its company (keys, errors). */
export const ASSISTANT = { anthropic: 'Claude', openai: 'ChatGPT' } as const;
export const COMPANY = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;

/**
 * USD per million tokens; public list prices, September 2026. `cacheRead` is
 * the multiplier on input for prompt-cache hits (Anthropic writes cost 1.25×).
 */
export const PRICES: Record<string, { input: number; output: number; cacheRead?: number }> = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.1 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.1 },
  'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.1 },
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 0.1 },
};

/** Anthropic charges 1.25× input for a five-minute cache write. */
const CACHE_WRITE = 1.25;

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache: { read?: number; write?: number } = {},
): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  const read = cache.read ?? 0;
  const write = cache.write ?? 0;
  // `inputTokens` is the total; the cached share is billed at its own rate.
  const plain = Math.max(0, inputTokens - read - write);
  const input = plain * p.input + read * p.input * (p.cacheRead ?? 1) + write * p.input * CACHE_WRITE;
  return (input + outputTokens * p.output) / 1e6;
}

const LONG_TEXT_CHARS = 1500;

export function needsLargeModel(plan: Pick<Plan, 'parts' | 'mode' | 'question'>): boolean {
  if (plan.parts.some((p: Part) => p.kind === 'image')) return true;
  if (plan.mode === 'check') return true;
  const chars = plan.parts.reduce((n, p) => n + partLength(p), 0);
  if (chars > LONG_TEXT_CHARS) return true;
  const q = (plan.question ?? '').toLowerCase();
  if (/\b(prove|derive|why does|step by step|show that)\b/.test(q)) return true;
  return false;
}

function partLength(p: Part): number {
  switch (p.kind) {
    case 'text':
      return p.text.length;
    case 'latex':
      return p.latex.length;
    case 'table':
      return p.markdown.length;
    case 'code':
      return p.code.length;
    case 'image':
      return 0;
  }
}

export function chooseRoute(plan: Pick<Plan, 'parts' | 'mode' | 'question'>): Route {
  return needsLargeModel(plan) ? 'large' : 'small';
}

export function modelFor(vendor: 'anthropic' | 'openai', route: Route): ModelRef {
  return { vendor, model: MODEL_TABLE[vendor][route] };
}
