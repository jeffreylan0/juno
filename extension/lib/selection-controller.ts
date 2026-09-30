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
import { getSettings, lastKindItem } from './storage';

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
  /** This page's bar has added a selection to the chat in progress. */
  private delivered = false;
  /** The background has been told a bar is up here. */
  private shown = false;

  constructor(private opts: SelectionControllerOptions = {}) {
    const doc = opts.doc ?? document;
    this.pdf = detectPdf(doc);
    this.modes = availableModes(this.pdf);
    this.overlay = new Overlay(opts.host ?? { onInvalidated: () => {} }, {
      onModeChange: (kind) => {
        // The icon starts wherever the student left off next time.
        void lastKindItem.setValue(kind).catch(() => {});
        void this.start(kind);
      },
      onClose: () => this.finish(),
    });
    // Back from the back/forward cache with a bar still on the page: say so,
    // and drop the bar if the chat it was waiting on finished meanwhile.
    addEventListener('pageshow', (e) => {
      if (e.persisted && this.overlay.active) void this.announce();
    });
  }

  /** Tells the background a bar is up here. Resolves with whether a chat is in progress. */
  private async announce(): Promise<void> {
    this.shown = true;
    const reply = (await browser.runtime.sendMessage({ type: 'bar:shown' }).catch(() => null)) as { inChat?: boolean } | null;
    if (reply && reply.inChat === false && this.delivered && !this.overlay.selecting) this.handle('bar:end');
  }

  get selectionModes(): SelectionKind[] {
    return this.modes;
  }

  /** Escape from outside (the background): stop the selection being made. */
  abort(): void {
    this.overlay.abort();
  }

  /**
   * Messages about the bar, from whichever channel reaches this surface.
   * Returns the answer for those that expect one.
   */
  handle(type: string | undefined): boolean | undefined {
    switch (type) {
      case 'bar:alive':
        return this.overlay.active;
      case 'bar:end':
        // The chat was finished (✕ here or on another tab): the bar goes.
        this.generation++;
        this.overlay.abort();
        this.overlay.unmount();
        this.delivered = false;
        this.shown = false;
        return undefined;
      case 'bar:pause':
        // A selection started on another tab: this one waits, ready.
        if (this.overlay.selecting) {
          this.generation++;
          this.overlay.ready(this.modes);
        }
        return undefined;
      default:
        return undefined;
    }
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

  /**
   * Escape stopped the selection. Once this bar has added something, it waits
   * for the next one; before that, Escape means "never mind" and the bar goes.
   */
  private stopped(): void {
    const msg: SelectionCancelMsg = { type: 'selection:cancel' };
    void browser.runtime.sendMessage(msg).catch(() => {});
    if (this.delivered) {
      this.overlay.ready(this.modes);
      return;
    }
    this.overlay.unmount();
    if (this.shown) {
      this.shown = false;
      void browser.runtime.sendMessage({ type: 'bar:gone' }).catch(() => {});
    }
  }

  /** The bar's ✕: the chat is finished, here and on every other tab. */
  private finish(): void {
    this.generation++;
    this.overlay.unmount();
    this.delivered = false;
    this.shown = false;
    void browser.runtime.sendMessage({ type: 'chat:finish' }).catch(() => {});
  }

  async start(requested: SelectionKind): Promise<void> {
    const gen = ++this.generation;
    // Switching mode re-arms; drop whatever is running first. The arming it
    // replaces resolves null, but it is not a cancel, so it must not say so.
    this.overlay.abort();
    const current = () => gen === this.generation;
    const kind = this.modes.includes(requested) ? requested : (this.modes[0] as SelectionKind);

    const pending = this.select(kind, current);
    // Every time, not just the first: a bar the background lost track of
    // (a tab that did not answer in time, one moved to another window) is
    // listed again.
    void this.announce();
    const done = await pending;
    if (!current()) return;
    if (!done) return this.stopped();
    // Answered once the screenshot is taken, so the bar never shows in it.
    await browser.runtime.sendMessage(done).catch(() => {});
    if (!current()) return;
    this.delivered = true;
    this.overlay.ready(this.modes);
  }

  /** Runs one selection in `kind`; resolves with what to send, or null if it was stopped. */
  private async select(kind: SelectionKind, current: () => boolean): Promise<SelectionDoneMsg | null> {
    const page = { url: location.href, title: document.title };
    const devicePixelRatio = window.devicePixelRatio || 1;

    if (kind === 'text') {
      const sel = await this.overlay.selectText(this.modes);
      if (!sel) return null;
      this.commit('text');
      return { type: 'selection:done', kind: 'text', rect: sel.rect, text: sel.text, html: sel.html, devicePixelRatio, page };
    }

    if (kind === 'box') {
      const adjust = await this.adjustBox();
      if (!current()) return null;
      const armed = this.overlay.selectBox(this.modes, { adjust });
      if (this.pdf.isPdf) this.offerReader();
      const rect = await armed;
      if (!rect) return null;
      this.commit('box');
      // Overlay is gone; wait two frames so the capture does not include it.
      await nextPaint();
      // Only the crop is sent: reading it is the model's job, and scraping
      // page text from under the box garbled real layouts (see planner.ts).
      return { type: 'selection:done', kind: 'box', rect, devicePixelRatio, page };
    }

    if (kind === 'freeform') {
      const armed = this.overlay.selectFreeform(this.modes);
      if (this.pdf.isPdf) this.offerReader();
      const lasso = await armed;
      if (!lasso) return null;
      this.commit('freeform');
      await nextPaint();
      return { type: 'selection:done', kind: 'freeform', rect: lasso.rect, path: lasso.path, devicePixelRatio, page };
    }

    const picked = await this.overlay.selectElement(this.modes);
    if (!picked) return null;
    // The picking click is the gesture that can open the panel.
    this.commit('element');
    await nextPaint();
    return {
      type: 'selection:done',
      kind: 'element',
      rect: picked.rect,
      label: picked.label,
      clipped: picked.clipped,
      devicePixelRatio,
      page,
    };
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
