/**
 * Settings → Selecting → Keyboard shortcut, in the app. The shortcut works in
 * every app; if another app already holds it, the system refuses it and this
 * says so (the menu bar icon still works).
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { BRAND } from '@/brand';
import { formatShortcut } from '@/ui/useShortcut';

interface ShortcutStatus {
  shortcut: string;
  error: string | null;
}

export function ShortcutField() {
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  useEffect(() => {
    void invoke<{ shortcut: ShortcutStatus }>('app_info').then((info) => setStatus(info.shortcut), () => {});
  }, []);
  const keys = status ? formatShortcut(status.shortcut) : '';
  return (
    <div className="field" data-testid="shortcuts">
      <span className="field-label">Keyboard shortcut</span>
      <span className="key-row shortcut-row">
        <span>
          Start selecting: <kbd>{keys || '…'}</kbd>
        </span>
      </span>
      {status?.error ? (
        <small className="help bad" data-testid="shortcut-taken">
          Another app is using {keys}, so it does nothing here. Click {BRAND.iconName} instead, or quit the other app and
          restart {BRAND.name}.
        </small>
      ) : (
        <small className="help">Works in every app, full screen included. Same as clicking {BRAND.iconName}.</small>
      )}
    </div>
  );
}
