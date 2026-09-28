/**
 * Shadow-DOM overlay: the drag surface, the control bar and the cursor
 * tooltip. Mounted only while a selection is armed and removed before the tab
 * is captured.
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
import { BoxSelector } from './select-box';
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

/** How far the tooltip sits from the pointer. */
const TIP_OFFSET = { x: 16, y: 18 };

export interface OverlayHandlers {
  /** The user picked a different mode from the bar's chips. */
  onModeChange: (kind: SelectionKind) => void;
}

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
  private drawing = false;
  /** Cancels whatever selection is currently armed. */
  private cancelCurrent: (() => void) | null = null;

  constructor(
    private ctx: OverlayHost,
    private handlers: OverlayHandlers,
  ) {}

  get active(): boolean {
    return this.root !== null;
  }

  private mount(kind: SelectionKind, modes: SelectionKind[]): HTMLElement {
    this.unmount();
    const host = document.createElement('selection-ai-overlay');
    // Open, not closed: the overlay holds nothing worth hiding — secrets stay
    // on the options page — and open keeps it inspectable in DevTools and
    // reachable from the end-to-end tests.
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;

    const root = document.createElement('div');
    root.className = 'root';

    const backdrop = document.createElement('div');
    backdrop.className = kind === 'box' ? 'backdrop interactive' : 'backdrop';

    const box = document.createElement('div');
    box.className = 'box';

    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute(UI_ATTR, 'tip');
    tip.append(kbd('Escape'), say('to cancel'));

    const bar = new Bar(kind, modes, {
      onCancel: () => this.abort(),
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
    this.drawing = false;
    this.setDrawing(false);
    return backdrop;
  }

  unmount(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.backdrop = null;
    this.tip = null;
    this.bar = null;
    this.drawing = false;
  }

  /** True while the pointer is down and a selection is being drawn. */
  private setDrawing(drawing: boolean): void {
    this.drawing = drawing;
    this.bar?.setDrawing(drawing);
    this.tip?.classList.toggle('on', drawing);
    this.host?.setAttribute('data-state', drawing ? 'drawing' : 'armed');
    if (!drawing) this.bar?.resetInstruction();
  }

  private moveTip(x: number, y: number): void {
    if (!this.tip || !this.drawing) return;
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
  async selectBox(modes: SelectionKind[]): Promise<Rect | null> {
    const backdrop = this.mount('box', modes);
    const box = backdrop.querySelector<HTMLElement>('.box')!;
    return await this.run((finish) => {
      const selector = new BoxSelector(backdrop, box, {
        onDragStart: () => this.setDrawing(true),
        onDragCancel: () => this.setDrawing(false),
        onMove: (x, y) => this.moveTip(x, y),
        onClamped: (clamped) =>
          this.bar?.setInstruction(clamped ? 'The selection stops at the edge of the screen' : ''),
        onDone: finish,
      });
      return selector.attach();
    });
  }

  /** Waits for the user to select text on the page. */
  async selectText(modes: SelectionKind[]): Promise<TextSelection | null> {
    this.mount('text', modes);
    return await this.run((finish) => {
      const onDown = (e: MouseEvent) => {
        if (isOurUi(e)) return;
        this.setDrawing(true);
        this.moveTip(e.clientX, e.clientY);
      };
      const onMove = (e: PointerEvent) => this.moveTip(e.clientX, e.clientY);
      const onUp = (e: MouseEvent) => {
        if (isOurUi(e)) return;
        // The selection settles a tick after mouseup.
        setTimeout(() => {
          const sel = readSelection();
          this.setDrawing(false);
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
      this.ctx.onInvalidated(() => finish(null));
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
