import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  answerChoiceOf,
  fallbackQuestion,
  migrateSettings,
  sanitizeMacros,
  shouldAutoSend,
  withAnswerChoice,
  type Settings,
} from '@/lib/storage';
import { DEFAULT_MACROS, DEFAULT_PROMPT } from '@shared/prompts';

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('settings defaults', () => {
  it('arms a box that goes to the panel on release, costs nothing, and waits before sending', () => {
    expect(DEFAULT_SETTINGS.defaultSelectionKind).toBe('box');
    expect(DEFAULT_SETTINGS.adjustBox).toBe(false);
    expect(DEFAULT_SETTINGS.panelOpen).toBe('on-selection');
    expect(DEFAULT_SETTINGS.provider).toBe('mock');
    expect(DEFAULT_SETTINGS.sendBehavior).toBe('prefill');
  });

  it('starts the question box empty and ships the Explain, Hint and Check macros', () => {
    // The macros do the asking; the box waits for the student.
    expect(DEFAULT_PROMPT).toBe('');
    expect(DEFAULT_SETTINGS.defaultPrompt).toBe('');
    expect(DEFAULT_SETTINGS.macros.map((m) => m.name)).toEqual(['Explain', 'Hint', 'Check']);
    for (const m of DEFAULT_SETTINGS.macros) expect(m.prompt.length).toBeGreaterThan(10);
    // The hint macro carries its own "do not give it away" instruction now.
    expect(DEFAULT_SETTINGS.macros[1]!.prompt).toMatch(/not the answer/);
  });

  it('hides token counts from students and ships no keys or blocked sites', () => {
    expect(DEFAULT_SETTINGS.showUsage).toBe(false);
    expect(DEFAULT_SETTINGS.modelOverride).toBeNull();
    expect(DEFAULT_SETTINGS.blockedSites).toEqual([]);
  });
});

describe('migrateSettings', () => {
  it('fills in everything for a first run', () => {
    expect(migrateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('turns adjusting off for settings saved before it became opt-in', () => {
    const v1 = { adjustBox: true, panelOpen: 'on-click', provider: 'byok' };
    const s = migrateSettings(v1);
    expect(s.adjustBox).toBe(false);
    // Choices that did not change default are kept.
    expect(s.panelOpen).toBe('on-click');
    expect(s.provider).toBe('byok');
    expect(s.version).toBe(SETTINGS_VERSION);
  });

  it('keeps a customised old per-mode prompt in the macro of the same name', () => {
    const v1 = {
      defaultMode: 'hint',
      prompts: { explain: 'Explain this step by step, then give the final answer.', hint: 'Nudge me, gently.', check: 'x' },
    };
    const s = migrateSettings(v1);
    expect(s.macros.find((m) => m.id === 'explain')!.prompt).toBe(DEFAULT_MACROS[0]!.prompt);
    expect(s.macros.find((m) => m.id === 'hint')!.prompt).toBe('Nudge me, gently.');
    expect('prompts' in s).toBe(false);
    expect('defaultMode' in s).toBe(false);
  });

  it('empties the box for anyone who still had the old prefilled prompt, but keeps their own', () => {
    expect(migrateSettings({ version: 2, defaultPrompt: 'Explain this step by step.' }).defaultPrompt).toBe('');
    expect(migrateSettings({ version: 2, defaultPrompt: 'Solve it.' }).defaultPrompt).toBe('Solve it.');
  });

  it('drops the hosted-plan URL, which is a build setting now', () => {
    expect('gatewayUrl' in migrateSettings({ version: 2, gatewayUrl: 'https://x' })).toBe(false);
  });

  it('respects a later choice to turn adjusting back on', () => {
    expect(migrateSettings({ version: SETTINGS_VERSION, adjustBox: true }).adjustBox).toBe(true);
  });
});

describe('sanitizeMacros', () => {
  it('drops malformed entries and de-duplicates ids', () => {
    const out = sanitizeMacros([
      { id: 'a', name: 'A', prompt: 'one' },
      { id: 'a', name: 'B', prompt: 'two' },
      { name: 'Plain English', prompt: 'three' },
      { name: 3, prompt: 'bad' },
      null,
    ]);
    expect(out.map((m) => m.id)).toEqual(['a', 'a-2', 'plain-english']);
  });

  it('falls back to the shipped macros when the stored value is not a list', () => {
    expect(sanitizeMacros('nope')).toEqual(DEFAULT_MACROS);
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

  it('sends only screenshots on auto-box: box, freeform and element, not text', () => {
    const s = settings({ sendBehavior: 'auto-box' });
    expect(shouldAutoSend(s, 'box')).toBe(true);
    expect(shouldAutoSend(s, 'freeform')).toBe(true);
    expect(shouldAutoSend(s, 'element')).toBe(true);
    expect(shouldAutoSend(s, 'text')).toBe(false);
  });
});

describe('answer choice', () => {
  it('is one decision over provider, vendor and model', () => {
    expect(answerChoiceOf(DEFAULT_SETTINGS)).toBe('placeholder');
    const sonnet = withAnswerChoice(DEFAULT_SETTINGS, 'anthropic:claude-sonnet-5-5');
    expect([sonnet.provider, sonnet.vendor, sonnet.modelOverride]).toEqual(['byok', 'anthropic', { vendor: 'anthropic', model: 'claude-sonnet-5-5' }]);
    expect(answerChoiceOf(sonnet)).toBe('anthropic:claude-sonnet-5-5');
    const auto = withAnswerChoice(sonnet, 'openai:auto');
    expect([auto.provider, auto.vendor, auto.modelOverride]).toEqual(['byok', 'openai', null]);
    expect(answerChoiceOf(withAnswerChoice(auto, 'local'))).toBe('local');
  });

  it('falls back to the first macro when there is no default prompt', () => {
    expect(fallbackQuestion(DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS.macros[0]!.prompt);
    expect(fallbackQuestion({ defaultPrompt: 'Solve it.', macros: [] })).toBe('Solve it.');
    expect(fallbackQuestion({ defaultPrompt: '', macros: [] })).toBe('Explain this.');
  });
});
