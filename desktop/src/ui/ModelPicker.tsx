/**
 * Who answers, and with which model: one list, in the panel beside Send
 * (ModelPicker) and in Settings → Answers (ModelSelect), both writing the
 * same settings, so each follows the other. Grouped as the student sets
 * them up: the plan's models (each with the answers left this month for
 * it: shared/models.ts ANSWER_COST), an API key's, a local model. What isn't
 * set up yet is greyed; with nothing set up at all, the panel says so
 * instead of offering a list of greyed choices.
 */
import { useEffect, useState } from 'react';
import { ANSWER_COST, answersLeft } from '@shared/models';
import { ACCOUNTS } from '@/lib/account/config';
import type { KeyModel } from '@/lib/providers/byok';
import type { KeyStatus } from '@/lib/providers/types';
import { ASSISTANT, MAJOR_MODELS, MODEL_NAMES, MODEL_TABLE, SHORT_NAMES } from '@/lib/router';
import { answerChoiceOf, localSetUp, settingsItem, withAnswerChoice, type AnswerChoice, type Settings } from '@/lib/storage';
import { Icon } from './icons';
import { useAccount, type AccountState } from './useAccount';

type Vendor = 'anthropic' | 'openai';
type Listed = Partial<Record<Vendor, KeyModel[]>>;

interface Option {
  value: AnswerChoice;
  label: string;
  title?: string;
  disabled: boolean;
}

interface Group {
  label: string;
  options: Option[];
}

/** This month's hosted answers left, in fast-model answers; null without a plan that has them. */
export function unitsLeft(account: AccountState): number | null {
  const ent = account.user ? account.entitlement : null;
  return ent && ent.quota > 0 ? Math.max(0, ent.quota - ent.used) : null;
}

/** The choices, grouped: the plan's models, a key's, a local model. */
export function answerGroups(settings: Settings, keys: KeyStatus | null, account: AccountState, listed: Listed = {}): Group[] {
  const value = answerChoiceOf(settings);
  const groups: Group[] = [];
  if (ACCOUNTS) {
    const units = unitsLeft(account);
    groups.push({
      label: 'Plan',
      options: Object.keys(ANSWER_COST).map((model) => {
        const n = units === null ? null : answersLeft(units, model);
        return {
          value: `hosted:${model}`,
          label: n === null ? MODEL_NAMES[model]! : `${MODEL_NAMES[model]} · ${n.toLocaleString()} left`,
          disabled: !n,
        };
      }),
    });
  }
  const key: Option[] = [];
  for (const vendor of ['anthropic', 'openai'] as const) {
    const has = !!keys?.[vendor];
    const t = MODEL_TABLE[vendor];
    key.push({ value: `${vendor}:auto`, label: `${ASSISTANT[vendor]} Auto`, title: `${MODEL_NAMES[t.small]} for text, ${MODEL_NAMES[t.large]} for screenshots`, disabled: !has });
    // The major models, and any other that reads screenshots the key's check found.
    const ids = [...MAJOR_MODELS[vendor], ...(listed[vendor] ?? []).filter((m) => m.vision).map((m) => m.id)];
    for (const id of new Set(ids)) key.push({ value: `${vendor}:${id}`, label: MODEL_NAMES[id] ?? id, disabled: !has });
  }
  // A model picked before that is on neither list still shows.
  if (settings.provider === 'byok' && !key.some((o) => o.value === value)) key.push({ value, label: settings.modelOverride?.model ?? value, disabled: false });
  groups.push({ label: 'API key', options: key });
  const local = localSetUp(settings);
  groups.push({ label: 'Local model', options: [{ value: 'local', label: local ? `Local model (${settings.localModel})` : 'Local model', disabled: !local }] });
  return groups;
}

/** Whether anything can answer yet. */
const anySetUp = (groups: Group[]) => groups.some((g) => g.options.some((o) => !o.disabled));

/** The models a key's check found (settings keep them: Options.tsx). */
function useListed(): Listed {
  const [listed, setListed] = useState<Listed>({});
  useEffect(() => {
    const read = () => void browser.storage.local.get('models').then((m) => setListed((m.models as Listed | undefined) ?? {}));
    read();
    const heard = (changes: Record<string, unknown>) => 'models' in changes && read();
    browser.storage.local.onChanged.addListener(heard);
    return () => browser.storage.local.onChanged.removeListener(heard);
  }, []);
  return listed;
}

function Options({ groups, value }: { groups: Group[]; value: AnswerChoice }) {
  return (
    <>
      {value === 'none' && (
        <option value="none" disabled hidden>
          Pick who answers
        </option>
      )}
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled && o.value !== value} title={o.title}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

const choose = (settings: Settings, next: string) => void settingsItem.setValue(withAnswerChoice(settings, next as AnswerChoice));

/** The panel's: as small as its choice, beside Send; "Set up required" until anything can answer. */
export function ModelPicker({ settings, keys }: { settings: Settings; keys: KeyStatus | null }) {
  const account = useAccount();
  const listed = useListed();
  const value = answerChoiceOf(settings);
  const groups = answerGroups(settings, keys, account, listed);

  if (keys && account.ready && !anySetUp(groups)) {
    return (
      <button type="button" className="model-picker setup-needed" data-testid="setup-needed" onClick={() => void browser.runtime.openOptionsPage()}>
        <Icon name="warning" />
        Set up required
      </button>
    );
  }
  return (
    // A native <select> is as wide as its widest option, which would crowd
    // Send off the row. The visible part is a label sized to the
    // current choice; the real select sits invisibly on top of it, so the
    // dropdown, keyboard and screen readers all behave natively.
    <label className="model-picker" title={`Who answers: ${describe(value, settings)}`}>
      <span className="model-picker-face" aria-hidden="true">
        {short(value)}
      </span>
      <select value={value} data-testid="model-picker" aria-label="Who answers" onChange={(e) => choose(settings, e.target.value)}>
        <Options groups={groups} value={value} />
      </select>
    </label>
  );
}

/** Settings → Answers: the same list, at full width. */
export function ModelSelect({ settings, keys, account, listed }: { settings: Settings; keys: KeyStatus; account: AccountState; listed: Listed }) {
  const value = answerChoiceOf(settings);
  return (
    <label className="field">
      <span className="field-label">Model</span>
      <select value={value} data-testid="model-select" onChange={(e) => choose(settings, e.target.value)}>
        <Options groups={answerGroups(settings, keys, account, listed)} value={value} />
      </select>
    </label>
  );
}

function describe(value: AnswerChoice, settings: Settings): string {
  if (value === 'none') return 'no one yet';
  if (value === 'local') return `local model ${settings.localModel}`;
  if (value.startsWith('hosted:')) return `${MODEL_NAMES[value.slice(7)] ?? value.slice(7)}, with your plan`;
  const [vendor, model] = value.split(':') as [Vendor, string];
  if (model === 'auto') {
    const t = MODEL_TABLE[vendor];
    return `${MODEL_NAMES[t.small]} for text, ${MODEL_NAMES[t.large]} for screenshots, with your API key`;
  }
  return `${MODEL_NAMES[model] ?? model}, with your API key`;
}

/** What the closed picker shows: short, since it shares a row with the macros. */
function short(value: AnswerChoice): string {
  if (value === 'none') return 'Pick who answers';
  if (value === 'local') return 'Local model';
  if (value.startsWith('hosted:')) return `Plan · ${SHORT_NAMES[value.slice(7)] ?? value.slice(7)}`;
  const [vendor, model] = value.split(':') as [Vendor, string];
  if (model === 'auto') return `${ASSISTANT[vendor]} Auto`;
  return SHORT_NAMES[model] ?? model;
}
