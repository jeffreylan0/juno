/**
 * How a window of the app talks to the native core and to the other
 * windows: commands (invoke) and events. Behind an interface so the browser
 * shim (browser.ts) can be tested with several windows in one process
 * (tests/unit/desktop-browser.test.ts).
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, emitTo } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export interface Transport {
  /** This window's label: core, overlay, panel or settings. */
  readonly label: string;
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Events sent to this window, or to every window. */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
  /** An event for one window only. */
  emitTo(label: string, event: string, payload: unknown): Promise<void>;
  /** An event for every window. */
  emit(event: string, payload: unknown): Promise<void>;
}

export function tauriTransport(): Transport {
  const self = getCurrentWebviewWindow();
  return {
    label: self.label,
    invoke: (command, args) => invoke(command, args),
    // On the window, not app-wide: an app-wide listener would also hear
    // events meant for the other windows.
    listen: (event, handler) => self.listen(event, (e) => handler(e.payload as never)),
    emitTo: (label, event, payload) => emitTo(label, event, payload),
    emit: (event, payload) => emit(event, payload),
  };
}
