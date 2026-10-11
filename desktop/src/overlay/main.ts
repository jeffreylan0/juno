/**
 * The overlay window: transparent, over the whole display under the pointer.
 * It runs the extension's selection flow unchanged (lib/selection-controller.ts:
 * the bar, Box and Freeform drawing, Escape and Enter), fed the same `bar:*`
 * messages the background sends a tab, plus the notes the bar carries for
 * the app (notices.ts).
 *
 * Text and Element read what is on screen through the system's
 * accessibility API, which is the next step of the app; until then their
 * chips are off with a word on why (surface.tsx).
 */
import { browser, transport } from '../platform/install';
import type { BarControlMsg } from '@/lib/messages';
import { SelectionController } from '@/lib/selection-controller';
import type { OverlayNotice } from '../core/tips';
import { noticeFor } from './notices';
import { trackPointer } from './pointer';

const controller = new SelectionController({ modes: ['box', 'freeform'] });

const announce = () => void browser.runtime.sendMessage({ type: 'overlay:ready' });

browser.runtime.onMessage.addListener((raw) => {
  const msg = raw as { type?: string; notice?: OverlayNotice | null };
  if (msg?.type?.startsWith('bar:')) controller.handle(raw as BarControlMsg);
  else if (msg?.type === 'overlay:notice') controller.notice(msg.notice ? noticeFor(msg.notice, () => controller.notice(null)) : null);
  else if (msg?.type === 'overlay:ping') announce();
});

trackPointer(transport);
void browser.ready.then(announce);
