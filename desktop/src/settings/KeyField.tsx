/**
 * Your own API key, Anthropic's or OpenAI's: the app tells which from the
 * key itself (the native core does: src-tauri/src/vault.rs), so there is one
 * field for both. A key goes in and is never shown again: the native core
 * keeps it where no page can read it, so all this field ever learns back is
 * its last four characters. Saved, it is checked at once, and answers come
 * from that company. In settings (Options.tsx) and the first-run setup
 * (Setup.tsx).
 */
import { useState } from 'react';
import type { KeyModel, KeyTestResult } from '@/lib/providers/byok';
import type { KeyStatus, KeyVendor as Vendor } from '@/lib/providers/types';
import { COMPANY } from '@/lib/router';
import { removeKey, setKey } from '../platform/vault';

const VENDORS: Vendor[] = ['anthropic', 'openai'];
const KEY_PAGE: Record<Vendor, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
};

type Check = { state: 'idle' } | { state: 'checking' } | KeyTestResult;

export function KeyField({
  keys,
  current,
  onUse,
  onSaved,
  onChecked,
}: {
  keys: KeyStatus;
  /** The company answers come from now. */
  current: Vendor;
  /** Answers should come from `vendor` (its key was just saved, or picked). */
  onUse: (vendor: Vendor) => void;
  onSaved?: () => void;
  onChecked?: (vendor: Vendor, models: KeyModel[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const checking = 'state' in check && check.state === 'checking';
  const hint = keys[current];
  const other = VENDORS.find((v) => v !== current && keys[v]);
  const typing = !hint || adding;

  const test = async (vendor: Vendor) => {
    setCheck({ state: 'checking' });
    let result: KeyTestResult;
    try {
      result = (await browser.runtime.sendMessage({ type: 'keys:test', vendor })) as KeyTestResult;
    } catch (err) {
      result = { ok: false, error: `Couldn't check it: ${(err as Error).message}`, code: 'http' };
    }
    setCheck(result);
    if (result.ok) onChecked?.(vendor, result.models);
  };
  const keep = async () => {
    if (!draft.trim()) return;
    setCheck({ state: 'checking' });
    let vendor: Vendor;
    try {
      vendor = (await setKey(draft)).vendor;
    } catch (err) {
      setCheck({ ok: false, error: String(err), code: 'bad-key' });
      return;
    }
    setDraft('');
    setAdding(false);
    onUse(vendor);
    onSaved?.();
    await test(vendor);
  };
  const forget = async (vendor: Vendor) => {
    await removeKey(vendor).catch(() => {});
    setCheck({ state: 'idle' });
    // Answers move to the other key, if there is one.
    const rest = VENDORS.find((v) => v !== vendor && keys[v]);
    if (vendor === current && rest) onUse(rest);
    onSaved?.();
  };

  return (
    <div className="field" data-testid="key-field">
      <span className="field-label">
        API key · get one from{' '}
        <a className="link" href={KEY_PAGE.anthropic} target="_blank" rel="noopener noreferrer">
          Anthropic
        </a>{' '}
        or{' '}
        <a className="link" href={KEY_PAGE.openai} target="_blank" rel="noopener noreferrer">
          OpenAI
        </a>
      </span>
      {hint && (
        <span className="key-row">
          <span className="key-saved" data-testid="key-saved">
            {COMPANY[current]} <code>{hint}</code>
          </span>
          <button type="button" className="secondary" data-testid="test-key" disabled={checking} onClick={() => void test(current)}>
            {checking ? 'Checking…' : 'Check'}
          </button>
          <button type="button" className="link" data-testid="remove-key" onClick={() => void forget(current)}>
            Remove
          </button>
        </span>
      )}
      {other && (
        <span className="key-row" data-testid="other-key">
          <span className="key-saved">
            Also saved: {COMPANY[other]} <code>{keys[other]}</code>
          </span>
          <button type="button" className="link" data-testid="use-other-key" onClick={() => onUse(other)}>
            Use it
          </button>
        </span>
      )}
      {typing ? (
        <span className="key-row">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="API key"
            placeholder="sk-ant-… or sk-…"
            value={draft}
            data-testid="key-input"
            onChange={(e) => {
              setDraft(e.target.value);
              setCheck({ state: 'idle' });
            }}
            onKeyDown={(e) => e.key === 'Enter' && void keep()}
          />
          <button type="button" className="secondary" data-testid="save-key" disabled={!draft.trim() || checking} onClick={() => void keep()}>
            {checking ? 'Checking…' : 'Save'}
          </button>
          {hint && (
            <button type="button" className="link" onClick={() => (setAdding(false), setDraft(''))}>
              Cancel
            </button>
          )}
        </span>
      ) : (
        <button type="button" className="link" data-testid="add-key" onClick={() => setAdding(true)}>
          Use another key
        </button>
      )}
      <KeyStatusLine check={check} hasKey={!!hint} />
      <p className="help">
        Claude or ChatGPT: the key says which. It stays on this computer and goes only to the company that issued it. Make a key just for Juno, with a
        monthly spend limit, and never share it.
      </p>
    </div>
  );
}

function KeyStatusLine({ check, hasKey }: { check: Check; hasKey: boolean }) {
  if ('state' in check && check.state === 'checking') return <p className="help">Checking…</p>;
  if (!('ok' in check)) return hasKey ? null : <p className="help warn">Needed to ask anything.</p>;
  if (check.ok) {
    const vision = check.models.filter((m) => m.vision).length;
    return (
      <p className="help ok" data-testid="key-status">
        ✓ Works. {check.models.length} models{vision !== check.models.length ? `, ${vision} read images` : ''}.
      </p>
    );
  }
  return (
    <p className="help bad" data-testid="key-status">
      {check.error}
    </p>
  );
}
