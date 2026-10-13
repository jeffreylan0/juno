/**
 * The models each vendor's automatic choice uses: a small one for text-only
 * asks, a large one for anything with an image. Checked against the vendors'
 * model pages on 2026-09-28; every one of them reads images.
 *
 * Hosted answers (worker/) may use exactly these and nothing else, so a
 * request can't pick a pricier model than the apps would.
 */
import type { Route, Vendor } from './payload';

export const MODEL_TABLE: Record<Exclude<Vendor, 'local' | 'mock'>, Record<Route, string>> = {
  anthropic: { small: 'claude-haiku-4-5-20251001', large: 'claude-sonnet-5-5' },
  openai: { small: 'gpt-6-luna', large: 'gpt-6-sol' },
};
