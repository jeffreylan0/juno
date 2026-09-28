/**
 * Options page: bring-your-own-key entry, provider and default model,
 * local server, blocked sites. Keys are stored in browser.storage.local and
 * never leave the background script.
 */
import { useEffect, useState } from 'react';
import type { Provider } from '@shared/payload';
import { MODEL_TABLE } from '@/lib/router';
import { DEFAULT_SETTINGS, getKeys, getSettings, keysItem, settingsItem, type Keys, type Settings } from '@/lib/storage';

const PROVIDERS: { id: Provider; label: string; help: string }[] = [
  { id: 'mock', label: 'Mock (replay)', help: 'Replays recorded answers; no network. Development default.' },
  { id: 'local', label: 'Local (Ollama)', help: 'OpenAI-compatible server on your machine. Free and private.' },
  { id: 'byok', label: 'My own API key', help: 'Direct calls to Anthropic or OpenAI with your key.' },
  { id: 'gateway', label: 'Hosted plan', help: 'Sign in; usage is counted against your plan (week 9+).' },
];

export function Options() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keys, setKeys] = useState<Keys>({ anthropic: '', openai: '', session: '' });
  const [saved, setSaved] = useState(false);
  const [blocked, setBlocked] = useState('');

  useEffect(() => {
    void Promise.all([getSettings(), getKeys()]).then(([s, k]) => {
      setSettings(s);
      setKeys(k);
      setBlocked(s.blockedSites.join('\n'));
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
    setTimeout(() => setSaved(false), 1500);
  }

  const models = MODEL_TABLE[settings.vendor];

  return (
    <main className="options">
      <h1>Selection AI</h1>

      <section>
        <h2>Provider</h2>
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

      <section>
        <h2>Model</h2>
        <label>
          Vendor
          <select value={settings.vendor} onChange={(e) => setSettings({ ...settings, vendor: e.target.value as Settings['vendor'], modelOverride: null })}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (ChatGPT)</option>
          </select>
        </label>
        <label>
          Default model
          <select
            value={settings.modelOverride?.model ?? ''}
            onChange={(e) =>
              setSettings({ ...settings, modelOverride: e.target.value ? { vendor: settings.vendor, model: e.target.value } : null })
            }
          >
            <option value="">Automatic (small for text, large for images and checking)</option>
            <option value={models.small}>{models.small} (small)</option>
            <option value={models.large}>{models.large} (large)</option>
          </select>
        </label>
        <label>
          Default mode
          <select value={settings.defaultMode} onChange={(e) => setSettings({ ...settings, defaultMode: e.target.value as Settings['defaultMode'] })}>
            <option value="explain">Explain</option>
            <option value="hint">Hint</option>
            <option value="check">Check</option>
          </select>
        </label>
      </section>

      <section>
        <h2>Selection</h2>
        <p className="help">Which mode the toolbar popup arms as soon as it opens.</p>
        <label>
          Default selection mode
          <select
            value={settings.defaultSelectionKind}
            onChange={(e) => setSettings({ ...settings, defaultSelectionKind: e.target.value as Settings['defaultSelectionKind'] })}
          >
            <option value="box">Box — drag around anything</option>
            <option value="text">Text — select text on the page</option>
          </select>
        </label>
      </section>

      <section>
        <h2>Your API keys</h2>
        <p className="help">Stored only in this browser profile. Set a monthly spend cap in each provider console.</p>
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
        <h2>Blocked sites</h2>
        <p className="help">One hostname per line. The shortcut does nothing on these pages (exam portals, private records).</p>
        <textarea rows={4} value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder="exam.example.edu" />
      </section>

      <footer>
        <button type="button" onClick={() => void save()}>Save</button>
        {saved && <span className="saved">Saved</span>}
      </footer>
    </main>
  );
}
