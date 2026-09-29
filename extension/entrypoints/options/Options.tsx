/**
 * Settings. Grouped into what the student actually thinks about: who answers,
 * how they select, what gets asked, and what stays private.
 *
 * Deliberately barebones — every colour is a token in options.css so the real
 * theme drops in without touching this file. A full settings pass is planned
 * for the next round; this one adds the answer macros and the key check.
 */
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_MACROS, DEFAULT_PROMPT } from '@shared/prompts';
import { MODEL_NAMES, MODEL_TABLE } from '@/lib/router';
import type { KeyModel, KeyTestResult } from '@/lib/providers/byok';
import {
  DEFAULT_SETTINGS,
  getKeys,
  getSettings,
  keysItem,
  sanitizeMacros,
  settingsItem,
  type Keys,
  type Macro,
  type PanelOpen,
  type SendBehavior,
  type Settings,
} from '@/lib/storage';

type Vendor = 'anthropic' | 'openai';

const VENDOR_NAME: Record<Vendor, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI (ChatGPT)' };
const KEY_HINT: Record<Vendor, string> = { anthropic: 'sk-ant-…', openai: 'sk-…' };
const KEY_PAGE: Record<Vendor, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
};

const PROVIDERS: { id: Settings['provider']; label: string; help: string }[] = [
  { id: 'byok', label: 'My own API key', help: 'Answers come straight from Anthropic or OpenAI, billed to your key. The key stays in this browser.' },
  { id: 'mock', label: 'Placeholder answers', help: 'No AI, no network, no cost. For trying the extension out.' },
  { id: 'local', label: 'Local model (Ollama)', help: 'A model running on your own machine. Free and private; needs Ollama.' },
  { id: 'gateway', label: 'Hosted plan', help: 'Sign in; usage counts against your plan. Coming later.' },
];

const PANEL: { id: PanelOpen; label: string; help: string }[] = [
  {
    id: 'on-selection',
    label: 'When a selection is made',
    help: 'The panel stays out of the way while you choose what to select, then opens beside the page.',
  },
  {
    id: 'on-click',
    label: 'When I click the toolbar icon',
    help: 'Opens at once, so the last answer is in view — but it narrows the page you are selecting from.',
  },
];

const SEND: { id: SendBehavior; label: string; help: string }[] = [
  { id: 'prefill', label: 'Put the default prompt in the box and wait', help: 'Press Enter or a macro to ask. Nothing is spent until you do.' },
  { id: 'auto', label: 'Ask the default prompt straight away', help: 'Fastest: select, read. Every selection is a paid call.' },
  { id: 'auto-box', label: 'Ask straight away for boxes only', help: 'Screenshots go straight out; text selections wait for you.' },
];

type TestState = { state: 'idle' } | { state: 'testing' } | KeyTestResult;

const isResult = (t: TestState): t is KeyTestResult => 'ok' in t;

export function Options() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keys, setKeys] = useState<Keys>({ anthropic: '', openai: '', session: '' });
  const [blocked, setBlocked] = useState('');
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tests, setTests] = useState<Record<Vendor, TestState>>({ anthropic: { state: 'idle' }, openai: { state: 'idle' } });
  const [models, setModels] = useState<Partial<Record<Vendor, KeyModel[]>>>({});

  useEffect(() => {
    void Promise.all([getSettings(), getKeys(), browser.storage.local.get('models')]).then(([s, k, m]) => {
      setSettings(s);
      setKeys(k);
      setBlocked(s.blockedSites.join('\n'));
      setModels((m.models as Partial<Record<Vendor, KeyModel[]>> | undefined) ?? {});
      setLoaded(true);
    });
  }, []);

  async function persist(next: Settings, nextKeys: Keys) {
    const blockedSites = blocked
      .split(/\n|,/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const clean: Settings = {
      ...next,
      blockedSites,
      defaultPrompt: next.defaultPrompt.trim() ? next.defaultPrompt : DEFAULT_PROMPT,
      // Blank rows are drafts nobody finished; do not ship an empty button.
      macros: sanitizeMacros(next.macros.filter((m) => m.name.trim() && m.prompt.trim())),
    };
    await settingsItem.setValue(clean);
    await keysItem.setValue(nextKeys);
    setSettings(clean);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  }

  async function test(vendor: Vendor) {
    setTests((t) => ({ ...t, [vendor]: { state: 'testing' } }));
    let result: KeyTestResult;
    try {
      result = (await browser.runtime.sendMessage({ type: 'keys:test', vendor, key: keys[vendor] })) as KeyTestResult;
    } catch (err) {
      result = { ok: false, error: `Could not run the check: ${(err as Error).message}`, code: 'http' };
    }
    setTests((t) => ({ ...t, [vendor]: result }));
    if (result.ok) {
      const next = { ...models, [vendor]: result.models };
      setModels(next);
      await browser.storage.local.set({ models: next });
    }
  }

  /** One click from a working key to real answers: switch, save, done. */
  async function useKey(vendor: Vendor) {
    await persist(
      {
        ...settings,
        provider: 'byok',
        vendor,
        modelOverride: settings.modelOverride?.vendor === vendor ? settings.modelOverride : null,
      },
      keys,
    );
  }

  const setMacro = (i: number, patch: Partial<Macro>) =>
    setSettings((s) => ({ ...s, macros: s.macros.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const moveMacro = (i: number, by: number) =>
    setSettings((s) => {
      const macros = [...s.macros];
      const j = i + by;
      if (j < 0 || j >= macros.length) return s;
      [macros[i], macros[j]] = [macros[j]!, macros[i]!];
      return { ...s, macros };
    });
  const removeMacro = (i: number) => setSettings((s) => ({ ...s, macros: s.macros.filter((_, j) => j !== i) }));
  const addMacro = () =>
    setSettings((s) => ({ ...s, macros: [...s.macros, { id: `macro-${Date.now().toString(36)}`, name: '', prompt: '' }] }));

  const macrosChanged = useMemo(() => {
    const shape = (ms: Macro[]) => JSON.stringify(ms.map(({ name, prompt }) => ({ name, prompt })));
    return shape(settings.macros) !== shape(DEFAULT_MACROS);
  }, [settings.macros]);

  if (!loaded) return <main className="options" />;

  const vendor = settings.vendor;
  const table = MODEL_TABLE[vendor];
  const listed = models[vendor];
  const current = tests[vendor];
  const works = isResult(current) && current.ok;
  const testing = 'state' in current && current.state === 'testing';
  const using = settings.provider === 'byok' && settings.vendor === vendor;
  const choices: KeyModel[] = listed ?? [table.small, table.large].map((id) => ({ id, name: MODEL_NAMES[id] ?? id, vision: true }));

  return (
    <main className="options">
      <h1>Selection AI</h1>
      <p className="lede">
        Click the toolbar icon and a selection starts right away. Switch between box and text from the chips on screen, or
        press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> and <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>.
      </p>

      <section>
        <h2>Who answers</h2>
        {PROVIDERS.map((p) => (
          <label key={p.id} className="radio">
            <input type="radio" name="provider" checked={settings.provider === p.id} onChange={() => setSettings({ ...settings, provider: p.id })} />
            <span>
              <b>{p.label}</b>
              <small>{p.help}</small>
            </span>
          </label>
        ))}
      </section>

      <section data-testid="keys">
        <h2>Your API key</h2>
        <p className="help">
          Stored only in this browser profile and sent only to the vendor you choose. Set a monthly spend limit in the vendor's
          console so a busy week cannot surprise you.
        </p>
        <label>
          Vendor
          <select value={vendor} onChange={(e) => setSettings({ ...settings, vendor: e.target.value as Vendor, modelOverride: null })}>
            <option value="anthropic">{VENDOR_NAME.anthropic}</option>
            <option value="openai">{VENDOR_NAME.openai}</option>
          </select>
        </label>
        <div className="field">
          <span className="field-label">
            {vendor === 'anthropic' ? 'Anthropic' : 'OpenAI'} key ·{' '}
            <a className="link" href={KEY_PAGE[vendor]} target="_blank" rel="noopener noreferrer">
              get one
            </a>
          </span>
          <span className="key-row">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${vendor} API key`}
              value={keys[vendor]}
              data-testid="key-input"
              onChange={(e) => {
                setKeys({ ...keys, [vendor]: e.target.value.trim() });
                setTests((t) => ({ ...t, [vendor]: { state: 'idle' } }));
              }}
              placeholder={KEY_HINT[vendor]}
            />
            <button
              type="button"
              className="secondary"
              data-testid="test-key"
              disabled={!keys[vendor] || testing}
              onClick={() => void test(vendor)}
            >
              {testing ? 'Checking…' : 'Test key'}
            </button>
          </span>
        </div>
        <KeyStatus test={current} />
        {works && !using && (
          <button type="button" className="primary" data-testid="use-key" onClick={() => void useKey(vendor)}>
            Use this key for answers
          </button>
        )}
        {works && using && <p className="help ok">Answers come from this key. Save if you changed it.</p>}
        <label>
          Model
          <select
            value={settings.modelOverride?.model ?? ''}
            data-testid="model-select"
            onChange={(e) => setSettings({ ...settings, modelOverride: e.target.value ? { vendor, model: e.target.value } : null })}
          >
            <option value="">
              Automatic — {MODEL_NAMES[table.small]} for text, {MODEL_NAMES[table.large]} for screenshots
            </option>
            {choices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.vision ? '' : ' (text only — cannot read boxes)'}
              </option>
            ))}
          </select>
        </label>
        {!listed && <p className="help">Test your key to list every model it can use.</p>}
      </section>

      <section>
        <h2>Selecting</h2>
        <label>
          What the toolbar icon starts
          <select
            value={settings.defaultSelectionKind}
            onChange={(e) => setSettings({ ...settings, defaultSelectionKind: e.target.value as Settings['defaultSelectionKind'] })}
          >
            <option value="box">Box — drag around anything</option>
            <option value="text">Text — select text on the page</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.adjustBox} onChange={(e) => setSettings({ ...settings, adjustBox: e.target.checked })} />
          <span>
            <b>Adjust a box before asking</b>
            <small>
              Off: a box goes to the panel the moment you let go. On: it stays on screen with handles to resize or move, then
              Enter or Ask sends it.
            </small>
          </span>
        </label>
        <label>
          Open the answer panel
          <select value={settings.panelOpen} onChange={(e) => setSettings({ ...settings, panelOpen: e.target.value as PanelOpen })}>
            {PANEL.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <p className="help">{PANEL.find((p) => p.id === settings.panelOpen)?.help} The red ✕ on the bar closes the panel too.</p>
        <p className="help">
          On a PDF opened in the browser's own viewer, only box selection is possible. Selection AI offers to reopen the file
          in its own reader, where all modes work.
        </p>
      </section>

      <section data-testid="asking">
        <div className="head">
          <h2>Asking</h2>
          {macrosChanged && (
            <button type="button" className="link" onClick={() => setSettings({ ...settings, macros: DEFAULT_MACROS.map((m) => ({ ...m })) })}>
              Reset macros
            </button>
          )}
        </div>
        <label>
          Default prompt
          <input
            value={settings.defaultPrompt}
            maxLength={120}
            data-testid="default-prompt"
            onChange={(e) => setSettings({ ...settings, defaultPrompt: e.target.value })}
            placeholder={DEFAULT_PROMPT}
          />
        </label>
        <p className="help">Sits in the question box when a selection lands. Keep it short; one line reads best.</p>
        <label>
          When a selection lands
          <select value={settings.sendBehavior} onChange={(e) => setSettings({ ...settings, sendBehavior: e.target.value as SendBehavior })}>
            {SEND.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <p className="help">{SEND.find((s) => s.id === settings.sendBehavior)?.help}</p>

        <h3>Answer macros</h3>
        <p className="help">Buttons above the question box. A click puts the prompt in the box and sends it.</p>
        <ol className="macro-list">
          {settings.macros.map((m, i) => (
            <li key={m.id} className="macro-row" data-testid="macro-row">
              <input
                className="macro-name"
                value={m.name}
                placeholder="Button name"
                aria-label="Button name"
                maxLength={24}
                onChange={(e) => setMacro(i, { name: e.target.value })}
              />
              <textarea
                className="macro-prompt"
                rows={2}
                value={m.prompt}
                placeholder="Prompt it sends"
                aria-label="Prompt"
                onChange={(e) => setMacro(i, { prompt: e.target.value })}
              />
              <span className="macro-tools">
                <button type="button" className="tool" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => moveMacro(i, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="tool"
                  title="Move down"
                  aria-label="Move down"
                  disabled={i === settings.macros.length - 1}
                  onClick={() => moveMacro(i, 1)}
                >
                  ↓
                </button>
                <button type="button" className="tool" title="Remove" aria-label="Remove" onClick={() => removeMacro(i)}>
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
        <button type="button" className="secondary add" data-testid="add-macro" onClick={addMacro} disabled={settings.macros.length >= 8}>
          Add macro
        </button>
      </section>

      <section>
        <h2>Local server</h2>
        <label>
          Base URL
          <input value={settings.localBaseUrl} onChange={(e) => setSettings({ ...settings, localBaseUrl: e.target.value })} />
        </label>
        <label>
          Model
          <input value={settings.localModel} onChange={(e) => setSettings({ ...settings, localModel: e.target.value })} />
        </label>
      </section>

      <section>
        <h2>Privacy</h2>
        <p className="help">
          Nothing leaves the page until you select something, and only the selection is sent — the screenshot of a box, or the
          text you selected — never the rest of the page. Blocked sites turn the shortcut off entirely: one hostname per line.
        </p>
        <textarea rows={4} value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder="exam.example.edu" />
      </section>

      <footer>
        <button type="button" className="primary" data-testid="save" onClick={() => void persist(settings, keys)}>
          Save
        </button>
        {saved && <span className="saved">Saved</span>}
      </footer>
    </main>
  );
}

function KeyStatus({ test }: { test: TestState }) {
  if (!isResult(test)) return null;
  if (test.ok) {
    const vision = test.models.filter((m) => m.vision).length;
    return (
      <p className="help ok" data-testid="key-status">
        ✓ Key works. {test.models.length} models available{vision !== test.models.length ? `, ${vision} of them read images` : ''}.
      </p>
    );
  }
  return (
    <p className="help bad" data-testid="key-status">
      {test.error}
    </p>
  );
}
