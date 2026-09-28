/**
 * Settings. Grouped into what the student actually thinks about: how they
 * select, what gets asked, which model answers, and what stays private.
 *
 * Deliberately barebones — every colour is a token in options.css so the real
 * theme drops in without touching this file.
 */
import { useEffect, useMemo, useState } from 'react';
import { MODES, type Mode } from '@shared/payload';
import { DEFAULT_PROMPTS } from '@shared/prompts';
import { MODEL_TABLE } from '@/lib/router';
import {
  DEFAULT_SETTINGS,
  getKeys,
  getSettings,
  keysItem,
  settingsItem,
  type Keys,
  type SendBehavior,
  type Settings,
} from '@/lib/storage';

const MODE_LABEL: Record<Mode, string> = { explain: 'Explain', hint: 'Hint', check: 'Check' };

const PROVIDERS: { id: Settings['provider']; label: string; help: string }[] = [
  { id: 'mock', label: 'Mock (replay)', help: 'Replays recorded answers; no network, no spend. The development default.' },
  { id: 'local', label: 'Local (Ollama)', help: 'An OpenAI-compatible server on your own machine. Free and private.' },
  { id: 'byok', label: 'My own API key', help: 'Direct calls to Anthropic or OpenAI with the key below.' },
  { id: 'gateway', label: 'Hosted plan', help: 'Sign in; usage counts against your plan. Arrives in week 9.' },
];

const SEND: { id: SendBehavior; label: string; help: string }[] = [
  { id: 'prefill', label: 'Put the prompt in the box and wait', help: 'You can edit it before anything is sent. Nothing costs money until you ask.' },
  { id: 'auto', label: 'Send as soon as I select', help: 'Fastest loop: select, read. Every selection is a paid call.' },
  { id: 'auto-box', label: 'Send box selections, wait for the rest', help: 'Screenshots of problems go straight out; text and element selections wait.' },
];

export function Options() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keys, setKeys] = useState<Keys>({ anthropic: '', openai: '', session: '' });
  const [blocked, setBlocked] = useState('');
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void Promise.all([getSettings(), getKeys()]).then(([s, k]) => {
      setSettings(s);
      setKeys(k);
      setBlocked(s.blockedSites.join('\n'));
      setLoaded(true);
    });
  }, []);

  async function save() {
    const blockedSites = blocked
      .split(/\n|,/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    await settingsItem.setValue({ ...settings, blockedSites });
    await keysItem.setValue(keys);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  }

  const models = MODEL_TABLE[settings.vendor];
  const promptsChanged = useMemo(
    () => MODES.some((m) => settings.prompts[m] !== DEFAULT_PROMPTS[m]),
    [settings.prompts],
  );

  if (!loaded) return <main className="options" />;

  return (
    <main className="options">
      <h1>Selection AI</h1>
      <p className="lede">
        Click the toolbar icon and a selection starts right away. Switch between box and text from the chips on screen, or
        press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> and <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>.
      </p>

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
        <p className="help">
          On a PDF opened in the browser's own viewer, only box selection is possible — the text lives inside a plugin the
          extension cannot read. Selection AI offers to reopen the file in its own reader, where all modes work.
        </p>
      </section>

      <section>
        <h2>Asking</h2>
        <label>
          Which mode a selection starts in
          <select value={settings.defaultMode} onChange={(e) => setSettings({ ...settings, defaultMode: e.target.value as Mode })}>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
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
      </section>

      <section>
        <div className="head">
          <h2>Default prompts</h2>
          {promptsChanged && (
            <button type="button" className="link" onClick={() => setSettings({ ...settings, prompts: { ...DEFAULT_PROMPTS } })}>
              Reset to defaults
            </button>
          )}
        </div>
        <p className="help">What lands in the question box for each mode. Edit anything here; leave one blank to ask with no question at all.</p>
        {MODES.map((m) => (
          <label key={m}>
            {MODE_LABEL[m]}
            <textarea
              rows={2}
              value={settings.prompts[m] ?? ''}
              placeholder={DEFAULT_PROMPTS[m]}
              onChange={(e) => setSettings({ ...settings, prompts: { ...settings.prompts, [m]: e.target.value } })}
            />
          </label>
        ))}
      </section>

      <section>
        <h2>Model</h2>
        {PROVIDERS.map((p) => (
          <label key={p.id} className="radio">
            <input type="radio" name="provider" checked={settings.provider === p.id} onChange={() => setSettings({ ...settings, provider: p.id })} />
            <span>
              <b>{p.label}</b>
              <small>{p.help}</small>
            </span>
          </label>
        ))}
        <label>
          Vendor
          <select
            value={settings.vendor}
            onChange={(e) => setSettings({ ...settings, vendor: e.target.value as Settings['vendor'], modelOverride: null })}
          >
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (ChatGPT)</option>
          </select>
        </label>
        <label>
          Which model
          <select
            value={settings.modelOverride?.model ?? ''}
            onChange={(e) =>
              setSettings({ ...settings, modelOverride: e.target.value ? { vendor: settings.vendor, model: e.target.value } : null })
            }
          >
            <option value="">Automatic — small for text, large for images and checking</option>
            <option value={models.small}>{models.small} (small)</option>
            <option value={models.large}>{models.large} (large)</option>
          </select>
        </label>
      </section>

      <section>
        <h2>Your API keys</h2>
        <p className="help">Stored only in this browser profile and never sent anywhere but the provider. Set a monthly spend cap in each provider console.</p>
        <label>
          Anthropic key
          <input type="password" autoComplete="off" value={keys.anthropic} onChange={(e) => setKeys({ ...keys, anthropic: e.target.value.trim() })} placeholder="sk-ant-..." />
        </label>
        <label>
          OpenAI key
          <input type="password" autoComplete="off" value={keys.openai} onChange={(e) => setKeys({ ...keys, openai: e.target.value.trim() })} placeholder="sk-..." />
        </label>
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
          Nothing leaves the page until you select something, and only the selection is sent — never the whole page. Blocked
          sites turn the shortcut off entirely: one hostname per line.
        </p>
        <textarea rows={4} value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder="exam.example.edu" />
      </section>

      <footer>
        <button type="button" onClick={() => void save()}>Save</button>
        {saved && <span className="saved">Saved</span>}
      </footer>
    </main>
  );
}
