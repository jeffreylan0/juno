/**
 * An API key goes in and is never shown again: the native core keeps it
 * where no page can read it (src-tauri/src/vault.rs), so all this field ever
 * learns back is its last four characters. Saved, it is checked at once.
 * In settings (Options.tsx) and the first-run setup (Setup.tsx).
 */
import { useState } from 'react';
import type { KeyModel, KeyTestResult } from '@/lib/providers/byok';
import { COMPANY } from '@/lib/router';
import { setKey } from '../platform/vault';

export type Vendor = 'anthropic' | 'openai';

const KEY_HINT: Record<Vendor, string> = { anthropic: 'sk-ant-…', openai: 'sk-…' };
const KEY_PAGE: Record<Vendor, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
};

type Check = { state: 'idle' } | { state: 'checking' } | KeyTestResult;

export function KeyField({
  vendor,
  hint,
  onSaved,
  onChecked,
}: {
  vendor: Vendor;
  hint: string | null;
  onSaved?: () => void;
  onChecked?: (models: KeyModel[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const checking = 'state' in check && check.state === 'checking';
  const typing = !hint || replacing;

  const test = async () => {
    setCheck({ state: 'checking' });
    let result: KeyTestResult;
    try {
      result = (await browser.runtime.sendMessage({ type: 'keys:test', vendor })) as KeyTestResult;
    } catch (err) {
      result = { ok: false, error: `Couldn't check it: ${(err as Error).message}`, code: 'http' };
    }
    setCheck(result);
    if (result.ok) onChecked?.(result.models);
  };
  const keep = async () => {
    if (!draft.trim()) return;
    setCheck({ state: 'checking' });
    try {
      await setKey(vendor, draft);
    } catch (err) {
      setCheck({ ok: false, error: String(err), code: 'bad-key' });
      return;
    }
    setDraft('');
    setReplacing(false);
    onSaved?.();
    await test();
  };
  const remove = async () => {
    await setKey(vendor, '').catch(() => {});
    setCheck({ state: 'idle' });
    setReplacing(false);
    onSaved?.();
  };

  return (
    <div className="field">
      <span className="field-label">
        {COMPANY[vendor]} API key ·{' '}
        <a className="link" href={KEY_PAGE[vendor]} target="_blank" rel="noopener noreferrer">
          get one
        </a>
      </span>
      {typing ? (
        <span className="key-row">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${COMPANY[vendor]} API key`}
            placeholder={KEY_HINT[vendor]}
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
            <button type="button" className="link" onClick={() => (setReplacing(false), setDraft(''))}>
              Cancel
            </button>
          )}
        </span>
      ) : (
        <span className="key-row">
          <code className="key-saved" data-testid="key-saved">
            {hint}
          </code>
          <button type="button" className="secondary" data-testid="test-key" disabled={checking} onClick={() => void test()}>
            {checking ? 'Checking…' : 'Check'}
          </button>
          <button type="button" className="link" data-testid="replace-key" onClick={() => setReplacing(true)}>
            Replace
          </button>
          <button type="button" className="link" data-testid="remove-key" onClick={() => void remove()}>
            Remove
          </button>
        </span>
      )}
      <KeyStatus check={check} hasKey={!!hint} />
      <p className="help">Stays on this computer, is sent only to {COMPANY[vendor]}, and is never shown again.</p>
    </div>
  );
}

function KeyStatus({ check, hasKey }: { check: Check; hasKey: boolean }) {
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
