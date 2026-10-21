/**
 * Who answers, as the panel and settings offer it (ui/ModelPicker.tsx): a
 * plan's models with the answers each has left, a key's, a local model,
 * and what isn't set up greyed. And what a plan's answers cost by model
 * (shared/models.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { ANSWER_COST, answersLeft } from '@shared/models';
import type { Entitlement } from '@/lib/account/session';
import { DEFAULT_SETTINGS, withAnswerChoice, type Settings } from '@/lib/storage';
import { answerGroups, unitsLeft } from '@/ui/ModelPicker';
import type { AccountState } from '@/ui/useAccount';

vi.mock('@/lib/account/config', async (real) => ({ ...(await real<typeof import('@/lib/account/config')>()), ACCOUNTS: true }));

const guest: AccountState = { ready: true, user: null, entitlement: null, sync: { state: 'off' } };
const plus = (used: number): AccountState => ({
  ready: true,
  user: { id: 'u', email: 'a@example.com' },
  entitlement: { plan: 'plus', planName: 'Plus', cloud: true, quota: 1500, used, billing: null, customer: false, checkedAt: 0 } as Entitlement,
  sync: { state: 'off' },
});
const noKeys = { anthropic: null, openai: null };
const enabled = (settings: Settings, keys = noKeys, account = guest) =>
  answerGroups(settings, keys, account).map((g) => [g.label, g.options.filter((o) => !o.disabled).map((o) => o.value)]);

describe('what a plan’s answers cost', () => {
  it('counts each model in fast-model answers, so an allowance pays for itself whichever is picked', () => {
    expect(ANSWER_COST['claude-haiku-5-5']).toBe(1);
    expect(answersLeft(1500, 'claude-haiku-5-5')).toBe(1500);
    expect(answersLeft(1500, 'claude-sonnet-5-5')).toBe(50);
    expect(answersLeft(1500, 'claude-opus-5-5')).toBe(23);
    expect(answersLeft(1500, 'gpt-6-astra')).toBe(7);
    expect(answersLeft(29, 'gpt-6-sol')).toBe(0);
    expect(answersLeft(-5, 'gpt-6-luna')).toBe(0);
  });
});

describe('the answer picker', () => {
  it('greys everything until something is set up', () => {
    expect(enabled(DEFAULT_SETTINGS)).toEqual([
      ['Plan', []],
      ['API key', []],
      ['Local model', []],
    ]);
  });

  it('offers a plan’s models with the answers each has left, greying any that has none', () => {
    const account = plus(1500 - 40);
    expect(unitsLeft(account)).toBe(40);
    const [planGroup] = answerGroups(DEFAULT_SETTINGS, noKeys, account);
    const haiku = planGroup!.options.find((o) => o.value === 'hosted:claude-haiku-5-5')!;
    const sonnet = planGroup!.options.find((o) => o.value === 'hosted:claude-sonnet-5-5')!;
    const opus = planGroup!.options.find((o) => o.value === 'hosted:claude-opus-5-5')!;
    expect([haiku.label, haiku.disabled]).toEqual(['Claude Haiku 5.5 · 40 left', false]);
    expect([sonnet.label, sonnet.disabled]).toEqual(['Claude Sonnet 5.5 · 1 left', false]);
    expect(opus.disabled).toBe(true);
    expect(unitsLeft(guest)).toBeNull();
  });

  it('offers a key’s models only for the key there is, and a local model once one is set up', () => {
    const keyed = enabled(DEFAULT_SETTINGS, { anthropic: 'sk-ant-…', openai: null });
    expect(keyed[1]![1]).toContain('anthropic:auto');
    expect(keyed[1]![1]).not.toContain('openai:auto');
    const local = { ...DEFAULT_SETTINGS, localModel: 'qwen3-vl' };
    expect(enabled(local)[2]).toEqual(['Local model', ['local']]);
  });

  it('marks a choice whose key is gone as not set up (the list still shows it, picked)', () => {
    const picked = withAnswerChoice(DEFAULT_SETTINGS, 'anthropic:claude-opus-5-5');
    const [, keyGroup] = answerGroups(picked, noKeys, guest);
    expect(keyGroup!.options.find((o) => o.value === 'anthropic:claude-opus-5-5')?.disabled).toBe(true);
  });
});
