/**
 * The selection flow, shared by the content script and the PDF reader.
 *
 * Chrome refuses to inject content scripts into extension pages, so the reader
 * cannot be driven the usual way. Both surfaces instead own one of these and
 * feed it `selection:start` from whichever channel reaches them.
 */
import type { Rect, SelectionKind } from '@shared/payload';
import { Overlay, type OverlayHost } from '@/entrypoints/content/overlay';
import { textInRect } from '@/extract/visible';
import { showToast } from '@/entrypoints/content/toast';
import { availableModes, detectPdf, readerUrlFor, type PdfContext } from './pdf-detect';
import type { SelectionCommittedMsg, SelectionDoneMsg } from './messages';

export interface SelectionControllerOptions {
  /** Invalidation hook; the content script has one, the reader does not. */
  host?: OverlayHost;
  /** Override the document under test. */
  doc?: Document;
}

export class SelectionController {
  private overlay: Overlay;
  private pdf: PdfContext;
  private modes: SelectionKind[];

  constructor(private opts: SelectionControllerOptions = {}) {
    const doc = opts.doc ?? document;
    this.pdf = detectPdf(doc);
    this.modes = availableModes(this.pdf);
    this.overlay = new Overlay(opts.host ?? { onInvalidated: () => {} }, {
      onModeChange: (kind) => void this.start(kind),
    });
  }

  get selectionModes(): SelectionKind[] {
    return this.modes;
  }

  abort(): void {
    this.overlay.abort();
  }

  /**
   * Chrome refused to open the answer panel because the drag's activation had
   * lapsed. A click here is a fresh gesture in a page context, which it accepts.
   */
  promptForPanel(): void {
    showToast('Your answer is ready.', {
      label: 'Show it',
      onClick: () => void browser.runtime.sendMessage({ type: 'panel:open' }).catch(() => {}),
    });
  }

  /**
   * Fired the moment a selection is committed, before any capture or text
   * extraction. Chrome will open the side panel from a user gesture in an
   * extension context, but only while that activation is still live —
   * everything after this point is too late.
   */
  private commit(kind: SelectionKind): void {
    const msg: SelectionCommittedMsg = { type: 'selection:committed', kind };
    void browser.runtime.sendMessage(msg).catch(() => {});
  }

  private cancel(): void {
    void browser.runtime.sendMessage({ type: 'selection:cancel' }).catch(() => {});
  }

  async start(requested: SelectionKind): Promise<void> {
    // Switching mode re-arms; drop whatever is running first.
    this.overlay.abort();
    const kind = this.modes.includes(requested) ? requested : (this.modes[0] as SelectionKind);
    const page = { url: location.href, title: document.title };
    const devicePixelRatio = window.devicePixelRatio || 1;

    if (kind === 'text') {
      const sel = await this.overlay.selectText(this.modes);
      if (!sel) return this.cancel();
      this.commit('text');
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

    if (kind === 'box') {
      const armed = this.overlay.selectBox(this.modes);
      if (this.pdf.isPdf) this.offerReader();
      const rect = await armed;
      if (!rect) return this.cancel();
      this.commit('box');
      // Overlay is gone; wait two frames so the capture does not include it.
      await nextPaint();
      const done: SelectionDoneMsg = {
        type: 'selection:done',
        kind: 'box',
        rect,
        devicePixelRatio,
        page,
        text: this.textIn(rect),
      };
      await browser.runtime.sendMessage(done);
      return;
    }

    // 'element' arrives in week 4 (select-element.ts).
    this.cancel();
  }

  /**
   * Visible DOM text inside the box rides along so the planner can prefer the
   * exact form, and so the ask still works if the capture fails.
   */
  private textIn(rect: Rect): string | undefined {
    try {
      return textInRect(rect, this.opts.doc ?? document) || undefined;
    } catch {
      return undefined;
    }
  }

  /** On a browser PDF viewer, only a screenshot is possible — offer the reader. */
  private offerReader(): void {
    this.overlay.notice(
      "This is the browser's PDF viewer: only a screenshot can be read, and the page cannot scroll while selecting.",
      {
        label: 'Open in reader',
        onClick: () => {
          this.overlay.abort();
          location.href = readerUrlFor(this.pdf.url, (p) => browser.runtime.getURL(p as `/${string}`));
        },
      },
    );
  }
}

function nextPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
