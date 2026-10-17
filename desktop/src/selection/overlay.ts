/**
 * Shadow-DOM overlay: the control bar, and while a selection is being made,
 * the surface it is drawn on and the cursor tooltip. The bar comes up once
 * (opening from its middle) and stays for as long as it is on the page — through the
 * selection, the screenshot and the wait for the next one — until it is
 * dismissed (closing into its middle). Only the selection's own drawing is taken off the
 * page for the screenshot, and the bar too if the selection runs under it.
 *
 * Three rules keep it out of the way. The drag surface is a sibling of the
 * bar, not its parent, so clicks on our own controls can never start a box.
 * It forwards the wheel to whatever is scrollable under the pointer, because
 * a full-screen surface otherwise freezes the page. And it never takes
 * keyboard focus, so arrows and space still scroll — Escape is caught on the
 * document in capture, which never needed focus in the first place.
 */
import type { Rect, SelectionKind } from '@shared/payload';
import { fromUser, privateShadow } from '@/lib/page-trust';
import { Bar, BAR_STYLE, type BarNotice } from './bar';
import { BoxSelector, HANDLES } from './select-box';
import { LassoSelector, type Lasso } from './select-freeform';
import { UI_ATTR, applyWheel, scrollTargetAt } from './scroll';

const STYLE = `
:host { all: initial; }
.root { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
.backdrop { position: absolute; inset: 0; pointer-events: none; }
.backdrop.interactive { pointer-events: auto; cursor: crosshair; }
.backdrop.leaving { pointer-events: none; }
/* Armed, the screen dims a little: a selection is about to be made. Once one
 * is being drawn, the dim moves outside it (the box's shadow, the lasso's scrim). */
:host([data-state='armed']) .backdrop.interactive { background: var(--sai-scrim, rgba(20, 20, 19, 0.26)); animation: sai-dim 180ms ease-out; }
:host([data-state='armed']) .backdrop.interactive.steady { animation: none; }
@keyframes sai-dim { from { background: transparent; } }
.box {
  position: fixed; border: 2px dashed rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3), 0 0 0 100vmax var(--sai-scrim, rgba(20, 20, 19, 0.26));
  pointer-events: none; display: none;
}
.box.adjusting { border-style: solid; }
/* Visual only: the drag surface hit-tests the edges (select-box.ts), so the
 * handles never need pointer events of their own. */
.handle {
  position: absolute; width: 10px; height: 10px; display: none;
  transform: translate(-50%, -50%); margin: -1px 0 0 -1px;
  background: #fff; border: 1px solid rgba(0, 0, 0, 0.4); border-radius: 3px;
  box-sizing: border-box; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
.box.adjusting .handle { display: block; }
.handle[data-h='nw'] { left: 0; top: 0; }
.handle[data-h='n'] { left: 50%; top: 0; }
.handle[data-h='ne'] { left: 100%; top: 0; }
.handle[data-h='e'] { left: 100%; top: 50%; }
.handle[data-h='se'] { left: 100%; top: 100%; }
.handle[data-h='s'] { left: 50%; top: 100%; }
.handle[data-h='sw'] { left: 0; top: 100%; }
.handle[data-h='w'] { left: 0; top: 50%; }
.lasso { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; overflow: visible; }
.lasso-scrim { fill: var(--sai-scrim, rgba(20, 20, 19, 0.26)); }
.lasso-line {
  fill: none; stroke: rgba(255, 255, 255, 0.95); stroke-width: 2; stroke-dasharray: 6 4;
  stroke-linejoin: round; stroke-linecap: round; filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.45));
}
.lasso.kept .lasso-line { stroke-dasharray: none; }
@media (prefers-reduced-motion: reduce) { :host([data-state='armed']) .backdrop.interactive { animation: none; } }
/* By the pointer, after it has been there a moment: what to do, or how to stop. */
.tip {
  position: fixed; left: 0; top: 0; display: flex; align-items: center; gap: 5px;
  font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  color: var(--sai-hint-fg, #1f1e1d); background: var(--sai-hint-bg, #f5f4ef);
  padding: 5px 8px; border-radius: 7px; white-space: nowrap;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28), 0 0 0 0.5px rgba(0, 0, 0, 0.12); pointer-events: none;
  opacity: 0; visibility: hidden; transition: opacity 120ms ease, visibility 0s linear 120ms;
}
.tip.on { opacity: 1; visibility: visible; transition: opacity 120ms ease; }
.tip kbd {
  font: inherit; font-size: 11px; border: 1px solid rgba(31, 30, 29, 0.25);
  border-bottom-width: 2px; border-radius: 4px; padding: 0 4px;
}
@media (prefers-reduced-motion: reduce) { .tip, .tip.on { transition: none; } }
${BAR_STYLE}
`;

/** How far the tooltip sits from the pointer. Close enough to read without
 * moving your eyes off the corner you are dragging. */
const TIP_OFFSET = { x: 12, y: 14 };

/** How long the pointer is over the screen (or dragging) before the cursor tooltip comes up. */
export const CURSOR_TIP_DELAY_MS = 600;

/** What the cursor tooltip says while a selection is armed. */
const CURSOR_HINT: Record<SelectionKind, string> = {
  box: 'Drag to select',
  freeform: 'Draw around it',
};

/**
 * The bar's entrance and exit: it opens outwards from its middle, left and
 * right at once, and closes back into it. A clip, not a scale, so nothing in
 * it is squashed on the way; the clip reaches past the edges so the shadow
 * comes with it.
 */
const CLOSED = 'inset(-40px 50% -40px 50% round 18px)';
const OPEN = 'inset(-40px -40px -40px -40px round 18px)';
const ENTER_MS = 220;
const LEAVE_MS = 160;

export interface OverlayHandlers {
  /** The user picked a different mode from the bar's chips. */
  onModeChange: (kind: SelectionKind) => void;
  /**
   * The bar's X was pressed: the caller finishes the chat. Any armed
   * selection is cancelled first. Escape does not call it.
   */
  onClose: () => void;
  /** Escape while the bar waits between selections (nothing armed). */
  onEscapeWhileWaiting: () => void;
  /** The ghost on the bar was pressed. */
  onGhost: () => void;
  /** The bar's chats button (the app's bar has one). */
  onChats?: () => void;
}

export interface OverlayOptions {
  /**
   * The screenshot never sees the overlay (the app), so after a selection the
   * dim fades out rather than vanishing before the shot. On a page it must be
   * gone before the tab is captured.
   */
  fadeAfterShot?: boolean;
  /**
   * The page beneath is not this document's to scroll (the app: the overlay
   * is a window of its own over other apps). A wheel while a selection is
   * armed calls this instead, and the window lets the pointer through to
   * whatever is beneath until the pointer moves to select.
   */
  scrollThrough?: () => void;
  /** The app's compact bar (bar.ts). */
  compactBar?: boolean;
}

/** How long the dim takes to fade when a selection ends. */
const FADE_MS = 160;

export interface BoxOptions {
  /** Keep the drawn selection on screen (a box to resize, an outline to redraw) until Send. */
  adjust: boolean;
}

/**
 * ready: just the bar, between selections; nothing is armed. armed: waiting
 * for the first drag. drawing: a pointer drag is in progress. adjusting: a
 * selection is drawn and waits to be adjusted or sent. sending: the selection
 * is made and its screenshot is being taken.
 */
type OverlayState = 'ready' | 'armed' | 'drawing' | 'adjusting' | 'sending';

/**
 * Just enough of WXT's ContentScriptContext to tear down cleanly. The reader is
 * an extension page and has no such context.
 */
export interface OverlayHost {
  onInvalidated(cb: () => void): void;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Overlay {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private tip: HTMLElement | null = null;
  private bar: Bar | null = null;
  /** What the selection in progress is drawn on: the drag surface with its box or lasso. */
  private surface: HTMLElement | null = null;
  private state: OverlayState = 'ready';
  /** Cancels whatever selection is currently armed. */
  private cancelCurrent: (() => void) | null = null;
  /** Sends the box being adjusted, if there is one. */
  private confirmCurrent: (() => void) | null = null;
  /** Removes the Escape listener of a waiting bar. */
  private waitingKeys: (() => void) | null = null;
  /** The bar's exit, while it plays. */
  private leaving: Animation | null = null;
  private ghost = false;
  private notice: BarNotice | null = null;
  /** The answer panel is open (the app): see Bar.setPanelOpen. */
  private panelOpen = false;
  /** The mode being selected in, or null while the bar waits. */
  private kind: SelectionKind | null = null;
  /** The selection being made waits for Send (the setting) rather than going when drawn. */
  private submit = false;
  /** Where the pointer last was over the overlay, for the cursor tooltip. */
  private pointer: { x: number; y: number } | null = null;
  private tipTimer: ReturnType<typeof setTimeout> | undefined;
  /** The surface just taken away had the screen dimmed (see beginSelection). */
  private wasDimmed = false;

  constructor(
    private handlers: OverlayHandlers,
    private options: OverlayOptions = {},
  ) {}

  /** Whether the bar is on the page (and not on its way out). */
  get active(): boolean {
    return !!this.host?.isConnected && this.leaving === null;
  }

  /** Our bar was taken off the page by someone else: a newer copy of this script. */
  get replaced(): boolean {
    return this.host !== null && !this.host.isConnected;
  }

  /**
   * Just the bar, waiting between selections. The page underneath works as
   * usual. Escape here hides it — but only an Escape the page did not want
   * for itself: typing in a field, or a page closing its own dialog
   * (preventDefault), is left alone.
   */
  ready(): void {
    this.abort();
    this.show();
    this.clearSurface();
    this.kind = null;
    this.submit = false;
    this.bar!.setKind(null);
    this.setState('ready');
    this.backInShot();
    if (this.waitingKeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (!fromUser(e) || e.key !== 'Escape' || e.repeat || e.defaultPrevented) return;
      // The real target, inside any web component, not its shadow host.
      if (isEditable(e.composedPath()[0] ?? e.target)) return;
      // A page dialog open: this Escape is closing it.
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      this.handlers.onEscapeWhileWaiting();
    };
    // Bubble phase, on window: the page gets the key first.
    addEventListener('keydown', onKey);
    this.waitingKeys = () => removeEventListener('keydown', onKey);
  }

  /** Takes the bar off the page: closing into its middle, or at once (`animate` false, or reduced motion). */
  hide(animate = true): void {
    this.abort();
    this.quietKeys();
    if (!this.host) return;
    if (!animate || reducedMotion() || typeof this.bar?.el.animate !== 'function') return this.remove();
    if (this.leaving) return;
    this.host.setAttribute('data-leaving', '');
    const leaving = this.bar!.el.animate(
      [
        { clipPath: OPEN, opacity: 1 },
        { clipPath: CLOSED, opacity: 0.6 },
      ],
      { duration: LEAVE_MS, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    );
    this.leaving = leaving;
    void leaving.finished.then(
      () => this.leaving === leaving && this.remove(),
      () => {},
    );
  }

  /** Gone for good (the extension was updated, or a newer copy of this script took over). */
  destroy(): void {
    this.hide(false);
  }

  /** Whether the next selection starts a temporary chat. */
  setGhost(on: boolean): void {
    this.ghost = on;
    this.bar?.setGhost(on);
  }

  /** A note attached under the bar (it stays, whatever is being selected, until replaced or cleared). */
  setNotice(notice: BarNotice | null): void {
    this.notice = notice;
    this.bar?.setNotice(notice);
  }

  /** Whether the answer panel is open (the app), so the bar leaves it what is on it. */
  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    this.bar?.setPanelOpen(open);
  }

  /** Puts the bar up if it is not already, opening from its middle; a bar on its way out comes back. */
  private show(): void {
    if (this.leaving) {
      this.leaving.cancel();
      this.leaving = null;
      this.host?.removeAttribute('data-leaving');
    }
    if (this.host) return;
    // A bar left by an earlier copy of this script (one the extension's update orphaned).
    document.querySelectorAll('selection-ai-overlay').forEach((el) => el.remove());
    const host = document.createElement('selection-ai-overlay');
    // Closed, and deaf to events the page makes up (lib/page-trust.ts).
    const shadow = privateShadow(host);
    const style = document.createElement('style');
    style.textContent = STYLE;

    const root = document.createElement('div');
    root.className = 'root';

    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute(UI_ATTR, 'tip');

    const bar = new Bar(
      {
        onClose: () => {
          this.abort();
          this.handlers.onClose();
        },
        onConfirm: () => this.confirmCurrent?.(),
        onModeChange: (next) => this.handlers.onModeChange(next),
        onGhost: () => this.handlers.onGhost(),
        onChats: this.handlers.onChats,
      },
      { compact: this.options.compactBar },
    );
    bar.setGhost(this.ghost);
    bar.setNotice(this.notice);
    bar.setPanelOpen(this.panelOpen);

    root.append(tip, bar.hintEl, bar.el);
    shadow.append(style, root);
    document.documentElement.append(host);

    this.host = host;
    this.root = root;
    this.tip = tip;
    this.bar = bar;
    if (!reducedMotion() && typeof bar.el.animate === 'function') {
      bar.el.animate(
        [
          { clipPath: CLOSED, opacity: 0.6 },
          { clipPath: OPEN, opacity: 1 },
        ],
        { duration: ENTER_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    }
  }

  private remove(): void {
    this.quietKeys();
    clearTimeout(this.tipTimer);
    this.tipTimer = undefined;
    this.leaving = null;
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.tip = null;
    this.bar = null;
    this.surface = null;
    this.state = 'ready';
    this.kind = null;
    this.submit = false;
    this.confirmCurrent = null;
  }

  private quietKeys(): void {
    this.waitingKeys?.();
    this.waitingKeys = null;
  }

  /**
   * The bar, set up to select in `kind`, over a fresh drawing surface.
   * `submit`: the selection waits for Send. Returns the surface.
   */
  private beginSelection(kind: SelectionKind, submit = false): HTMLElement {
    // Switching mode: the screen is dimmed already, so it stays as it is rather than fading in again.
    const dimmed = this.surface ? this.isDimmed() : this.wasDimmed;
    this.show();
    this.clearSurface();
    // While selecting, run() owns Escape.
    this.quietKeys();
    this.backInShot();
    this.kind = kind;
    this.submit = submit;
    this.bar!.setKind(kind);

    // The selection is drawn on a surface over the page. It is a sibling of
    // the bar, not its parent, so clicks on our own controls can never start
    // a box.
    const surface = document.createElement('div');
    surface.className = `backdrop interactive${dimmed ? ' steady' : ''}`;
    surface.addEventListener('pointermove', (e) => this.moveTip(e.clientX, e.clientY));
    // Onto the bar: the tooltip is about the screen, not the controls.
    surface.addEventListener('pointerleave', () => this.resetTip());
    const box = document.createElement('div');
    box.className = 'box';
    for (const h of HANDLES) {
      const handle = document.createElement('div');
      handle.className = 'handle';
      handle.dataset.h = h;
      box.append(handle);
    }
    surface.append(box);
    this.root!.prepend(surface);
    this.surface = surface;
    this.setState('armed');
    return surface;
  }

  /** Whether the screen shows dimmed: a box or outline is armed, drawn or waiting. */
  private isDimmed(): boolean {
    return !!this.surface && (this.state === 'armed' || this.state === 'drawing' || this.state === 'adjusting');
  }

  /**
   * Takes the drawing surface away: at once when another mode's surface
   * replaces it or a screenshot must not see it, otherwise (`fade`) fading
   * the dim out, so a selection ending never snaps the screen back.
   */
  private clearSurface(fade = false): void {
    this.wasDimmed = this.isDimmed();
    const surface = this.surface;
    if (surface && fade && this.wasDimmed && !reducedMotion() && typeof surface.animate === 'function') {
      surface.classList.add('leaving');
      surface.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' }).finished.then(
        () => surface.remove(),
        () => surface.remove(),
      );
    } else {
      surface?.remove();
    }
    this.surface = null;
    this.confirmCurrent = null;
  }

  private setState(state: OverlayState): void {
    this.state = state;
    const drawing = state === 'drawing';
    this.bar?.setDrawing(drawing);
    this.host?.setAttribute('data-state', state);
    if (!drawing) this.bar?.setAdjusting(state === 'adjusting');
    if (state === 'armed' || state === 'ready') this.bar?.resetInstruction();
    const waits = this.submit && state !== 'ready' && state !== 'sending';
    this.bar?.setSubmit(!waits ? 'off' : state === 'adjusting' ? 'ready' : 'waiting');
    // Each state has its own word by the pointer (or none), after a moment.
    this.resetTip();
  }

  /**
   * The selection is made and is about to be captured. Its drawing is
   * already gone; the bar stays, unless it sits over the selected area — then
   * it steps out of the shot until the screenshot is taken.
   */
  clearFor(rect: Rect): void {
    const bar = this.bar?.el;
    if (!bar) return;
    const b = bar.getBoundingClientRect();
    const overlaps = b.left < rect.x + rect.width + 2 && b.right > rect.x - 2 && b.top < rect.y + rect.height + 2 && b.bottom > rect.y - 2;
    bar.classList.toggle('out-of-shot', overlaps);
  }

  /** The bar back after a screenshot it had to stay out of, fading in. */
  private backInShot(): void {
    const bar = this.bar?.el;
    if (!bar?.classList.contains('out-of-shot')) return;
    bar.classList.remove('out-of-shot');
    if (!reducedMotion() && typeof bar.animate === 'function') bar.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
  }

  /**
   * The cursor tooltip: what to do while armed ("Drag to select"), how to
   * stop while drawing. Never at once: it comes up once the pointer has been
   * over the screen (or dragging) a moment, then follows it.
   */
  private tipContent(): Node[] | null {
    if (this.state === 'drawing') return [kbd('Esc'), say('to cancel')];
    return this.state === 'armed' && this.kind ? [say(CURSOR_HINT[this.kind])] : null;
  }

  private resetTip(): void {
    clearTimeout(this.tipTimer);
    this.tipTimer = undefined;
    this.tip?.classList.remove('on');
  }

  private moveTip(x: number, y: number): void {
    this.pointer = { x, y };
    if (!this.tip) return;
    if (this.tip.classList.contains('on')) return this.placeTip();
    if (this.tipTimer !== undefined || !this.tipContent()) return;
    this.tipTimer = setTimeout(() => {
      this.tipTimer = undefined;
      const content = this.tipContent();
      if (!this.tip || !content) return;
      this.tip.replaceChildren(...content);
      this.tip.classList.add('on');
      this.placeTip();
    }, CURSOR_TIP_DELAY_MS);
  }

  private placeTip(): void {
    if (!this.tip || !this.pointer) return;
    const { x, y } = this.pointer;
    const rect = this.tip.getBoundingClientRect();
    // Flip back inside the viewport rather than running off the edge.
    const left = x + TIP_OFFSET.x + rect.width > innerWidth ? x - TIP_OFFSET.x - rect.width : x + TIP_OFFSET.x;
    const top = y + TIP_OFFSET.y + rect.height > innerHeight ? y - TIP_OFFSET.y - rect.height : y + TIP_OFFSET.y;
    this.tip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`;
  }

  /** Cancels an armed selection, resolving its promise with null. */
  abort(): void {
    this.cancelCurrent?.();
  }

  /** Resolves with a viewport rect in CSS pixels, or null when cancelled. */
  async selectBox(options: BoxOptions = { adjust: false }): Promise<Rect | null> {
    const backdrop = this.beginSelection('box', options.adjust);
    const box = backdrop.querySelector<HTMLElement>('.box')!;
    return await this.run((finish) => {
      const selector = new BoxSelector(
        backdrop,
        box,
        {
          onDragStart: () => this.setState('drawing'),
          onDragEnd: (usable) => this.setState(usable && options.adjust ? 'adjusting' : 'armed'),
          onMove: (x, y) => this.moveTip(x, y),
          onClamped: (clamped) =>
            this.bar?.setInstruction(clamped ? 'Selections stop at the screen edge' : ''),
          onAdjust: () => this.setState('adjusting'),
          onDone: finish,
        },
        options,
      );
      this.confirmCurrent = () => void selector.confirm();
      return selector.attach();
    });
  }

  /** Draw any closed shape; resolves with its outline and bounding box. */
  async selectFreeform(options: BoxOptions = { adjust: false }): Promise<Lasso | null> {
    const backdrop = this.beginSelection('freeform', options.adjust);
    return await this.run((finish) => {
      const lasso = new LassoSelector(
        backdrop,
        {
          onDragStart: () => this.setState('drawing'),
          onDragEnd: (kept) => this.setState(kept && options.adjust ? 'adjusting' : 'armed'),
          onMove: (x, y) => this.moveTip(x, y),
          onClamped: (clamped) =>
            this.bar?.setInstruction(clamped ? 'Selections stop at the screen edge' : ''),
          onDone: finish,
        },
        options,
      );
      this.confirmCurrent = () => void lasso.confirm();
      return lasso.attach();
    });
  }

  /**
   * Shared plumbing: Escape handling, wheel forwarding, and a guarantee that
   * the selection's drawing is removed however the selection ends. The bar
   * stays; what happens next is the caller's to say.
   */
  private run<T>(arm: (finish: (value: T | null) => void) => () => void): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      let settled = false;
      const teardown: (() => void)[] = [];
      const surface = this.surface;
      // How it ended: a selection made, stopped (Escape), or replaced by another mode's.
      const finish = (value: T | null, how: 'made' | 'stopped' | 'replaced' = value === null ? 'stopped' : 'made') => {
        if (settled) return;
        settled = true;
        teardown.forEach((f) => f());
        this.cancelCurrent = null;
        if (this.surface === surface) {
          this.clearSurface(how === 'stopped' || (how === 'made' && !!this.options.fadeAfterShot));
          this.setState('sending');
        }
        resolve(value);
      };

      const onKey = (e: KeyboardEvent) => {
        if (!fromUser(e)) return;
        if (e.key === 'Enter' && this.state === 'adjusting' && !isOurUi(e)) {
          // On our own Ask button, Enter already clicks it.
          e.preventDefault();
          e.stopPropagation();
          this.confirmCurrent?.();
          return;
        }
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      };
      // Capture on both: the page may stop propagation, and focus may sit in
      // an input rather than on the document body.
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('keydown', onKey, true);

      // Without this the drag surface eats the wheel and the page is frozen.
      const onWheel = (e: WheelEvent) => {
        if (isOurUi(e)) return;
        e.preventDefault();
        // Mid-drag, and while a drawn box waits to be adjusted, the box is
        // pinned to the viewport and cannot follow the page, so scrolling
        // would hand back a crop of something the user never framed.
        if (this.state !== 'armed') return;
        if (this.options.scrollThrough) return this.options.scrollThrough();
        applyWheel(scrollTargetAt(e.clientX, e.clientY, this.host), e);
      };
      surface?.addEventListener('wheel', onWheel, { passive: false });

      teardown.push(() => {
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('keydown', onKey, true);
        surface?.removeEventListener('wheel', onWheel);
      });

      teardown.push(arm(finish));
      this.cancelCurrent = () => finish(null, 'replaced');
    });
  }
}

/** A text field or editable area: Escape there belongs to the page. */
function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !(el instanceof HTMLElement)) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** True when the event started inside our own UI, which is never selectable. */
export function isOurUi(event: Event): boolean {
  return event
    .composedPath()
    .some((node) => node instanceof Element && node.hasAttribute?.(UI_ATTR));
}

function kbd(text: string): HTMLElement {
  const el = document.createElement('kbd');
  el.textContent = text;
  return el;
}

function say(text: string): HTMLElement {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}
