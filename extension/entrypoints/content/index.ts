/**
 * Content script. Injected on toolbar click or shortcut (activeTab), never on
 * every page. Mounts the overlay on demand, answers pings so the background
 * does not inject twice, and tracks modifier keys for the selectors.
 */
import type { StartSelectionMsg, SelectionDoneMsg } from '@/lib/messages';
import { Overlay } from './overlay';
import { selectText } from './select-text';
import { textInRect } from '@/extract/visible';

declare global {
  interface Window {
    __selectionAiLoaded?: boolean;
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  // Not listed in the manifest; the background injects it with scripting.executeScript.
  registration: 'runtime',
  cssInjectionMode: 'ui',
  async main(ctx) {
    if (window.__selectionAiLoaded) return;
    window.__selectionAiLoaded = true;

    const overlay = new Overlay(ctx);

    browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
      const msg = raw as { type?: string };
      if (msg?.type === 'ping') {
        sendResponse('pong');
        return;
      }
      if (msg?.type === 'selection:start') {
        void handleStart(msg as StartSelectionMsg);
      }
    });

    async function handleStart(msg: StartSelectionMsg): Promise<void> {
      const page = { url: location.href, title: document.title };
      const devicePixelRatio = window.devicePixelRatio || 1;
      if (msg.kind === 'text') {
        const sel = selectText();
        if (!sel) {
          // Nothing selected: fall back to drawing a box.
          return handleStart({ type: 'selection:start', kind: 'box' });
        }
        const done: SelectionDoneMsg = { type: 'selection:done', kind: 'text', devicePixelRatio, page, ...sel };
        await browser.runtime.sendMessage(done);
        return;
      }
      if (msg.kind === 'box') {
        const rect = await overlay.selectBox();
        if (!rect) {
          await browser.runtime.sendMessage({ type: 'selection:cancel' });
          return;
        }
        // Overlay is gone; wait two frames so the capture does not include it.
        await nextPaint();
        // Visible DOM text inside the box rides along so the planner can prefer
        // the exact form (and so the ask still works if the capture fails).
        let text: string | undefined;
        try {
          text = textInRect(rect) || undefined;
        } catch {
          text = undefined;
        }
        const done: SelectionDoneMsg = { type: 'selection:done', kind: 'box', rect, devicePixelRatio, page, text };
        await browser.runtime.sendMessage(done);
        return;
      }
      // 'element' arrives in week 4 (select-element.ts).
      await browser.runtime.sendMessage({ type: 'selection:cancel' });
    }
  },
});

function nextPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
