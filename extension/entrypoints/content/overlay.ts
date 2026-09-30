/**
 * Shadow-DOM overlay: the drag surface, the control bar and the cursor
 * tooltip. While a selection is armed it is all three; between selections it
 * is just the bar, waiting (`ready`), with nothing over the page. It is
 * removed entirely before the tab is captured.
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

export interface OverlayHandlers {
  /** The user picked a different mode from the bar's chips. */
  onModeChange: (kind: SelectionKind) => void;
  /**
   * The bar's X was pressed: the caller finishes the chat. Any armed
   * selection is cancelled first. Escape does not call it.
   */
  onClose?: () => void;
}

export interface BoxOptions {
  /** Keep the drawn box on screen to resize before asking. */
  adjust: boolean;
}

/**
 * ready: just the bar, between selections; nothing is armed. armed: waiting
 * for the first drag. drawing: a pointer drag is in progress. adjusting: a box
 * is drawn and waits to be resized or sent.
 */
type OverlayState = 'ready' | 'armed' | 'drawing' | 'adjusting';

/**
 * Just enough of WXT's ContentScriptContext to tear down cleanly. The reader is
 * an extension page and has no such context, so it passes a no-op.
 */
export interface OverlayHost {
  onInvalidated(cb: () => void): void;
}

export class Overlay {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private backdrop: HTMLElement | null = null;
  private tip: HTMLElement | null = null;
  private bar: Bar | null = null;
  private state: OverlayState = 'armed';
  /** Cancels whatever selection is currently armed. */
  private cancelCurrent: (() => void) | null = null;
  /** Sends the box being adjusted, if there is one. */
  private confirmCurrent: (() => void) | null = null;

  constructor(
    private ctx: OverlayHost,
    private handlers: OverlayHandlers,
  ) {
    // An updated or reloaded extension invalidates this script: whatever it
    // put on the page goes with it, the waiting bar included.
    ctx.onInvalidated(() => {
      this.cancelCurrent?.();
      this.unmount();
    });
  }

  get active(): boolean {
    return this.root !== null;
  }

  /** Whether a selection is being made right now (not just the bar waiting). */
  get selecting(): boolean {
    return this.root !== null && this.state !== 'ready';
  }

  /** Just the bar, waiting between selections. The page underneath works as usual. */
  ready(modes: SelectionKind[]): void {
    this.abort();
    this.mount(null, modes);
    this.setState('ready');
  }

  private mount(kind: SelectionKind | null, modes: SelectionKind[]): HTMLElement {
    this.unmount();
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

    // Box and freeform draw on a surface over the page; text and element
    // selection need the page itself to receive the pointer.
    const backdrop = document.createElement('div');
    backdrop.className = kind === 'box' || kind === 'freeform' ? 'backdrop interactive' : 'backdrop';

    const box = document.createElement('div');
    box.className = 'box';
    for (const h of HANDLES) {
      const handle = document.createElement('div');
      handle.className = 'handle';
      handle.dataset.h = h;
      box.append(handle);
    }

    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute(UI_ATTR, 'tip');
    tip.append(kbd('Escape'), say('to cancel'));

    const bar = new Bar(kind, modes, {
      onClose: () => {
        this.abort();
        this.handlers.onClose?.();
      },
      onConfirm: () => this.confirmCurrent?.(),
      onModeChange: (next) => this.handlers.onModeChange(next),
    });

    backdrop.append(box);
    root.append(backdrop, tip, bar.el);
    shadow.append(style, root);
    document.documentElement.append(host);

    this.host = host;
    this.root = root;
    this.backdrop = backdrop;
    this.tip = tip;
    this.bar = bar;
    this.setState('armed');
    return backdrop;
  }

  unmount(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.backdrop = null;
    this.tip = null;
    this.bar = null;
    this.state = 'armed';
    this.confirmCurrent = null;
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

  private moveTip(x: number, y: number): void {
    if (!this.tip || this.state !== 'drawing') return;
    const rect = this.tip.getBoundingClientRect();
    // Flip back inside the viewport rather than running off the edge.
    const left = x + TIP_OFFSET.x + rect.width > innerWidth ? x - TIP_OFFSET.x - rect.width : x + TIP_OFFSET.x;
    const top = y + TIP_OFFSET.y + rect.height > innerHeight ? y - TIP_OFFSET.y - rect.height : y + TIP_OFFSET.y;
    this.tip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`;
  }

  /** Adds a notice under the bar's controls. Returns a function that removes it. */
  notice(text: string, action: NoticeAction | null): () => void {
    return this.bar?.notice(text, action) ?? (() => {});
  }

  /** Cancels an armed selection, resolving its promise with null. */
  abort(): void {
    this.cancelCurrent?.();
  }

  /** Resolves with a viewport rect in CSS pixels, or null when cancelled. */
  async selectBox(modes: SelectionKind[], options: BoxOptions = { adjust: false }): Promise<Rect | null> {
    const backdrop = this.mount('box', modes);
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
    const backdrop = this.mount('element', modes);
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
    const backdrop = this.mount('freeform', modes);
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
    this.mount('text', modes);
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
   * the overlay is removed however the selection ends.
   */
  private run<T>(arm: (finish: (value: T | null) => void) => () => void): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      let settled = false;
      const teardown: (() => void)[] = [];
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        teardown.forEach((f) => f());
        this.cancelCurrent = null;
        this.unmount();
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
      this.backdrop?.addEventListener('wheel', onWheel, { passive: false });

      teardown.push(() => {
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('keydown', onKey, true);
        this.backdrop?.removeEventListener('wheel', onWheel);
      });

      teardown.push(arm(finish));
      this.cancelCurrent = () => finish(null);
    });
  }
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
