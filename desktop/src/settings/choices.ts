/**
 * Who answers, as settings and the first-run setup (Setup.tsx) offer it:
 * one choice, kept as the provider, vendor and model fields (lib/storage.ts).
 */
import type { Settings } from '@/lib/storage';
import type { Vendor } from './KeyField';

export type Choice = 'claude' | 'chatgpt' | 'hosted' | 'local';

export const VENDOR_OF: Partial<Record<Choice, Vendor>> = { claude: 'anthropic', chatgpt: 'openai' };

/** The settings that make `next` the one who answers. */
export function patchFor(next: Choice, settings: Settings): Partial<Settings> {
  const v = VENDOR_OF[next];
  // Coming back to a vendor keeps the model picked for it before.
  if (v) return { provider: 'byok', vendor: v, modelOverride: settings.modelOverride?.vendor === v ? settings.modelOverride : null };
  // Hosted answers use Claude's fast model (shared/models.ts).
  if (next === 'hosted') return { provider: 'gateway', vendor: 'anthropic', modelOverride: null };
  return { provider: 'local' };
}

/** Who answers, as settings show it; null until the student picks. */
export function choiceOf(s: Settings): Choice | null {
  if (s.provider === 'mock') return null;
  if (s.provider === 'local') return 'local';
  if (s.provider === 'byok') return s.vendor === 'openai' ? 'chatgpt' : 'claude';
  return 'hosted';
}
