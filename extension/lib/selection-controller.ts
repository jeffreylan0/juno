/**
 * The selection flow, shared by the content script and the PDF reader.
 *
 * Chrome refuses to inject content scripts into extension pages, so the reader
 * cannot be driven the usual way. Both surfaces instead own one of these and
 * feed it the background's `bar:*` messages from whichever channel reaches them.
 *
 * The bar lives on one tab at a time. The icon brings it up (`bar:show`);
 * switching tabs takes it away (`bar:hide`), and the icon brings it back
 * wherever the student is. It stays up through each selection: only the
 * selection's own drawing leaves the page for the screenshot.
 */
import type { Rect, SelectionKind } from '@shared/payload';
import { BRAND } from '@/brand';
import type { BarNotice } from '@/entrypoints/content/bar';
import { windowTitle, type ScreenReader, type ScreenWindow } from './screen-text';
import { Overlay, type OverlayHost } from '@/entrypoints/content/overlay';
import { dismissPageTooltip, showPageTooltip } from './tooltip';
import { availableModes, detectPdf, readerUrlFor, type PdfContext } from './pdf-detect';
import { extensionAlive, send, type BarControlMsg, type RuntimeMessage, type SelectionDoneMsg } from './messages';
import { getSettings, lastKindItem, migrateSettings, settingsItem } from './storage';

export interface SelectionControllerOptions {
  /** Invalidation hook; the content script has one, the reader does not. */
  host?: OverlayHost;
  /** Override the document under test. */
  doc?: Document;
  /**
   * The screenshot never sees the overlay (the app: the system leaves its
   * windows out), so the dim can fade out after a selection instead of
   * vanishing before the shot.
   */
  captureExcludesOverlay?: boolean;
  /** Scrolling while armed goes to what is beneath the overlay (the app; see OverlayOptions). */
  scrollThrough?: () => void;
  /** The modes on offer, when the surface decides (the app); otherwise what the page allows. */
  modes?: SelectionKind[];
  /**
   * Reads the screen, where Text and Element work on what is on it rather
   * than on a page (the app; see lib/screen-text.ts).
   */
  screen?: ScreenReader;
}

export class SelectionController {
  private overlay: Overlay;
  private pdf: PdfContext;
  private modes: SelectionKind[];
  /** Bumped by every start() and every hide, so a superseded selection ends quietly. */
  private generation = 0;
  /** The mode being selected in right now, or null while the bar waits. */
  private armed: SelectionKind | null = null;
  /** A selection has been committed and its screenshot is being taken. */
  private delivering = false;
  /** What the student asked for meanwhile (a chip, the ghost, the icon), done in order once the screenshot is taken. */
  private queued: (() => void)[] = [];
  /** Whether the next selection starts a temporary chat. */
  private ghost = false;
  /** The extension was updated or reloaded under this page: nothing more to do here. */
  private gone = false;
  private doc: Document;
  private screen: ScreenReader | undefined;
  /**
   * The send setting, kept current, so arming never waits on storage: a wait
   * between taking one mode's surface down and putting the next one up shows
   * as a flash of the undimmed screen.
   */
  private adjust: boolean | null = null;
  private unwatch: (() => void) | null = null;

  constructor(opts: SelectionControllerOptions = {}) {
    const doc = (this.doc = opts.doc ?? document);
    this.screen = opts.screen;
    void this.waitsForSend().then((a) => (this.adjust ??= a));
    try {
      this.unwatch = settingsItem.watch((s) => (this.adjust = migrateSettings(s).adjustBox));
    } catch {
      /* no storage here (an orphaned page): read when needed */
    }
    this.pdf = detectPdf(doc);
    this.modes = opts.modes ?? availableModes(this.pdf);
    this.overlay = new Overlay(
      {
      onModeChange: (kind) =>
        this.act(() =>
          this.soon(() => {
            // The icon starts wherever the student left off next time.
            void lastKindItem.setValue(kind).catch(() => {});
            void this.start(kind);
          }),
        ),
      onClose: () => this.act(() => this.finish()),
      // Escape while the bar waits: hide it (and the panel), like ✕.
      onEscapeWhileWaiting: () => this.act(() => this.finish()),
      onGhost: () => this.act(() => this.soon(() => void this.toggleGhost())),
      },
      { fadeAfterShot: !!opts.captureExcludesOverlay, scrollThrough: opts.scrollThrough },
    );
    // A newer copy of this script took over, or the extension went away.
    opts.host?.onInvalidated(() => this.destroy());
    doc.addEventListener('visibilitychange', this.onVisibility);
  }

  get selectionModes(): SelectionKind[] {
    return this.modes;
  }

  /** A note attached under the bar (the app's permissions, say), or null to take it away. */
  notice(notice: BarNotice | null): void {
    if (!this.gone) this.overlay.setNotice(notice);
  }

  /** A message from the background for the bar on this page. */
  handle(msg: BarControlMsg): void {
    if (this.gone) return;
    switch (msg.type) {
      case 'bar:show':
        this.setGhost(msg.ghost);
        if (msg.arm === false) this.waiting();
        else this.summoned(msg.mode);
        return;
      case 'bar:hide':
        this.hide();
        return;
      case 'bar:ghost':
        this.setGhost(msg.on);
        return;
    }
  }

  /** The icon (or a shortcut) was pressed on this page: select in `mode`. */
  private summoned(mode: SelectionKind): void {
    const kind = this.modes.includes(mode) ? mode : (this.modes[0] as SelectionKind);
    if (this.armed === kind) return; // already selecting in it (perhaps still setting up)
    this.soon(() => void this.start(kind));
  }

  /** The bar up with nothing armed; a selection already armed carries on. */
  private waiting(): void {
    if (this.armed) return;
    this.soon(() => {
      if (this.armed) return;
      this.generation++;
      this.overlay.ready(this.modes);
    });
  }

  /** Runs `fn` now, or right after the screenshot being taken, if one is. */
  private soon(fn: () => void): void {
    if (this.delivering) this.queued.push(fn);
    else fn();
  }

  /**
   * Chrome refused to open the answer panel because the drag's activation had
   * lapsed. A click here is a fresh gesture in a page context, which it accepts.
   */
  promptForPanel(): void {
    showPageTooltip({
      text: 'Your answer is ready.',
      actions: [
        {
          label: 'Show it',
          onClick: () => {
            void this.send({ type: 'panel:open' });
            dismissPageTooltip();
          },
        },
      ],
    });
  }

  /**
   * The bar goes (✕, or the student switched tabs), and whatever was being
   * selected with it. The chat carries on. No slide-out on a hidden page: it
   * would only play when the student came back.
   */
  private hide(animate = true): void {
    this.generation++;
    this.armed = null;
    this.queued = [];
    this.overlay.hide(animate && !this.doc.hidden);
  }

  /** ✕ on the bar, or Escape while it waits: the bar and the panel go, the chat is finished. */
  private finish(): void {
    this.hide();
    void this.send({ type: 'chat:finish' });
  }

  /** Stops for good: this page's copy of the extension is no longer the live one. */
  destroy(): void {
    if (this.gone) return;
    this.gone = true;
    this.generation++;
    this.armed = null;
    this.queued = [];
    this.overlay.destroy();
    try {
      this.unwatch?.();
    } catch {
      /* the extension went away under this page: there is nothing left to stop */
    }
    this.doc.removeEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * Coming back to a page whose extension was updated or reloaded meanwhile:
   * the bar left on it can do nothing, so it goes at once.
   */
  private onVisibility = (): void => {
    if (this.overlay.active && this.doc.visibilityState === 'visible') this.orphaned();
  };

  /** A click on the bar, unless the extension went away under this page. */
  private act(fn: () => void): void {
    if (!this.orphaned()) fn();
  }

  /**
   * If the extension was updated or reloaded under this page, the bar that is
   * left can do nothing: it goes, saying how to get a working one back.
   */
  private orphaned(): boolean {
    if (extensionAlive()) return false;
    if (!this.gone) {
      // A newer copy already put its own bar up (and took ours down): nothing to say.
      const replaced = this.overlay.replaced;
      this.destroy();
      if (!replaced) showPageTooltip({ text: `${BRAND.name} was updated. Click its icon to start again.` });
    }
    return true;
  }

  /** Every message the bar sends. */
  private async send<T>(msg: RuntimeMessage): Promise<T | null> {
    const reply = await send<T>(msg);
    if (reply === null) this.orphaned();
    return reply;
  }

  private setGhost(on: boolean): void {
    this.ghost = on;
    this.overlay.setGhost(on);
  }

  /** The ghost on the bar: the next selection starts a temporary chat (or, pressed again, does not). */
  private async toggleGhost(): Promise<void> {
    this.setGhost(!this.ghost);
    const reply = await this.send<{ temporary?: boolean }>({ type: 'chat:temporary', on: this.ghost });
    if (typeof reply?.temporary === 'boolean') this.setGhost(reply.temporary);
  }

  /**
   * Fired the moment a selection is committed, before any capture or text
   * extraction. Chrome will open the side panel from a user gesture in an
   * extension context, but only while that activation is still live —
   * everything after this point is too late.
   */
  private commit(kind: SelectionKind): void {
    this.delivering = true;
    void this.send({ type: 'selection:committed', kind });
  }

  /**
   * Escape stopped the selection. The bar then waits — unless nothing has been
   * selected in this chat yet, when Escape means "never mind" and the bar (and
   * the panel) go. The background knows which, and says.
   */
  private async stopped(gen: number): Promise<void> {
    this.armed = null;
    this.overlay.ready(this.modes);
    const reply = await this.send<{ end?: boolean }>({ type: 'selection:cancel' });
    if (gen === this.generation && reply?.end) this.hide();
  }

  /** Arms a selection in `kind`, bringing the bar up if it is not. */
  async start(requested: SelectionKind): Promise<void> {
    if (this.gone) return;
    const gen = ++this.generation;
    // Switching mode re-arms; drop whatever is running first. The selection
    // it replaces resolves null, but it is not a cancel, so it must not say so.
    this.overlay.abort();
    const current = () => gen === this.generation;
    const kind = this.modes.includes(requested) ? requested : (this.modes[0] as SelectionKind);
    this.armed = kind;

    const done = await this.select(kind, current);
    if (!done) {
      if (current()) await this.stopped(gen);
      return;
    }
    // Committed (commit() set `delivering`). Superseded before it could be
    // sent — the student switched tabs or pressed ✕ in the two frames before
    // the screenshot — it is dropped: the screenshot would not be of it.
    if (current()) {
      this.armed = null;
      // Answered once the screenshot is taken; the bar waits for that.
      await this.send(done);
    }
    this.delivering = false;
    if (current()) this.overlay.ready(this.modes);
    // Whatever was asked for meanwhile, even if this selection was superseded.
    const next = this.queued;
    this.queued = [];
    for (const fn of next) fn();
  }

  /** Runs one selection in `kind`; resolves with what to send, or null if it was stopped. */
  private async select(kind: SelectionKind, current: () => boolean): Promise<SelectionDoneMsg | null> {
    const page = { url: location.href, title: document.title };
    const devicePixelRatio = window.devicePixelRatio || 1;
    const viewport = { width: innerWidth, height: innerHeight };

    if (kind === 'text' && this.screen) {
      const adjust = await this.sendSetting();
      if (!current()) return null;
      const sel = await this.overlay.selectScreenText(this.modes, this.screen, { adjust });
      if (!sel) return null;
      this.commit('text');
      await this.outOfShot(sel.rect);
      return {
        type: 'selection:done',
        kind: 'text',
        rect: sel.rect,
        text: sel.text,
        html: '',
        ...(sel.path ? { path: sel.path } : {}),
        read: { unsure: sel.unsure },
        devicePixelRatio,
        viewport,
        page: pageOf(sel.window),
      };
    }

    if (kind === 'element' && this.screen) {
      const picked = await this.overlay.selectScreenElement(this.modes, this.screen);
      if (!picked) return null;
      this.commit('element');
      await this.outOfShot(picked.rect);
      return { type: 'selection:done', kind: 'element', rect: picked.rect, label: picked.label, devicePixelRatio, viewport, page: pageOf(picked.window) };
    }

    if (kind === 'text') {
      const sel = await this.overlay.selectText(this.modes);
      if (!sel) return null;
      this.commit('text');
      return { type: 'selection:done', kind: 'text', rect: sel.rect, text: sel.text, html: sel.html, devicePixelRatio, viewport, page };
    }

    if (kind === 'box') {
      const adjust = await this.sendSetting();
      if (!current()) return null;
      const armed = this.overlay.selectBox(this.modes, { adjust });
      if (this.pdf.isPdf) this.offerReader();
      const rect = await armed;
      if (!rect) return null;
      this.commit('box');
      // Only the crop is sent: reading it is the model's job, and scraping
      // page text from under the box garbled real layouts (see planner.ts).
      await this.outOfShot(rect);
      return { type: 'selection:done', kind: 'box', rect, devicePixelRatio, viewport, page };
    }

    if (kind === 'freeform') {
      const adjust = await this.sendSetting();
      if (!current()) return null;
      const armed = this.overlay.selectFreeform(this.modes, { adjust });
      if (this.pdf.isPdf) this.offerReader();
      const lasso = await armed;
      if (!lasso) return null;
      this.commit('freeform');
      await this.outOfShot(lasso.rect);
      return { type: 'selection:done', kind: 'freeform', rect: lasso.rect, path: lasso.path, devicePixelRatio, viewport, page };
    }

    const picked = await this.overlay.selectElement(this.modes);
    if (!picked) return null;
    // The picking click is the gesture that can open the panel.
    this.commit('element');
    await this.outOfShot(picked.rect);
    return {
      type: 'selection:done',
      kind: 'element',
      rect: picked.rect,
      label: picked.label,
      clipped: picked.clipped,
      devicePixelRatio,
      viewport,
      page,
    };
  }

  /** The selection's drawing is gone (and the bar, if it sits over `rect`); two frames make sure the screen shows it. */
  private async outOfShot(rect: Rect): Promise<void> {
    this.overlay.clearFor(rect);
    await nextPaint();
  }

  /** The send setting, from memory once known (a resolved await adds no frame). */
  private async sendSetting(): Promise<boolean> {
    return (this.adjust ??= await this.waitsForSend());
  }

  /** The setting: a drawn box or outline waits for Send (or Enter) instead of going at once. */
  private async waitsForSend(): Promise<boolean> {
    try {
      return (await getSettings()).adjustBox;
    } catch {
      return false;
    }
  }

  /**
   * On a browser PDF viewer, only a screenshot is possible, and the page cannot
   * scroll while selecting: said once per page, with the reader on offer.
   */
  private offeredReader = false;
  private offerReader(): void {
    if (this.offeredReader) return;
    this.offeredReader = true;
    showPageTooltip({
      text: "In this PDF view, only Box and Freeform work and the page can't scroll.",
      testid: 'pdf-tip',
      actions: [
        {
          label: 'Open in reader',
          onClick: () =>
            this.act(() => {
              this.overlay.abort();
              location.href = readerUrlFor(this.pdf.url, (p) => browser.runtime.getURL(p as `/${string}`));
            }),
        },
      ],
    });
  }
}

/** A selection's page in the app: the window it was made over. */
function pageOf(window: ScreenWindow | undefined): { url: string; title: string } {
  return { url: '', title: window ? windowTitle(window) : '' };
}

function nextPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
