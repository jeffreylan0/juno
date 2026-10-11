/**
 * Settings → Selection AI (the app only): which version this is, and Quit.
 * The menu bar icon starts a selection when clicked, so quitting lives here
 * (and in that icon's right-click menu, and ⌘Q in the app's windows).
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { BRAND } from '@/brand';
import { MAC } from '../os';

export function AppSection() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    void invoke<{ version: string }>('app_info').then((info) => setVersion(info.version), () => {});
  }, []);
  return (
    <div className="field" data-testid="app-section">
      <p className="help">
        {BRAND.name} {version && <>version {version}. </>}It stays in the menu bar: click its icon (or press the shortcut) to
        select, right-click it for settings and Quit.
      </p>
      <button type="button" className="secondary" data-testid="quit" onClick={() => void invoke('quit')}>
        Quit {BRAND.name}
        {MAC && <kbd className="quit-key">⌘Q</kbd>}
      </button>
    </div>
  );
}
