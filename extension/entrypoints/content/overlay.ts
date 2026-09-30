/**
 * Shadow-DOM overlay: the control bar, and while a selection is being made,
 * the surface it is drawn on and the cursor tooltip. The bar comes up once
 * (sliding in) and stays for as long as it is on the page — through the
 * selection, the screenshot and the wait for the next one — until it is
 * dismissed (sliding out). Only the selection's own drawing is taken off the
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
import { Bar, BAR_STYLE, type NoticeAction } from './bar';
import { BoxSelector, HANDLES } from './select-box';
import { ElementPicker, type PickedElement } from './select-element';
import { LassoSelector, type Lasso } from './select-freeform';
import { readSelection, type TextSelection } from './select-text';
import { UI_ATTR, applyWheel, scrollTargetAt } from './scroll';

const STYLE = `
:host { all: initial; }
.root { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
.backdrop { position: absolute; inset: 0; pointer-events: none; }
.backdrop.interactive { pointer-events: auto; cursor: crosshair; }
.box {
  position: fixed; border: 2px dashed var(--sai-accent, #3b82f6);
  background: color-mix(in srgb, var(--sai-accent, #3b82f6) 8%, transparent);
  box-shadow: 0 0 0 100vmax var(--sai-scrim, rgba(15, 23, 42, 0.35));
  pointer-events: none; display: none;
}
.box.adjusting { border-style: solid; }
/* Visual only: the drag surface hit-tests the edges (select-box.ts), so the
 * handles never need pointer events of their own. */
.handle {
  position: absolute; width: 10px; height: 10px; display: none;
  transform: translate(-50%, -50%); margin: -1px 0 0 -1px;
  background: #fff; border: 2px solid var(--sai-accent, #3b82f6); border-radius: 3px;
  box-sizing: border-box;
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
.box.element {
  border: 2px solid var(--sai-accent, #3b82f6); box-shadow: none; border-radius: 3px;
  background: color-mix(in srgb, var(--sai-accent, #3b82f6) 10%, transparent);
  transition: left 60ms ease, top 60ms ease, width 60ms ease, height 60ms ease;
}
.tag {
  position: fixed; display: none; pointer-events: none; white-space: nowrap;
  font: 600 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  color: #fff; background: var(--sai-accent, #3b82f6); padding: 4px 7px; border-radius: 5px;
}
.lasso { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; overflow: visible; }
.lasso-scrim { fill: var(--sai-scrim, rgba(15, 23, 42, 0.35)); }
.lasso-line {
  fill: color-mix(in srgb, var(--sai-accent, #3b82f6) 8%, transparent);
  stroke: var(--sai-accent, #3b82f6); stroke-width: 2; stroke-dasharray: 6 4;
  stroke-linejoin: round; stroke-linecap: round;
}
@media (prefers-reduced-motion: reduce) { .box.element { transition: none; } }
/* A selection on its way to the panel (flyAway). */
.fly {
  position: fixed; pointer-events: none; box-sizing: border-box; border-radius: 8px;
  border: 2px solid var(--sai-accent, #3b82f6);
  background: color-mix(in srgb, var(--sai-accent, #3b82f6) 14%, transparent);
}
.tip {
  position: fixed; left: 0; top: 0; display: none; align-items: center; gap: 6px;
  font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  color: var(--sai-bar-fg, #f8fafc); background: var(--sai-bar-bg, rgba(15, 23, 42, 0.94));
  padding: 6px 10px; border-radius: 9px; white-space: nowrap;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3); pointer-events: none;
}
.tip.on { display: flex; }
.tip kbd {
  font: inherit; font-size: 11px; border: 1px solid rgba(255, 255, 255, 0.4);
  border-bottom-width: 2px; border-radius: 4px; padding: 1px 5px;
}
${BAR_STYLE}
`;

/** How far the tooltip sits from the pointer. Close enough to read without
 * moving your eyes off the corner you are dragging. */
const TIP_OFFSET = { x: 8, y: 10 };

/** The bar's entrance and exit, and a selection flying off to the panel. */
const ENTER_MS = 220;
const LEAVE_MS = 160;
const FLY_MS = 420;

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
}

export interface BoxOptions {
  /** Keep the drawn box on screen to resize before asking. */
  adjust: boolean;
}

/**
 * ready: just the bar, between selections; nothing is armed. armed: waiting
 * for the first drag. drawing: a pointer drag is in progress. adjusting: a box
 * is drawn and waits to be resized or sent. sending: the selection is made
 * and its screenshot is being taken.
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
  /** What the selection in progress is drawn on: the drag surface with its box, lasso or highlight. */
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

  constructor(private handlers: OverlayHandlers) {}

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
  ready(modes: SelectionKind[]): void {
    this.abort();
    this.show(modes);
    this.clearSurface();
    this.bar!.setKind(null);
    this.setState('ready');
    this.backInShot();
    if (this.waitingKeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || e.defaultPrevented) return;
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

  /** Takes the bar off the page: sliding out, or at once (`animate` false, or reduced motion). */
  hide(animate = true): void {
    this.abort();
    this.quietKeys();
    if (!this.host) return;
    if (!animate || reducedMotion() || typeof this.bar?.el.animate !== 'function') return this.remove();
    if (this.leaving) return;
    this.host.setAttribute('data-leaving', '');
    const leaving = this.bar!.el.animate(
      [
        { opacity: 1, transform: 'translate(-50%, 0) scale(1)' },
        { opacity: 0, transform: 'translate(-50%, 14px) scale(0.97)' },
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

  /** Puts the bar up if it is not already, sliding in; a bar on its way out comes back. */
  private show(modes: SelectionKind[]): void {
    if (this.leaving) {
      this.leaving.cancel();
      this.leaving = null;
      this.host?.removeAttribute('data-leaving');
    }
    if (this.host) return;
    // A bar left by an earlier copy of this script (one the extension's update orphaned).
    document.querySelectorAll('selection-ai-overlay').forEach((el) => el.remove());
    const host = document.createElement('selection-ai-overlay');
    // Open, not closed: the overlay holds nothing worth hiding — secrets stay
    // on the options page — and open keeps it inspectable in DevTools and
    // reachable from the end-to-end tests.
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;

    const root = document.createElement('div');
    root.className = 'root';

    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute(UI_ATTR, 'tip');
    tip.append(kbd('Escape'), say('to cancel'));

    const bar = new Bar(modes, {
      onClose: () => {
        this.abort();
        this.handlers.onClose();
      },
      onConfirm: () => this.confirmCurrent?.(),
      onModeChange: (next) => this.handlers.onModeChange(next),
      onGhost: () => this.handlers.onGhost(),
    });
    bar.setGhost(this.ghost);

    root.append(tip, bar.el);
    shadow.append(style, root);
    document.documentElement.append(host);

    this.host = host;
    this.root = root;
    this.tip = tip;
    this.bar = bar;
    if (!reducedMotion() && typeof bar.el.animate === 'function') {
      bar.el.animate(
        [
          { opacity: 0, transform: 'translate(-50%, 16px) scale(0.96)' },
          { opacity: 1, transform: 'translate(-50%, 0) scale(1)' },
        ],
        { duration: ENTER_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    }
  }

  private remove(): void {
    this.quietKeys();
    this.leaving = null;
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.tip = null;
    this.bar = null;
    this.surface = null;
    this.state = 'ready';
    this.confirmCurrent = null;
  }

  private quietKeys(): void {
    this.waitingKeys?.();
    this.waitingKeys = null;
  }

  /** The bar, set up to select in `kind`, over a fresh drawing surface. Returns the surface. */
  private beginSelection(kind: SelectionKind, modes: SelectionKind[]): HTMLElement {
    this.show(modes);
    this.clearSurface();
    // While selecting, run() owns Escape.
    this.quietKeys();
    this.backInShot();
    this.bar!.setKind(kind);

    // Box and freeform draw on a surface over the page; text and element
    // selection need the page itself to receive the pointer. The surface is
    // a sibling of the bar, not its parent, so clicks on our own controls can
    // never start a box.
    const surface = document.createElement('div');
    surface.className = kind === 'box' || kind === 'freeform' ? 'backdrop interactive' : 'backdrop';
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

  private clearSurface(): void {
    this.surface?.remove();
    this.surface = null;
    this.confirmCurrent = null;
    this.host?.removeAttribute('data-highlight');
  }

  private setState(state: OverlayState): void {
    this.state = state;
    const drawing = state === 'drawing';
    this.bar?.setDrawing(drawing);
    // The cursor tooltip is for the drag itself; while adjusting, the bar
    // carries the instructions and the Ask button.
    this.tip?.classList.toggle('on', drawing);
    this.host?.setAttribute('data-state', state);
    if (state === 'armed' || state === 'ready') this.bar?.resetInstruction();
    if (!drawing) this.bar?.setAdjusting(state === 'adjusting');
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
   * A made selection's outline flies off to the right edge, where the panel
   * is, so the student sees where it went. Only after the screenshot, so it
   * is never in one.
   */
  flyAway(rect: Rect): void {
    if (!this.root || reducedMotion() || rect.width < 2 || rect.height < 2) return;
    const el = document.createElement('div');
    el.className = 'fly';
    Object.assign(el.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    if (typeof el.animate !== 'function') return;
    this.root.append(el);
    const dx = innerWidth + 16 - (rect.x + rect.width / 2);
    const dy = innerHeight * 0.55 - (rect.y + rect.height / 2);
    const fly = el.animate(
      [
        { opacity: 0.9, transform: 'translate(0, 0) scale(1)' },
        { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.18)` },
      ],
      { duration: FLY_MS, easing: 'cubic-bezier(0.55, 0, 0.75, 0.3)', fill: 'forwards' },
    );
    void fly.finished.then(
      () => el.remove(),
      () => el.remove(),
    );
  }

  private moveTip(x: number, y: number): void {
    if (!this.tip || this.state !== 'drawing') return;
    const rect = this.tip.getBoundingClientRect();
    // Flip back inside the viewport rather than running off the edge.
    const left = x + TIP_OFFSET.x + rect.width > innerWidth ? x - TIP_OFFSET.x - rect.width : x + TIP_OFFSET.x;
    const top = y + TIP_OFFSET.y + rect.height > innerHeight ? y - TIP_OFFSET.y - rect.height : y + TIP_OFFSET.y;
    this.tip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`;
  }

  /** Adds a notice under the bar's controls (once). Returns a function that removes it. */
  notice(text: string, action: NoticeAction | null): () => void {
    return this.bar?.notice(text, action) ?? (() => {});
  }

  /** Cancels an armed selection, resolving its promise with null. */
  abort(): void {
    this.cancelCurrent?.();
  }

  /** Resolves with a viewport rect in CSS pixels, or null when cancelled. */
  async selectBox(modes: SelectionKind[], options: BoxOptions = { adjust: false }): Promise<Rect | null> {
    const backdrop = this.beginSelection('box', modes);
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
            this.bar?.setInstruction(clamped ? 'The selection stops at the edge of the screen' : ''),
          onAdjust: () => this.setState('adjusting'),
          onDone: finish,
        },
        options,
      );
      this.confirmCurrent = () => void selector.confirm();
      return selector.attach();
    });
  }

  /**
   * Hover highlights an element, a click (or Enter) picks it. The page keeps
   * the pointer, so it scrolls and hovers normally; only the picking click is
   * kept from reaching it.
   */
  async selectElement(modes: SelectionKind[]): Promise<PickedElement | null> {
    const backdrop = this.beginSelection('element', modes);
    const box = backdrop.querySelector<HTMLElement>('.box')!;
    box.classList.add('element');
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.setAttribute('data-testid', 'element-tag');
    backdrop.append(tag);
    return await this.run((finish) => {
      const picker = new ElementPicker(this.host!, {
        isOurs: isOurUi,
        onHighlight: (rect, label) => {
          if (!rect) {
            box.style.display = 'none';
            tag.style.display = 'none';
            return;
          }
          Object.assign(box.style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
          tag.textContent = label;
          tag.style.display = 'block';
          // Above the element when there is room, otherwise just inside it.
          const top = rect.y >= 24 ? rect.y - 22 : rect.y + 4;
          tag.style.transform = `translate(${Math.max(4, rect.x)}px, ${Math.max(4, top)}px)`;
          this.host?.setAttribute('data-highlight', label);
        },
        onPick: finish,
      });
      return picker.attach();
    });
  }

  /** Draw any closed shape; resolves with its outline and bounding box. */
  async selectFreeform(modes: SelectionKind[]): Promise<Lasso | null> {
    const backdrop = this.beginSelection('freeform', modes);
    return await this.run((finish) => {
      const lasso = new LassoSelector(backdrop, {
        onDragStart: () => this.setState('drawing'),
        onDragEnd: () => this.setState('armed'),
        onMove: (x, y) => this.moveTip(x, y),
        onClamped: (clamped) =>
          this.bar?.setInstruction(clamped ? 'The selection stops at the edge of the screen' : ''),
        onDone: finish,
      });
      return lasso.attach();
    });
  }

  /** Waits for the user to select text on the page. */
  async selectText(modes: SelectionKind[]): Promise<TextSelection | null> {
    this.beginSelection('text', modes);
    return await this.run((finish) => {
      const onDown = (e: MouseEvent) => {
        if (isOurUi(e)) return;
        this.setState('drawing');
        this.moveTip(e.clientX, e.clientY);
      };
      const onMove = (e: PointerEvent) => this.moveTip(e.clientX, e.clientY);
      const onUp = (e: MouseEvent) => {
        if (isOurUi(e)) return;
        // The selection settles a tick after mouseup.
        setTimeout(() => {
          const sel = readSelection();
          this.setState('armed');
          if (sel) finish(sel);
        }, 0);
      };
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      return () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
      };
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
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        teardown.forEach((f) => f());
        this.cancelCurrent = null;
        if (this.surface === surface) {
          this.clearSurface();
          this.setState('sending');
        }
        resolve(value);
      };

      const onKey = (e: KeyboardEvent) => {
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
        applyWheel(scrollTargetAt(e.clientX, e.clientY, this.host), e);
      };
      surface?.addEventListener('wheel', onWheel, { passive: false });

      teardown.push(() => {
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('keydown', onKey, true);
        surface?.removeEventListener('wheel', onWheel);
      });

      teardown.push(arm(finish));
      this.cancelCurrent = () => finish(null);
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
