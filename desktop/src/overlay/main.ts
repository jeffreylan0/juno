/**
 * The overlay window: transparent, over the whole display under the pointer.
 * It runs the extension's selection flow unchanged (lib/selection-controller.ts:
 * the bar, the drawing, Escape and Enter), fed the same `bar:*` messages the
 * background sends a tab, plus the notes the bar carries for the app
 * (notices.ts).
 */
import { invoke } from '@tauri-apps/api/core';
import { browser, note, transport } from '../platform/install';
import type { BarControlMsg } from '@/lib/messages';
import { SelectionController } from '@/lib/selection-controller';
import type { OverlayNotice } from '../core/tips';
import { noticeFor } from './notices';
import { trackPointer } from './pointer';

const controller = new SelectionController({
  // The system leaves the app's windows out of every screenshot, so the dim can fade after a selection.
  captureExcludesOverlay: true,
  // A wheel while armed scrolls the app beneath: the window lets the pointer
  // through until it moves (wm.rs), and the dim stays put meanwhile.
  scrollThrough: () => void invoke('overlay_scroll_through').catch(() => {}),
});

const announce = () => void browser.runtime.sendMessage({ type: 'overlay:ready' });

/** The first bar of a run, for the app's log: what the overlay window looked like then. */
let barNoted = false;

browser.runtime.onMessage.addListener((raw) => {
  const msg = raw as { type?: string; notice?: OverlayNotice | null };
  if (msg?.type === 'bar:show' && !barNoted) {
    barNoted = true;
    note(`first bar, page ${innerWidth}x${innerHeight} at ${devicePixelRatio}x, ${document.visibilityState}`);
  }
  if (msg?.type?.startsWith('bar:')) controller.handle(raw as BarControlMsg);
  else if (msg?.type === 'overlay:notice') controller.notice(msg.notice ? noticeFor(msg.notice, () => controller.notice(null)) : null);
  else if (msg?.type === 'overlay:ping') announce();
});

trackPointer(transport);
void browser.ready.then(announce);
