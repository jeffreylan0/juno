/**
 * Settings → Juno (the app only): which version this is, opening at
 * login, and Quit. The menu bar icon starts a selection when clicked, so
 * quitting lives here (and in that icon's right-click menu, and ⌘Q in the
 * app's windows).
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { BRAND } from '@/brand';
import { MAC } from '../os';

export function AppSection() {
  const [version, setVersion] = useState('');
  /** Whether the app opens at login; null until known, or when the system will not say. */
  const [atLogin, setAtLogin] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState(false);
  useEffect(() => {
    void invoke<{ version: string }>('app_info').then((info) => setVersion(info.version), () => {});
    void invoke<boolean>('login_item').then(setAtLogin, () => {});
  }, []);
  const setLogin = (on: boolean) => {
    setLoginError(false);
    void invoke<boolean>('login_item_set', { on }).then(setAtLogin, () => setLoginError(true));
  };
  return (
    <div className="field" data-testid="app-section">
      <p className="help">
        {BRAND.name} {version && <>version {version}. </>}It stays in the menu bar: click its icon (or press the shortcut) to
        select, right-click it for settings and Quit.
      </p>
      {atLogin !== null && (
        <label className="check">
          <input type="checkbox" checked={atLogin} data-testid="open-at-login" onChange={(e) => setLogin(e.target.checked)} />
          Open at login, in the menu bar
        </label>
      )}
      {loginError && <small className="help bad">Your computer would not change this. Try again, or add {BRAND.name} to your login items yourself.</small>}
      <button type="button" className="secondary" data-testid="quit" onClick={() => void invoke('quit')}>
        Quit {BRAND.name}
        {MAC && <kbd className="quit-key">⌘Q</kbd>}
      </button>
    </div>
  );
}
