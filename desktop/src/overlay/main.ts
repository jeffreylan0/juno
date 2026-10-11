/**
 * The overlay window: transparent, over the whole display under the pointer.
 * It runs the extension's selection flow unchanged (lib/selection-controller.ts:
 * the bar, the drawing, Escape and Enter), fed the same `bar:*` messages the
 * background sends a tab, plus the notes the bar carries for the app
 * (notices.ts).
 *
 * Box and Freeform for now; Text and Element are switched off (below).
 */
import { invoke } from '@tauri-apps/api/core';
import { browser, transport } from '../platform/install';
import type { BarControlMsg } from '@/lib/messages';
import type { ScreenRead } from '@/lib/screen-text';
import { SelectionController } from '@/lib/selection-controller';
import type { OverlayNotice } from '../core/tips';
import { noticeFor } from './notices';
import { trackPointer } from './pointer';

/** The screen under the overlay, read by the native core. */
async function readScreen(): Promise<ScreenRead> {
  try {
    return await invoke<ScreenRead>('read_screen', { viewport: { width: innerWidth, height: innerHeight } });
  } catch (err) {
    // Screen Recording is off: the bar asks for it.
    if ((err as { code?: string })?.code === 'permission') void browser.runtime.sendMessage({ type: 'screen:denied' });
    throw err;
  }
}

/**
 * Text and Element on what the core reads off the screen are off for now:
 * reading pixels is close but not exact, and how the app should reach what
 * apps show (a browser bridge, macOS Services, accessibility) is still to be
 * chosen (README). A build with VITE_SCREEN_MODES=1 turns them on: the
 * end-to-end tests' build, or `VITE_SCREEN_MODES=1 pnpm desktop:dev` to try them.
 */
const SCREEN_MODES = (import.meta.env.VITE_SCREEN_MODES as string | undefined) === '1';

const controller = new SelectionController({
  modes: SCREEN_MODES ? ['box', 'freeform', 'element', 'text'] : ['box', 'freeform'],
  screen: SCREEN_MODES ? readScreen : undefined,
  // The system leaves the app's windows out of every screenshot, so the dim can fade after a selection.
  captureExcludesOverlay: true,
});

const announce = () => void browser.runtime.sendMessage({ type: 'overlay:ready' });

browser.runtime.onMessage.addListener((raw) => {
  const msg = raw as { type?: string; notice?: OverlayNotice | null };
  if (msg?.type?.startsWith('bar:')) controller.handle(raw as BarControlMsg);
  else if (msg?.type === 'overlay:notice') controller.notice(msg.notice ? noticeFor(msg.notice, () => controller.notice(null)) : null);
  else if (msg?.type === 'overlay:ping') announce();
});

trackPointer(transport);
void browser.ready.then(announce);
