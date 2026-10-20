/**
 * The selection flow behind the bar, on the overlay window's page
 * (overlay/main.ts). The core's `bar:*` messages bring the bar up armed in a
 * mode, or waiting, and take it away; the bar's own controls pick a mode,
 * switch the ghost, open the chats and finish the chat. A selection made is
 * committed at once (the panel opens) and sent once drawn; the core answers
 * when its screenshot is taken, and the bar then waits for the next one.
 */
import type { Rect, SelectionKind } from '@shared/payload';
import type { BarNotice } from '@/selection/bar';
import { Overlay } from '@/selection/overlay';
import { KIND_ORDER } from './kinds';
import type { BarControlMsg, RuntimeMessage, SelectionDoneMsg } from './messages';
import { watchExtras, withinPlan } from './extras';
import { getSettings, migrateSettings, settingsItem, type Settings } from './storage';

export interface SelectionControllerOptions {
  /** A wheel while a selection is armed: the app beneath scrolls (overlay/main.ts). */
  scrollThrough: () => void;
  /** The bar's chats button: the panel, open on its list of chats. */
  onChats: () => void;
}

export class SelectionController {
  private overlay: Overlay;
  /** Bumped by every start() and every hide, so a superseded selection ends quietly. */
  private generation = 0;
  /** The mode being selected in right now, or null while the bar waits. */
  private armed: SelectionKind | null = null;
  /** A selection has been committed and its screenshot is being taken. */
  private delivering = false;
  /** What the student asked for meanwhile (a chip, the ghost, the shortcut), done in order once the screenshot is taken. */
  private queued: (() => void)[] = [];
  /** Whether the next selection starts a temporary chat. */
  private ghost = false;
  /**
   * The send setting, kept current, so arming never waits on storage: a wait
   * between taking one mode's surface down and putting the next one up shows
   * as a flash of the undimmed screen.
   */
  private adjust: boolean | null = null;

  constructor(opts: SelectionControllerOptions) {
    this.overlay = new Overlay({
      onModeChange: (kind) => this.soon(() => void this.start(kind)),
      onClose: () => this.finish(),
      // Escape, whatever is going on: everything goes, as with ✕.
      onEscape: () => this.finish(),
      // The panel steps aside while a selection is drawn (core/main.ts).
      onDrawing: (on) => void this.send({ type: 'selection:drawing', on }),
      onGhost: () => this.soon(() => void this.toggleGhost()),
      // The chats on the panel, with nothing armed: the dim would cover them.
      onChats: () => {
        this.disarm();
        opts.onChats();
      },
      onScrollThrough: opts.scrollThrough,
    });
    // Where the bar sits is one of the extras (lib/extras.ts).
    let settings: Settings | null = null;
    let extras = false;
    const apply = () => {
      if (!settings) return;
      this.adjust = settings.adjustBox;
      this.overlay.setPlace(withinPlan(settings, extras).barPlace);
    };
    void getSettings().then((s) => ((settings = s), apply()), () => {});
    settingsItem.watch((s) => ((settings = migrateSettings(s)), apply()));
    watchExtras((open) => ((extras = open), apply()));
  }

  /** A note attached under the bar (a permission, say), or null to take it away. */
  notice(notice: BarNotice | null): void {
    this.overlay.setNotice(notice);
  }

  /** Whether the panel is open, so the bar leaves it what is on it. */
  panelOpen(open: boolean): void {
    this.overlay.setPanelOpen(open);
  }

  /** A message from the core for the bar. */
  handle(msg: BarControlMsg): void {
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

  /** The shortcut (or the menu bar icon): select in `mode`. */
  private summoned(mode: SelectionKind): void {
    const kind = KIND_ORDER.includes(mode) ? mode : 'box';
    if (this.armed === kind) return; // already selecting in it (perhaps still setting up)
    this.soon(() => void this.start(kind));
  }

  /** The bar up with nothing armed; a selection already armed carries on. */
  private waiting(): void {
    if (this.armed) return;
    this.soon(() => {
      if (this.armed) return;
      this.generation++;
      this.overlay.ready();
    });
  }

  /** The armed selection stops quietly (no "never mind" that could finish the chat), and the bar waits. */
  private disarm(): void {
    if (!this.armed) return;
    this.soon(() => {
      this.generation++;
      this.armed = null;
      this.overlay.ready();
    });
  }

  /** Runs `fn` now, or right after the screenshot being taken, if one is. */
  private soon(fn: () => void): void {
    if (this.delivering) this.queued.push(fn);
    else fn();
  }

  /** The bar goes, and whatever was being selected with it. The chat carries on. */
  private hide(): void {
    this.generation++;
    this.armed = null;
    this.queued = [];
    this.overlay.hide();
  }

  /** ✕ on the bar, or Escape: the bar and the panel go, the chat is finished. */
  private finish(): void {
    this.hide();
    void this.send({ type: 'chat:finish' });
  }

  /** Every message the bar sends; null when nobody answered. */
  private async send<T>(msg: RuntimeMessage): Promise<T | null> {
    try {
      return ((await browser.runtime.sendMessage(msg)) as T | undefined) ?? null;
    } catch {
      return null;
    }
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

  /** The moment a selection is committed, before any capture: the panel opens at once. */
  private commit(kind: SelectionKind): void {
    this.delivering = true;
    void this.send({ type: 'selection:committed', kind });
  }

  /** Arms a selection in `kind`, bringing the bar up if it is not. */
  async start(requested: SelectionKind): Promise<void> {
    const gen = ++this.generation;
    // Switching mode re-arms; drop whatever is running first. The selection
    // it replaces resolves null, but it is not a cancel, so it must not say so.
    this.overlay.abort();
    const current = () => gen === this.generation;
    const kind = KIND_ORDER.includes(requested) ? requested : 'box';
    this.armed = kind;

    // Null when stopped: by Escape or ✕ (which close everything) or another mode (which re-arms).
    const done = await this.select(kind, current);
    if (!done) return;
    // Committed (commit() set `delivering`). Superseded before it could be
    // sent (✕ in the two frames before the screenshot), it is dropped: the
    // screenshot would not be of it.
    if (current()) {
      this.armed = null;
      // Answered once the screenshot is taken; the bar waits for that.
      await this.send(done);
    }
    this.delivering = false;
    if (current()) this.overlay.ready();
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
    const adjust = await this.sendSetting();
    if (!current()) return null;

    if (kind === 'box') {
      const rect = await this.overlay.selectBox({ adjust });
      if (!rect) return null;
      this.commit('box');
      await this.outOfShot(rect);
      return { type: 'selection:done', kind: 'box', rect, devicePixelRatio, viewport, page };
    }

    const lasso = await this.overlay.selectFreeform({ adjust });
    if (!lasso) return null;
    this.commit('freeform');
    await this.outOfShot(lasso.rect);
    return { type: 'selection:done', kind: 'freeform', rect: lasso.rect, path: lasso.path, devicePixelRatio, viewport, page };
  }

  /** The selection's drawing is gone (and the bar, if it sits over `rect`); two frames make sure the screen shows it. */
  private async outOfShot(rect: Rect): Promise<void> {
    this.overlay.clearFor(rect);
    await nextPaint();
  }

  /** The send setting, from memory once known (a resolved await adds no frame). */
  private async sendSetting(): Promise<boolean> {
    return (this.adjust ??= await getSettings().then(
      (s) => s.adjustBox,
      () => false,
    ));
  }
}

function nextPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
