import { describe, expect, it } from 'vitest';
import {
  CHAT_LIMITS,
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
    // Which mode the bar starts in is not a setting: always Box.
    expect('defaultSelectionKind' in DEFAULT_SETTINGS).toBe(false);
    expect(DEFAULT_SETTINGS.adjustBox).toBe(false);
    // The panel always opens with the first selection; that is not a setting either.
    expect('panelOpen' in DEFAULT_SETTINGS).toBe(false);
    expect(DEFAULT_SETTINGS.provider).toBe('mock');
    expect(DEFAULT_SETTINGS.sendBehavior).toBe('prefill');
  });

  it('starts the question box empty and ships the Explain, Hint, Check and Answer macros', () => {
    // The macros do the asking; the box waits for the student.
    expect(DEFAULT_PROMPT).toBe('');
    expect(DEFAULT_SETTINGS.defaultPrompt).toBe('');
    expect(DEFAULT_SETTINGS.macros.map((m) => m.name)).toEqual(['Explain', 'Hint', 'Check', 'Answer']);
    for (const m of DEFAULT_SETTINGS.macros) expect(m.prompt.length).toBeGreaterThan(10);
    // The hint macro carries its own "do not give it away" instruction now.
    expect(DEFAULT_SETTINGS.macros[1]!.prompt).toMatch(/not the answer/);
  });

  it('ships no model override, keeps ten chats (as few as one), the bar at the bottom and the panel top right', () => {
    expect('showUsage' in DEFAULT_SETTINGS).toBe(false);
    expect('blockedSites' in DEFAULT_SETTINGS).toBe(false);
    expect(DEFAULT_SETTINGS.modelOverride).toBeNull();
    expect(DEFAULT_SETTINGS.chatLimit).toBe(10);
    expect(CHAT_LIMITS).toEqual([1, 5, 10, 25, 50, 100]);
    expect(DEFAULT_SETTINGS.barPlace).toBe('bottom-center');
    expect(DEFAULT_SETTINGS.panelPlace).toBe('top-right');
  });
});

describe('migrateSettings', () => {
  it('fills in everything for a first run', () => {
    expect(migrateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('turns adjusting off for settings saved before it became opt-in', () => {
    const v1 = { adjustBox: true, sendBehavior: 'auto', provider: 'byok' };
    const s = migrateSettings(v1);
    expect(s.adjustBox).toBe(false);
    // Choices that did not change default are kept.
    expect(s.sendBehavior).toBe('auto');
    expect(s.provider).toBe('byok');
    expect(s.version).toBe(SETTINGS_VERSION);
  });

  it('drops settings that no longer exist, and keeps the chat limit to the offered choices', () => {
    const s = migrateSettings({ version: 3, panelOpen: 'on-click', showUsage: true, chatLimit: 50 });
    expect('panelOpen' in s).toBe(false);
    expect('showUsage' in s).toBe(false);
    expect(s.chatLimit).toBe(50);
    expect(migrateSettings({ version: 3, chatLimit: 7 }).chatLimit).toBe(10);
    expect(migrateSettings({ version: 3, chatLimit: '100' }).chatLimit).toBe(10);
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
  it('never sends on its own by default; on auto, every selection goes at once', () => {
    expect(shouldAutoSend(settings())).toBe(false);
    expect(shouldAutoSend(settings({ sendBehavior: 'auto' }))).toBe(true);
  });

  it('turns the old "screenshots only" choice into plain auto: every selection is a screenshot now', () => {
    expect(migrateSettings({ version: 3, sendBehavior: 'auto-box' }).sendBehavior).toBe('auto');
  });
});

describe('answer choice', () => {
  it('is one decision over provider, vendor and model', () => {
    // No one, until the first-run setup.
    expect(answerChoiceOf(DEFAULT_SETTINGS)).toBe('none');
    const sonnet = withAnswerChoice(DEFAULT_SETTINGS, 'anthropic:claude-sonnet-5-5');
    expect([sonnet.provider, sonnet.vendor, sonnet.modelOverride]).toEqual(['byok', 'anthropic', { vendor: 'anthropic', model: 'claude-sonnet-5-5' }]);
    expect(answerChoiceOf(sonnet)).toBe('anthropic:claude-sonnet-5-5');
    const auto = withAnswerChoice(sonnet, 'openai:auto');
    expect([auto.provider, auto.vendor, auto.modelOverride]).toEqual(['byok', 'openai', null]);
    expect(answerChoiceOf(withAnswerChoice(auto, 'local'))).toBe('local');
  });

  it('takes a plan’s model as hosted:<model>, the fast one unless another is picked', () => {
    const plan = withAnswerChoice(DEFAULT_SETTINGS, 'hosted:claude-haiku-5-5');
    expect([plan.provider, plan.vendor, plan.hostedModel]).toEqual(['gateway', 'anthropic', null]);
    expect(answerChoiceOf(plan)).toBe('hosted:claude-haiku-5-5');
    const sol = withAnswerChoice(plan, 'hosted:gpt-6-sol');
    expect([sol.provider, sol.vendor, sol.hostedModel]).toEqual(['gateway', 'openai', 'gpt-6-sol']);
    expect(answerChoiceOf(sol)).toBe('hosted:gpt-6-sol');
  });

  it('falls back to the first macro when there is no default prompt', () => {
    expect(fallbackQuestion(DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS.macros[0]!.prompt);
    expect(fallbackQuestion({ defaultPrompt: 'Solve it.', macros: [] })).toBe('Solve it.');
    expect(fallbackQuestion({ defaultPrompt: '', macros: [] })).toBe('Explain this.');
  });
});

describe('the first-run setup', () => {
  it('is ahead of a new student, and of anyone who only ever had placeholder answers', () => {
    expect(DEFAULT_SETTINGS.setupDone).toBe(false);
    expect(migrateSettings(undefined).setupDone).toBe(false);
    expect(migrateSettings({ version: 5 }).setupDone).toBe(false);
    expect(migrateSettings({ version: 5, provider: 'mock' }).setupDone).toBe(false);
  });

  it('is behind anyone who had picked a real AI, and stays done once done', () => {
    for (const provider of ['byok', 'local', 'gateway'] as const) expect(migrateSettings({ version: 5, provider }).setupDone).toBe(true);
    expect(migrateSettings({ version: 6, provider: 'mock', setupDone: true }).setupDone).toBe(true);
    expect(migrateSettings({ version: 6, provider: 'local', setupDone: false }).setupDone).toBe(false);
  });
});

describe('the first-launch intro', () => {
  it('plays for a new student, but not for anyone set up before there was one, and only once', () => {
    expect(DEFAULT_SETTINGS.introSeen).toBe(false);
    expect(migrateSettings(undefined).introSeen).toBe(false);
    expect(migrateSettings({ version: 6, setupDone: true }).introSeen).toBe(true);
    expect(migrateSettings({ version: 5, provider: 'byok' }).introSeen).toBe(true);
    expect(migrateSettings({ version: 6, setupDone: false, introSeen: true }).introSeen).toBe(true);
  });
});

describe('settings from before v5', () => {
  const v4 = (macros: { id: string; name: string; prompt: string }[]) => ({ version: 4, macros, blockedSites: ['exam.example.edu'] });
  const three = [
    { id: 'explain', name: 'Explain', prompt: 'Explain this step by step.' },
    { id: 'hint', name: 'Hint', prompt: 'Give me a hint for the next step, not the answer.' },
    { id: 'check', name: 'Check', prompt: 'Check my work and point to the first mistake.' },
  ];

  it('gain the Answer macro, unless they have one of their own', () => {
    expect(migrateSettings(v4(three)).macros.map((m) => m.name)).toEqual(['Explain', 'Hint', 'Check', 'Answer']);
    const own = [...three, { id: 'mine', name: 'answer', prompt: 'Just the answer.' }];
    expect(migrateSettings(v4(own)).macros).toHaveLength(4);
    const same = [...three, { id: 'x', name: 'Solve', prompt: 'Provide the answer first and the explanation after.' }];
    expect(migrateSettings(v4(same)).macros.map((m) => m.name)).toEqual(['Explain', 'Hint', 'Check', 'Solve']);
    // Saved again, they are not asked twice.
    const once = migrateSettings(v4(three));
    expect(migrateSettings({ ...once, macros: once.macros.slice(0, 3) }).macros).toHaveLength(3);
  });

  it('lose blocked sites, and get the default places for anything that is not one', () => {
    const s = migrateSettings({ ...v4(three), barPlace: 'sideways', panelPlace: 'bottom-left' });
    expect('blockedSites' in s).toBe(false);
    expect(s.barPlace).toBe('bottom-center');
    expect(s.panelPlace).toBe('bottom-left');
  });
});

describe('settings from before v7', () => {
  it('keep their choice about the cloud (off until turned on, then), start chats saved, and drop a hosted model no plan prices', () => {
    const s = migrateSettings({ version: 6, cloudSync: false, hostedModel: 'constructor' });
    expect(s.cloudSync).toBe(false);
    expect(s.temporaryByDefault).toBe(false);
    expect(s.hostedModel).toBeNull();
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(migrateSettings({ version: 6, cloudSync: true }).cloudSync).toBe(true);
  });

  it('a new install keeps chats in the account; a picked plan model and temporary chats are kept', () => {
    expect(migrateSettings(null).cloudSync).toBe(true);
    const s = migrateSettings({ version: 7, cloudSync: false, hostedModel: 'claude-opus-5-5', temporaryByDefault: true, searchByDefault: true });
    expect([s.cloudSync, s.hostedModel, s.temporaryByDefault, s.searchByDefault]).toEqual([false, 'claude-opus-5-5', true, true]);
    // Web search is off until turned on: each search costs.
    expect(migrateSettings({ version: 7 }).searchByDefault).toBe(false);
    expect(migrateSettings({ version: 7, searchByDefault: 'yes' }).searchByDefault).toBe(false);
  });
});
