/**
 * Settings → Juno: the version and updating (src-tauri/src/updates.rs),
 * opening at login, the privacy policy and terms, and Quit. The menu bar
 * icon starts a selection when clicked, so quitting lives here (and in that
 * icon's right-click menu, and ⌘Q in the app's windows).
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { BRAND } from '@/brand';
import type { Settings } from '@/lib/storage';
import { MAC } from '../os';

type UpdateStatus =
  | { state: 'off' | 'idle' | 'checking' | 'upToDate' }
  | { state: 'downloading' | 'ready'; version: string }
  | { state: 'failed'; message: string };

/** While something is happening, look again this often. */
const POLL_MS = 1500;

function updateLine(s: UpdateStatus): string {
  switch (s.state) {
    case 'checking':
      return 'Checking…';
    case 'upToDate':
      return 'Up to date.';
    case 'downloading':
      return `Downloading ${s.version}…`;
    case 'ready':
      return `${s.version} installs when ${BRAND.name} isn't in use.`;
    case 'failed':
      return "Couldn't check for updates.";
    default:
      return '';
  }
}

export function AppSection({ settings, save }: { settings: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const [version, setVersion] = useState('');
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  /** Whether the app opens at login; null until known, or when the system will not say. */
  const [atLogin, setAtLogin] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState(false);
  useEffect(() => {
    void invoke<{ version: string }>('app_info').then((info) => setVersion(info.version), () => {});
    void invoke<boolean>('login_item').then(setAtLogin, () => {});
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () =>
      void invoke<UpdateStatus>('update_status').then((s) => {
        setUpdate(s);
        if (s.state === 'checking' || s.state === 'downloading') timer = setTimeout(look, POLL_MS);
      }, () => {});
    look();
    return () => clearTimeout(timer);
  }, [update?.state === 'checking']);
  const setLogin = (on: boolean) => {
    setLoginError(false);
    void invoke<boolean>('login_item_set', { on }).then(setAtLogin, () => setLoginError(true));
  };
  const off = !update || update.state === 'off';
  return (
    <div className="field" data-testid="app-section">
      <p className="help">
        Version {version || '…'}
        {!off && updateLine(update) ? <> · {updateLine(update)}</> : null}
      </p>
      {off ? (
        <small className="help" data-testid="updates-off">
          Updates aren't set up in this build.
        </small>
      ) : (
        <span className="key-row">
          <label className="check">
            <input type="checkbox" checked={settings.autoUpdate} data-testid="auto-update" onChange={(e) => void save({ autoUpdate: e.target.checked })} />
            Update automatically
          </label>
          <button
            type="button"
            className="link"
            data-testid="check-updates"
            disabled={update.state === 'checking' || update.state === 'downloading'}
            onClick={() => void invoke('update_check').then(() => setUpdate({ state: 'checking' }), () => {})}
          >
            Check now
          </button>
        </span>
      )}
      {atLogin !== null && (
        <label className="check">
          <input type="checkbox" checked={atLogin} data-testid="open-at-login" onChange={(e) => setLogin(e.target.checked)} />
          Open at login
        </label>
      )}
      {loginError && <small className="help bad">Couldn't change this. Try again.</small>}
      <Legal />
      <button type="button" className="secondary" data-testid="quit" onClick={() => void invoke('quit')}>
        Quit {BRAND.name}
        {MAC && <kbd className="quit-key">⌘Q</kbd>}
      </button>
    </div>
  );
}

/** The privacy policy and terms (legal/ in the repository), on the maker's site. */
function Legal() {
  return (
    <small className="help" data-testid="legal">
      <a className="link" href={BRAND.privacy} target="_blank" rel="noopener noreferrer">
        Privacy policy
      </a>{' '}
      ·{' '}
      <a className="link" href={BRAND.terms} target="_blank" rel="noopener noreferrer">
        Terms
      </a>
    </small>
  );
}
