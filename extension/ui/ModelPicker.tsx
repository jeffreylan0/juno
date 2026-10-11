/**
 * Who answers, chosen right beside Send instead of in settings: the
 * major Claude and ChatGPT models, a local model, or placeholder answers.
 *
 * Models from a vendor with no key saved are listed but disabled with "add
 * key", and the last entry opens settings, so the picker never lets a
 * student pick something that can only fail.
 */
import { MAJOR_MODELS, MODEL_NAMES, MODEL_TABLE, SHORT_NAMES } from '@/lib/router';
import { answerChoiceOf, settingsItem, withAnswerChoice, type AnswerChoice, type Keys, type Settings } from '@/lib/storage';
import { hasHosted, useAccount } from './useAccount';

const SETTINGS = '__settings';

const VENDOR: Record<'anthropic' | 'openai', { name: string; key: keyof Keys }> = {
  anthropic: { name: 'Claude', key: 'anthropic' },
  openai: { name: 'ChatGPT', key: 'openai' },
};

export function ModelPicker({ settings, keys }: { settings: Settings; keys: Keys | null }) {
  const value = answerChoiceOf(settings);
  const has = (vendor: 'anthropic' | 'openai') => !!keys?.[VENDOR[vendor].key];
  const hosted = hasHosted(useAccount());

  const choose = async (next: string) => {
    if (next === SETTINGS) {
      void browser.runtime.openOptionsPage();
      return;
    }
    const choice = next as AnswerChoice;
    // Hosted answers use Claude, with the automatic model choice.
    const base = choice === 'hosted' ? { ...settings, vendor: 'anthropic' as const, modelOverride: null } : settings;
    await settingsItem.setValue(withAnswerChoice(base, choice));
  };

  return (
    // A native <select> is as wide as its widest option, which would crowd
    // Send off the row. The visible part is a label sized to the
    // current choice; the real select sits invisibly on top of it, so the
    // dropdown, keyboard and screen readers all behave natively.
    <label className="model-picker" title={`Who answers: ${describe(value, settings)}`}>
      <span className="model-picker-face" aria-hidden="true">
        {short(value)}
      </span>
      <select value={value} data-testid="model-picker" aria-label="Who answers" onChange={(e) => void choose(e.target.value)}>
        {(['anthropic', 'openai'] as const).map((vendor) => {
          const locked = !has(vendor);
          const tag = locked ? ' — add key' : '';
          const table = MODEL_TABLE[vendor];
          return (
            <optgroup key={vendor} label={VENDOR[vendor].name}>
              <option value={`${vendor}:auto`} disabled={locked} title={`${MODEL_NAMES[table.small]} for text, ${MODEL_NAMES[table.large]} for screenshots`}>
                {VENDOR[vendor].name} Auto{tag}
              </option>
              {MAJOR_MODELS[vendor].map((id) => (
                <option key={id} value={`${vendor}:${id}`} disabled={locked} title={MODEL_NAMES[id]}>
                  {SHORT_NAMES[id] ?? MODEL_NAMES[id] ?? id}
                  {tag}
                </option>
              ))}
              {/* A model picked in settings that is not on the short list still shows. */}
              {settings.provider === 'byok' &&
                settings.vendor === vendor &&
                settings.modelOverride &&
                !MAJOR_MODELS[vendor].includes(settings.modelOverride.model) && (
                  <option value={value}>{settings.modelOverride.model}</option>
                )}
            </optgroup>
          );
        })}
        <optgroup label="Other">
          <option value="local" title={`Local model: ${settings.localModel}`}>
            Local model
          </option>
          <option value="placeholder" title="Placeholder answers, no AI">
            Placeholder
          </option>
          {(hosted || value === 'hosted') && <option value="hosted">Hosted</option>}
        </optgroup>
        <option value={SETTINGS}>Add or change API keys…</option>
      </select>
    </label>
  );
}

function describe(value: AnswerChoice, settings: Settings): string {
  if (value === 'placeholder') return 'placeholder answers, no AI';
  if (value === 'local') return `local model ${settings.localModel}`;
  if (value === 'hosted') return 'hosted answers (Claude, through your plan)';
  const [vendor, model] = value.split(':') as ['anthropic' | 'openai', string];
  if (model === 'auto') {
    const t = MODEL_TABLE[vendor];
    return `${MODEL_NAMES[t.small]} for text, ${MODEL_NAMES[t.large]} for screenshots`;
  }
  return MODEL_NAMES[model] ?? model;
}

/** What the closed picker shows: short, since it shares a row with the macros. */
function short(value: AnswerChoice): string {
  if (value === 'placeholder') return 'Placeholder';
  if (value === 'local') return 'Local model';
  if (value === 'hosted') return 'Hosted';
  const [vendor, model] = value.split(':') as ['anthropic' | 'openai', string];
  if (model === 'auto') return `${VENDOR[vendor].name} Auto`;
  return SHORT_NAMES[model] ?? model;
}
