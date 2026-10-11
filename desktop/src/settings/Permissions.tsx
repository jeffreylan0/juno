/**
 * Settings → Permissions (macOS). Screen Recording is the one permission the
 * app asks for: a selection is a screenshot of what is on screen. macOS asks
 * once; after that it is a switch in System Settings, and the app has to
 * restart before the switch takes effect.
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { BRAND } from '@/brand';

type Access = 'granted' | 'denied' | 'not-needed';

export function Permissions() {
  const [access, setAccess] = useState<Access | null>(null);
  useEffect(() => {
    const check = () => void invoke<Access>('screen_access').then(setAccess, () => {});
    check();
    // Back from System Settings: look again.
    addEventListener('focus', check);
    return () => removeEventListener('focus', check);
  }, []);
  return (
    <div className="field" data-testid="permissions">
      <span className="field-label">Screen Recording</span>
      {access === 'granted' ? (
        <p className="help ok" data-testid="screen-granted">
          On. {BRAND.name} looks at the screen only when you select something, never in the background.
        </p>
      ) : (
        <>
          <p className="help warn" data-testid="screen-denied">
            Off. {BRAND.name} needs it to see what you select. Turn {BRAND.name} on under Screen &amp; System Audio
            Recording, then restart it.
          </p>
          <span className="key-row">
            <button type="button" className="secondary" onClick={() => void invoke('open_privacy_settings')}>
              Open System Settings
            </button>
            <button type="button" className="secondary" onClick={() => void invoke('relaunch')}>
              Restart {BRAND.name}
            </button>
          </span>
        </>
      )}
      <ul className="help facts" data-testid="permission-facts">
        <li>
          It is the <b>only</b> permission {BRAND.name} asks for: no accessibility access, no microphone, no keystrokes.
          macOS names the switch &ldquo;Screen &amp; System Audio Recording&rdquo;; {BRAND.name} never records audio.
        </li>
        <li>Only the area you select is captured, and it goes only to the AI you picked.</li>
      </ul>
    </div>
  );
}
