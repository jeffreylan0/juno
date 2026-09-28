/**
 * Settings and keys. Uses browser.storage.local via WXT's `storage` helper.
 * Text-only history lives here too (week 7); images are never persisted, which
 * keeps the store well under Safari's 5 MB cap.
 */
import { storage } from '#imports';
import type { ModelRef, Provider } from '@shared/payload';

export interface Settings {
  provider: Provider;
  defaultMode: 'explain' | 'hint' | 'check';
  /** Preferred vendor for the router's model table. */
  vendor: 'anthropic' | 'openai';
  /** Explicit model override; empty means "let the router choose". */
  modelOverride: ModelRef | null;
  /** Hostnames where the shortcut does nothing (exams, private portals). */
  blockedSites: string[];
  localBaseUrl: string;
  localModel: string;
  gatewayUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: (import.meta.env.WXT_PROVIDER as Provider | undefined) ?? 'mock',
  defaultMode: 'explain',
  vendor: 'anthropic',
  modelOverride: null,
  blockedSites: [],
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: 'qwen2.5vl:7b',
  gatewayUrl: (import.meta.env.WXT_GATEWAY_URL as string | undefined) ?? 'http://localhost:8787',
};

export interface Keys {
  anthropic: string;
  openai: string;
  /** Hosted-plan session token (Supabase), week 9. */
  session: string;
}

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

export const keysItem = storage.defineItem<Keys>('local:keys', {
  fallback: { anthropic: '', openai: '', session: '' },
});

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await settingsItem.getValue()) };
}

export async function getKeys(): Promise<Keys> {
  return await keysItem.getValue();
}
