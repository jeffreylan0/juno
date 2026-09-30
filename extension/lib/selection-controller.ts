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
  /** The mode being selected in right now, or null while the bar waits. */
  private armed: SelectionKind | null = null;
  /**
   * A selection has been committed and is being captured: the bar is off the
   * page for the screenshot, and nothing may put it back until that is done.
   */
  private delivering = false;

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
      // Escape while the bar waits: hide it (and the panel), like ✕.
      onEscapeWhileWaiting: () => this.finish(),
    });
  }

  get selectionModes(): SelectionKind[] {
    return this.modes;
  }

  /** Escape from outside (the background): stop the selection being made. */
  abort(): void {
    this.overlay.abort();
  }

  /**
   * The background places the window's one bar: here, in a mode or waiting
   * (`bar:show`), or away (`bar:hide`: another tab is active, or the chat was
   * finished). Returns the answer for messages that expect one.
   */
  handle(type: string | undefined, mode?: SelectionKind | null): boolean | undefined {
    switch (type) {
      case 'bar:show':
        this.show(mode ?? null);
        return undefined;
      case 'bar:hide':
        this.generation++;
        this.armed = null;
        this.overlay.abort();
        this.overlay.unmount();
        return undefined;
      case 'bar:alive':
        return this.overlay.active;
      default:
        return undefined;
    }
  }

  /** Shows the bar in this state, unless it already is. */
  private show(mode: SelectionKind | null): void {
    // Mid-capture the bar comes back by itself, waiting, once the shot is taken.
    if (this.delivering) return;
    if (mode === null) {
      if (this.armed) {
        // A selection started here beats a placement that set out before it:
        // keep selecting, and put the background right.
        void browser.runtime.sendMessage({ type: 'bar:state', mode: this.armed }).catch(() => {});
        return;
      }
      if (this.overlay.active) return; // already waiting
      this.generation++;
      this.armed = null;
      this.overlay.ready(this.modes);
      return;
    }
    if (this.armed === mode) return; // already selecting in it (perhaps still setting up)
    void this.start(mode, false);
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
    this.delivering = true;
    const msg: SelectionCommittedMsg = { type: 'selection:committed', kind };
    void browser.runtime.sendMessage(msg).catch(() => {});
  }

  /**
   * Escape stopped the selection. The bar then waits — unless nothing has been
   * selected in this chat yet, when Escape means "never mind" and the bar (and
   * the panel) go. The background knows which, and says.
   */
  private async stopped(gen: number): Promise<void> {
    this.armed = null;
    const msg: SelectionCancelMsg = { type: 'selection:cancel' };
    const reply = (await browser.runtime.sendMessage(msg).catch(() => null)) as { end?: boolean } | null;
    if (gen !== this.generation) return;
    if (reply?.end) this.overlay.unmount();
    else this.overlay.ready(this.modes);
  }

  /** ✕ on the bar, or Escape while it waits: the bar and the panel go, the chat is finished. */
  private finish(): void {
    this.generation++;
    this.armed = null;
    this.overlay.unmount();
    void browser.runtime.sendMessage({ type: 'chat:finish' }).catch(() => {});
  }

  /** Arms a selection in `kind`. `report` tells the background, so the bar follows in this mode. */
  async start(requested: SelectionKind, report = true): Promise<void> {
    const gen = ++this.generation;
    // Switching mode re-arms; drop whatever is running first. The arming it
    // replaces resolves null, but it is not a cancel, so it must not say so.
    this.overlay.abort();
    const current = () => gen === this.generation;
    const kind = this.modes.includes(requested) ? requested : (this.modes[0] as SelectionKind);
    this.armed = kind;
    if (report) void browser.runtime.sendMessage({ type: 'bar:state', mode: kind }).catch(() => {});

    const done = await this.select(kind, current);
    if (!current()) return;
    if (!done) return this.stopped(gen);
    this.armed = null;
    // Answered once the screenshot is taken, so the bar never shows in it.
    await browser.runtime.sendMessage(done).catch(() => {});
    this.delivering = false;
    if (!current()) return;
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
