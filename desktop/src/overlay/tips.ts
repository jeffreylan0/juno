/**
 * The yellow tooltips the core asks for, at the top of the display: the
 * extension's tooltip (lib/tooltip.ts), with the app's words and buttons.
 */
import { invoke } from '@tauri-apps/api/core';
import { BRAND } from '@/brand';
import { showPageTooltip } from '@/lib/tooltip';
import { formatShortcut } from '@/ui/useShortcut';
import type { OverlayTip } from '../core/tips';
import { MAC } from '../os';

export function showTip(which: OverlayTip): void {
  switch (which) {
    case 'screen-permission':
      showPageTooltip({
        text: `${BRAND.name} needs Screen Recording to see what you select. Turn it on in System Settings, then restart ${BRAND.name}.`,
        testid: 'tip-screen-permission',
        stayMs: 0,
        actions: [
          { label: 'Open System Settings', testid: 'tip-open-settings', onClick: () => void invoke('open_privacy_settings') },
          { label: 'Restart', testid: 'tip-restart', onClick: () => void invoke('relaunch') },
        ],
      });
      return;
    case 'shortcut-taken': {
      const keys = formatShortcut(MAC ? '⌥⇧S' : 'Alt+Shift+S');
      showPageTooltip({
        text: `Another app is using ${keys}, so it does nothing. Click ${BRAND.iconName} to select instead.`,
        testid: 'tip-shortcut-taken',
      });
      return;
    }
  }
}
