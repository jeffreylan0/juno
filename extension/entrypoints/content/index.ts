/**
 * Content script. Injected on toolbar click or shortcut (activeTab), never on
 * every page. The selection flow itself lives in lib/selection-controller.ts,
 * which the PDF reader shares — Chrome will not inject a content script into an
 * extension page, so the reader runs the same code directly.
 */
import type { StartSelectionMsg } from '@/lib/messages';
import { SelectionController } from '@/lib/selection-controller';

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

    const controller = new SelectionController({ host: ctx });

    browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
      const msg = raw as { type?: string };
      if (msg?.type === 'ping') {
        sendResponse('pong');
        return;
      }
      if (msg?.type === 'selection:abort') {
        controller.abort();
        return;
      }
      if (msg?.type === 'panel:needs-click') {
        controller.promptForPanel();
        return;
      }
      if (msg?.type === 'selection:start') {
        void controller.start((raw as StartSelectionMsg).kind);
        return;
      }
      if (msg?.type?.startsWith('bar:')) {
        const answer = controller.handle(msg.type);
        if (answer !== undefined) sendResponse(answer);
      }
    });
  },
});
