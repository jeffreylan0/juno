/**
 * The selection flow, shared by the content script and the PDF reader.
 *
 * Chrome refuses to inject content scripts into extension pages, so the reader
 * cannot be driven the usual way. Both surfaces instead own one of these and
 * feed it `selection:start` from whichever channel reaches them.
 */
import type { SelectionKind } from '@shared/payload';
import { Overlay, type OverlayHost } from '@/entrypoints/content/overlay';
import { showToast } from '@/entrypoints/content/toast';
import { availableModes, detectPdf, readerUrlFor, type PdfContext } from './pdf-detect';
import type { SelectionCancelMsg, SelectionCommittedMsg, SelectionDoneMsg } from './messages';
import { getSettings } from './storage';

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
  /** Bumped by every start(), so a superseded arming ends quietly. */
  private generation = 0;
  /** Set when the bar's X ended the selection: the panel closes too. */
  private closing = false;

  constructor(private opts: SelectionControllerOptions = {}) {
    const doc = opts.doc ?? document;
    this.pdf = detectPdf(doc);
    this.modes = availableModes(this.pdf);
    this.overlay = new Overlay(opts.host ?? { onInvalidated: () => {} }, {
      onModeChange: (kind) => void this.start(kind),
      onClose: () => (this.closing = true),
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

  /** Escape cancels the selection; the bar's X also closes the answer panel. */
  private cancel(): void {
    const msg: SelectionCancelMsg = { type: 'selection:cancel', closePanel: this.closing };
    this.closing = false;
    void browser.runtime.sendMessage(msg).catch(() => {});
  }

  async start(requested: SelectionKind): Promise<void> {
    const gen = ++this.generation;
    // Switching mode re-arms; drop whatever is running first. The arming it
    // replaces resolves null, but it is not a cancel, so it must not say so.
    this.overlay.abort();
    this.closing = false;
    const current = () => gen === this.generation;
    const kind = this.modes.includes(requested) ? requested : (this.modes[0] as SelectionKind);
    const page = { url: location.href, title: document.title };
    const devicePixelRatio = window.devicePixelRatio || 1;

    if (kind === 'text') {
      const sel = await this.overlay.selectText(this.modes);
      if (!sel) return void (current() && this.cancel());
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
      const adjust = await this.adjustBox();
      if (!current()) return;
      const armed = this.overlay.selectBox(this.modes, { adjust });
      if (this.pdf.isPdf) this.offerReader();
      const rect = await armed;
      if (!rect) return void (current() && this.cancel());
      this.commit('box');
      // Overlay is gone; wait two frames so the capture does not include it.
      await nextPaint();
      // Only the crop is sent: reading it is the model's job, and scraping
      // page text from under the box garbled real layouts (see planner.ts).
      const done: SelectionDoneMsg = { type: 'selection:done', kind: 'box', rect, devicePixelRatio, page };
      await browser.runtime.sendMessage(done);
      return;
    }

    if (kind === 'freeform') {
      const armed = this.overlay.selectFreeform(this.modes);
      if (this.pdf.isPdf) this.offerReader();
      const lasso = await armed;
      if (!lasso) return void (current() && this.cancel());
      this.commit('freeform');
      await nextPaint();
      const done: SelectionDoneMsg = { type: 'selection:done', kind: 'freeform', rect: lasso.rect, path: lasso.path, devicePixelRatio, page };
      await browser.runtime.sendMessage(done);
      return;
    }

    // element
    const picked = await this.overlay.selectElement(this.modes);
    if (!picked) return void (current() && this.cancel());
    // The picking click is the gesture that can open the panel.
    this.commit('element');
    await nextPaint();
    const done: SelectionDoneMsg = {
      type: 'selection:done',
      kind: 'element',
      rect: picked.rect,
      label: picked.label,
      clipped: picked.clipped,
      devicePixelRatio,
      page,
    };
    await browser.runtime.sendMessage(done);
  }

  private async adjustBox(): Promise<boolean> {
    try {
      return (await getSettings()).adjustBox;
    } catch {
      return false;
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
