/**
 * The overlay window: transparent, over the whole display under the pointer.
 * It runs the selection flow (lib/selection-controller.ts: the bar, the
 * drawing, Escape and Enter), fed the core's `bar:*` messages, the notes the
 * bar carries (notices.ts) and whether the panel is open. The bar always starts in Box
 * (core/main.ts).
 */
import { invoke } from '@tauri-apps/api/core';
import { browser, note, transport } from '../platform/install';
import type { BarControlMsg } from '@/lib/messages';
import { SelectionController } from '@/lib/selection-controller';
import type { OverlayNotice } from '../core/tips';
import { noticeFor } from './notices';
import { trackPointer } from './pointer';

const controller = new SelectionController({
  // A wheel while armed scrolls the app beneath: the window lets the pointer
  // through until it moves (wm.rs), and the dim stays put meanwhile.
  scrollThrough: () => void invoke('overlay_scroll_through').catch(() => {}),
  onChats: () => void browser.runtime.sendMessage({ type: 'chats:open' }),
});

const announce = () => void browser.runtime.sendMessage({ type: 'overlay:ready' });

/** The first bar of a run, for the app's log: what the overlay window looked like then. */
let barNoted = false;

browser.runtime.onMessage.addListener((raw) => {
  const msg = raw as { type?: string; notice?: OverlayNotice | null; open?: boolean };
  if (msg?.type === 'bar:show' && !barNoted) {
    barNoted = true;
    note(`first bar, page ${innerWidth}x${innerHeight} at ${devicePixelRatio}x, ${document.visibilityState}`);
  }
  if (msg?.type?.startsWith('bar:')) controller.handle(raw as BarControlMsg);
  else if (msg?.type === 'overlay:notice') controller.notice(msg.notice ? noticeFor(msg.notice, () => controller.notice(null)) : null);
  else if (msg?.type === 'overlay:ping') announce();
  else if (msg?.type === 'overlay:panel') controller.panelOpen(!!msg.open);
});

// The menu bar, Dock or taskbar of the display the overlay is on (wm.rs): the bar stays inside them.
void transport.listen<Record<'top' | 'right' | 'bottom' | 'left', number>>('overlay:insets', (insets) => {
  for (const [side, px] of Object.entries(insets)) document.documentElement.style.setProperty(`--sai-inset-${side}`, `${px}px`);
});

trackPointer(transport);
void browser.ready.then(announce);
