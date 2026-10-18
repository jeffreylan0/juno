/**
 * Which model answers. Every one of them reads images.
 *
 *  - MODEL_TABLE: the automatic choice with the student's own key, a small
 *    model for text-only asks and a large one for anything with an image.
 *  - HOSTED_MODEL: hosted answers (worker/), one fast model per vendor for
 *    every question, so answers come quickly and a plan costs little to run.
 *    The Worker allows exactly these, so a request can't pick a pricier one.
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
