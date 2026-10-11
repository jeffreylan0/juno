/**
 * The overlay window: transparent, over the whole display under the pointer.
 * It runs the extension's selection flow unchanged (lib/selection-controller.ts:
 * the bar, Box and Freeform drawing, Escape and Enter), fed the same `bar:*`
 * messages the background sends a tab.
 *
 * Text and Element read what is on screen through the system's
 * accessibility API, which is the next step of the app; until then their
 * chips are off with a word on why (surface.tsx).
 */
import { browser, transport } from '../platform/install';
import type { BarControlMsg } from '@/lib/messages';
import { SelectionController } from '@/lib/selection-controller';
import type { OverlayTip } from '../core/tips';
import { trackPointer } from './pointer';
import { showTip } from './tips';

const controller = new SelectionController({ modes: ['box', 'freeform'] });

const announce = () => void browser.runtime.sendMessage({ type: 'overlay:ready' });

browser.runtime.onMessage.addListener((raw) => {
  const msg = raw as { type?: string; tip?: OverlayTip };
  if (msg?.type?.startsWith('bar:')) controller.handle(raw as BarControlMsg);
  else if (msg?.type === 'overlay:tip' && msg.tip) showTip(msg.tip);
  else if (msg?.type === 'overlay:ping') announce();
});

trackPointer(transport);
void browser.ready.then(announce);
