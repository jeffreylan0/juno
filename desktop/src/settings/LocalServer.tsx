/** Settings → Answers → Local model (and the first-run setup): an OpenAI-compatible server and its model. */
import { useState } from 'react';
import type { AiStatus } from '@/lib/status';
import type { Settings } from '@/lib/storage';
import { useDebounced } from './useDebounced';

/** Whether a local-model address is somewhere else: 'plain' over unencrypted HTTP, 'remote' over HTTPS, null on this computer. */
function offComputer(address: string): 'plain' | 'remote' | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (/^(localhost|127(\.\d+){3}|\[::1\])$/i.test(url.hostname)) return null;
  return url.protocol === 'https:' ? 'remote' : 'plain';
}

export function LocalServer({ settings, save }: { settings: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const [url, setUrl] = useState(settings.localBaseUrl);
  const [model, setModel] = useState(settings.localModel);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const saveUrl = useDebounced((v: string) => void save({ localBaseUrl: v.trim() }));
  const saveModel = useDebounced((v: string) => void save({ localModel: v.trim() }));

  const check = async () => {
    setChecking(true);
    await save({ localBaseUrl: url.trim(), localModel: model.trim() });
    const s = (await browser.runtime.sendMessage({ type: 'ai:check', force: true }).catch(() => null)) as AiStatus | null;
    setStatus(s);
    setChecking(false);
  };

  return (
    <div className="sub" data-testid="local">
      <label className="field">
        <span className="field-label">Server address</span>
        <input
          value={url}
          spellCheck={false}
          onChange={(e) => {
            setUrl(e.target.value);
            saveUrl(e.target.value);
          }}
        />
        {offComputer(url) && (
          <small className="help warn" data-testid="local-remote">
            {offComputer(url) === 'plain'
              ? 'Not on this computer, and not https: your selections would travel unencrypted.'
              : 'Not on this computer: your selections are sent there.'}
          </small>
        )}
      </label>
      <label className="field">
        <span className="field-label">Model</span>
        <input
          value={model}
          spellCheck={false}
          onChange={(e) => {
            setModel(e.target.value);
            saveModel(e.target.value);
          }}
        />
        <small className="help">Any OpenAI-compatible server (like Ollama), with a model that reads images.</small>
      </label>
      <span className="key-row">
        <button type="button" className="secondary" disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check connection'}
        </button>
        {status && (
          <span className={`help ${status.state === 'ok' ? 'ok' : 'bad'}`}>
            {status.state === 'ok' ? '✓ Connected.' : status.message}
          </span>
        )}
      </span>
    </div>
  );
}
