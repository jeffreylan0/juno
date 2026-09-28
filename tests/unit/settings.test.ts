import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, shouldAutoSend, type Settings } from '@/lib/storage';
import { DEFAULT_PROMPTS } from '@shared/prompts';
import { MODES } from '@shared/payload';

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('settings defaults', () => {
  it('arms a box selection, costs nothing, and waits before sending', () => {
    expect(DEFAULT_SETTINGS.defaultSelectionKind).toBe('box');
    expect(DEFAULT_SETTINGS.provider).toBe('mock');
    expect(DEFAULT_SETTINGS.defaultMode).toBe('explain');
    expect(DEFAULT_SETTINGS.sendBehavior).toBe('prefill');
  });

  it('ships a prompt for every mode', () => {
    for (const mode of MODES) {
      expect(DEFAULT_SETTINGS.prompts[mode], mode).toBe(DEFAULT_PROMPTS[mode]);
      expect(DEFAULT_SETTINGS.prompts[mode]!.length).toBeGreaterThan(10);
    }
  });

  it('ships no keys and blocks no sites until the user says so', () => {
    expect(DEFAULT_SETTINGS.modelOverride).toBeNull();
    expect(DEFAULT_SETTINGS.blockedSites).toEqual([]);
  });
});

describe('shouldAutoSend', () => {
  it('never sends on its own by default', () => {
    expect(shouldAutoSend(settings(), 'box')).toBe(false);
    expect(shouldAutoSend(settings(), 'text')).toBe(false);
  });

  it('sends every selection on auto', () => {
    const s = settings({ sendBehavior: 'auto' });
    expect(shouldAutoSend(s, 'box')).toBe(true);
    expect(shouldAutoSend(s, 'text')).toBe(true);
  });

  it('sends only screenshots on auto-box', () => {
    const s = settings({ sendBehavior: 'auto-box' });
    expect(shouldAutoSend(s, 'box')).toBe(true);
    expect(shouldAutoSend(s, 'text')).toBe(false);
    expect(shouldAutoSend(s, 'element')).toBe(false);
  });
});
