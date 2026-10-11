/**
 * The notes the core asks the bar to carry, attached under its row the way
 * Claude's quick entry asks for a permission: a line on what is needed, the
 * one button that does it, and "Not now".
 */
import { invoke } from '@tauri-apps/api/core';
import { BRAND } from '@/brand';
import type { BarNotice } from '@/entrypoints/content/bar';
import { formatShortcut } from '@/ui/useShortcut';
import { browser } from '../platform/install';
import type { OverlayNotice } from '../core/tips';
import { MAC } from '../os';

/** The core's desktop-only words from the bar (core/main.ts). */
export type NoticeReply = { type: 'screen:enable' } | { type: 'screen:later' };

const tell = (msg: NoticeReply) => void browser.runtime.sendMessage(msg);

export function noticeFor(which: OverlayNotice, dismiss: () => void): BarNotice {
  switch (which) {
    case 'screen-permission':
      return {
        id: which,
        title: 'Select anything on your screen',
        text: 'Needs Screen Recording permission',
        actions: [
          { label: 'Turn on Screen Recording', primary: true, testid: 'notice-screen-enable', onClick: () => tell({ type: 'screen:enable' }) },
          { label: 'Not now', testid: 'notice-later', onClick: () => tell({ type: 'screen:later' }) },
        ],
      };
    case 'screen-restart':
      return {
        id: which,
        title: `Restart ${BRAND.name} to finish`,
        text: 'macOS turns on Screen Recording after a restart',
        actions: [
          { label: 'Restart', primary: true, testid: 'notice-restart', onClick: () => void invoke('relaunch') },
          { label: 'Open System Settings', testid: 'notice-screen-enable', onClick: () => tell({ type: 'screen:enable' }) },
        ],
      };
    case 'shortcut-taken': {
      const keys = formatShortcut(MAC ? '⌥⇧S' : 'Alt+Shift+S');
      return {
        id: which,
        title: `Another app is using ${keys}`,
        text: `Select from ${BRAND.iconName} instead`,
        actions: [{ label: 'Got it', testid: 'notice-ok', onClick: dismiss }],
      };
    }
  }
}
