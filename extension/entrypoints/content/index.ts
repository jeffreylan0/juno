/**
 * Content script. Injected on toolbar click or shortcut (activeTab), never on
 * every page. The selection flow itself lives in lib/selection-controller.ts,
 * which the PDF reader shares — Chrome will not inject a content script into an
 * extension page, so the reader runs the same code directly.
 *
 * A second injection into the same page (the extension was reloaded, or two
 * clicks raced the ping) takes over from the first: WXT tells the older copy
 * it is invalidated, and it takes its bar and listeners with it.
 */
import type { BarControlMsg } from '@/lib/messages';
import { SelectionController } from '@/lib/selection-controller';

export default defineContentScript({
  matches: ['<all_urls>'],
  // Not listed in the manifest; the background injects it with scripting.executeScript.
  registration: 'runtime',
  cssInjectionMode: 'ui',
  main(ctx) {
    const controller = new SelectionController({ host: ctx });

    const onMessage = (raw: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
      const msg = raw as { type?: string };
      if (msg?.type === 'ping') {
        sendResponse('pong');
        return;
      }
      if (msg?.type === 'panel:needs-click') controller.promptForPanel();
      else if (msg?.type?.startsWith('bar:')) controller.handle(raw as BarControlMsg);
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => {
      try {
        browser.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* the extension is already gone */
      }
    });
  },
});
