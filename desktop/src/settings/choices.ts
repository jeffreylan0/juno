/**
 * Who answers, as settings and the first-run setup (Setup.tsx) offer it:
 * one choice, kept as the provider, vendor and model fields (lib/storage.ts).
 */
import type { KeyStatus, KeyVendor as Vendor } from '@/lib/providers/types';
import { hostedModelOf, withAnswerChoice, type Settings } from '@/lib/storage';

/** Your own API key (Anthropic's or OpenAI's), hosted answers, or a local model. */
export type Choice = 'key' | 'hosted' | 'local';

/** The settings that make `next` the one who answers. */
export function patchFor(next: Choice, settings: Settings, keys: KeyStatus): Partial<Settings> {
  if (next === 'key') {
    // The company whose key there is, the one picked before first.
    const vendor: Vendor = keys[settings.vendor] ? settings.vendor : keys.anthropic ? 'anthropic' : keys.openai ? 'openai' : settings.vendor;
    return keyPatch(vendor, settings);
  }
  if (next === 'local') return { provider: 'local' };
  // Only the fields hosted answers set, so nothing newer stored meanwhile is undone.
  const { provider, vendor, hostedModel } = withAnswerChoice(settings, `hosted:${hostedModelOf(settings)}`);
  return { provider, vendor, hostedModel };
}

/** Answers from `vendor`, with your key; coming back to it keeps the model picked for it before. */
export function keyPatch(vendor: Vendor, settings: Settings): Partial<Settings> {
  return { provider: 'byok', vendor, modelOverride: settings.modelOverride?.vendor === vendor ? settings.modelOverride : null };
}

/** Who answers, as settings show it; null until the student picks. */
export function choiceOf(s: Settings): Choice | null {
  if (s.provider === 'mock') return null;
  if (s.provider === 'local') return 'local';
  if (s.provider === 'byok') return 'key';
  return 'hosted';
}
