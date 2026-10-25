/**
 * Which model answers. Every one of them reads images.
 *
 *  - MODEL_TABLE: the automatic choice with the student's own key, a small
 *    model for text-only asks and a large one for anything with an image.
 *  - HOSTED_MODEL: hosted answers' own pick (worker/), the fast model of
 *    each vendor, until the student picks another (ANSWER_COST).
 */
import type { Route, Vendor } from './payload';

export const MODEL_TABLE: Record<Exclude<Vendor, 'local' | 'mock'>, Record<Route, string>> = {
  anthropic: { small: 'claude-haiku-5-5', large: 'claude-sonnet-5-5' },
  openai: { small: 'gpt-6-luna', large: 'gpt-6-sol' },
};

export const HOSTED_MODEL: Record<Exclude<Vendor, 'local' | 'mock'>, string> = {
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-6-luna',
};

/**
 * Hosted answers by model: what one answer takes from a plan's monthly
 * allowance, counted in answers from the fast models. The others cost more
 * to run, in proportion and with some room (README.md, Plans: a 3,000-token
 * question with its screenshot, and the thinking and answer each model
 * gives at low effort), so an allowance pays for itself whichever models a
 * student picks. The Worker allows exactly these.
 */
export const ANSWER_COST: Record<string, number> = {
  'claude-haiku-5-5': 1,
  'claude-sonnet-5-5': 30,
  'claude-opus-5-5': 65,
  'claude-fable-5-1': 190,
  'gpt-6-luna': 1,
  'gpt-6-sol': 30,
  'gpt-6-astra': 190,
};

/**
 * What each web search adds to a hosted answer, in the same fast-model
 * answers: the search itself ($10 per 1,000 at either company) and the pages
 * it reads into the question (about 20,000 tokens at the model's input
 * price), with some room (README.md, Plans). An answer that may search takes
 * one search up front; the Worker gives it back if none was made and takes
 * each further one (up to vendors.ts MAX_SEARCHES) once the answer is done.
 */
export const SEARCH_COST: Record<string, number> = {
  'claude-haiku-5-5': 25,
  'claude-sonnet-5-5': 95,
  'claude-opus-5-5': 170,
  'claude-fable-5-1': 390,
  'gpt-6-luna': 25,
  'gpt-6-sol': 95,
  'gpt-6-astra': 390,
};

/** Whose model an id is. */
export const vendorOf = (model: string): Exclude<Vendor, 'local' | 'mock'> => (model.startsWith('gpt-') ? 'openai' : 'anthropic');

/** Answers of `model` that `units` of an allowance pay for. */
export const answersLeft = (units: number, model: string): number => Math.floor(Math.max(0, units) / (ANSWER_COST[model] ?? 1));

/**
 * Claude models whose safeguards can decline a question (a biology problem
 * can look like research they won't help with): asked with `fallbacks:
 * "default"`, Anthropic answers a declined question with the model it
 * recommends instead, in the same request. Haiku has no fallback to go to.
 */
export const SERVER_FALLBACK: ReadonlySet<string> = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']);
