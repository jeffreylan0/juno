/**
 * Content script. Injected on toolbar click or shortcut (activeTab), never on
 * every page. Mounts the overlay on demand, answers pings so the background
 * does not inject twice, and re-arms cleanly when the popup switches mode.
 */
import type { SelectionDoneMsg, StartSelectionMsg } from '@/lib/messages';
import { textInRect } from '@/extract/visible';
import { Overlay } from './overlay';

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
      const msg = raw as { type?: string; kind?: string };
      if (msg?.type === 'ping') {
        sendResponse('pong');
        return;
      }
      if (msg?.type === 'selection:abort') {
        overlay.abort();
        return;
      }
      if (msg?.type === 'selection:start') {
        void handleStart(raw as StartSelectionMsg);
      }
    });

    async function handleStart(msg: StartSelectionMsg): Promise<void> {
      // Switching mode from the popup re-arms; drop whatever is running first.
      overlay.abort();
      const page = { url: location.href, title: document.title };
      const devicePixelRatio = window.devicePixelRatio || 1;

      if (msg.kind === 'text') {
        const sel = await overlay.selectText();
        if (!sel) return void browser.runtime.sendMessage({ type: 'selection:cancel' });
        const done: SelectionDoneMsg = {
          type: 'selection:done',
          kind: 'text',
          rect: sel.rect,
          text: sel.text,
          html: sel.html,
          devicePixelRatio,
          page,
        };
        await browser.runtime.sendMessage(done);
        return;
      }

      if (msg.kind === 'box') {
        const rect = await overlay.selectBox();
        if (!rect) return void browser.runtime.sendMessage({ type: 'selection:cancel' });
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
