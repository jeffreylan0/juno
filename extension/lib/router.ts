/**
 * Route decision and the model table.
 * Text-only, single-step asks go to a small model; anything with an image, or
 * multi-step reasoning (Check mode, long derivations), goes to a large one.
 */
import type { ModelRef, Part, Plan, Route, Vendor } from '@shared/payload';

export const MODEL_TABLE: Record<Exclude<Vendor, 'local' | 'mock'>, Record<Route, string>> = {
  anthropic: { small: 'claude-haiku-4-5-20251001', large: 'claude-sonnet-5' },
  openai: { small: 'gpt-6-luna', large: 'gpt-6-sol' },
};

/** USD per million tokens (input, output); public list prices, September 2026. */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-6-sol': { input: 2, output: 10 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
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
