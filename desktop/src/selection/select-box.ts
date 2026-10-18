/**
 * Drag to draw a box, then (optionally) adjust it before asking.
 *
 * With adjusting on, releasing the drag does not send anything. The box stays
 * on screen with handles: drag an edge or corner to resize, drag inside to
 * move, drag outside to start over. Enter, a double-click inside the box, or
 * the bar's Ask button sends it. That is the difference between "roughly the
 * question" and "exactly the question, without the diagram next to it".
 *
 * The rectangle is clamped to the overlay (the display) because the capture
 * only ever has what is on screen: a box drawn past the edge would silently
 * produce a crop that does not match what the student selected. The caller is
 * told when that clamp is biting so it can say so.
 */
import type { Rect } from '@shared/payload';

export const MIN_SIZE = 8;
/** How close to an edge counts as "you have hit the end of the screen". */
const EDGE_SLOP = 2;
/** How close to an edge or corner of the box grabs it, in CSS pixels. */
export const HANDLE_SLOP = 8;

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type Hit = Handle | 'inside' | 'outside';

export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const CURSOR: Record<Hit, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  inside: 'move',
  outside: 'crosshair',
};

export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/** Clamps a rect to the viewport. */
export function clampToViewport(r: Rect, vw: number, vh: number): Rect {
  const x = Math.max(0, Math.min(r.x, vw));
  const y = Math.max(0, Math.min(r.y, vh));
  const right = Math.max(0, Math.min(r.x + r.width, vw));
  const bottom = Math.max(0, Math.min(r.y + r.height, vh));
  return { x, y, width: right - x, height: bottom - y };
}

/** True when the pointer has run past the edge of what can be captured. */
export function isClamped(x: number, y: number, vw: number, vh: number): boolean {
  return x <= EDGE_SLOP || y <= EDGE_SLOP || x >= vw - EDGE_SLOP || y >= vh - EDGE_SLOP;
}

/**
 * What a pointer at (x, y) would grab. Corners win over edges, and edges are
 * grabbable from a few pixels either side so a thin box is still resizable.
 */
export function hitTest(r: Rect, x: number, y: number, slop = HANDLE_SLOP): Hit {
  const left = r.x;
  const top = r.y;
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  const withinX = x >= left - slop && x <= right + slop;
  const withinY = y >= top - slop && y <= bottom + slop;
  if (!withinX || !withinY) return 'outside';
  const nearN = Math.abs(y - top) <= slop;
  const nearS = Math.abs(y - bottom) <= slop;
  const nearW = Math.abs(x - left) <= slop;
  const nearE = Math.abs(x - right) <= slop;
  // On a tiny box both edges are "near"; take whichever is actually closer.
  const v = nearN && nearS ? (Math.abs(y - top) <= Math.abs(y - bottom) ? 'n' : 's') : nearN ? 'n' : nearS ? 's' : '';
  const h = nearW && nearE ? (Math.abs(x - left) <= Math.abs(x - right) ? 'w' : 'e') : nearW ? 'w' : nearE ? 'e' : '';
  if (v || h) return (v + h) as Handle;
  return x > left && x < right && y > top && y < bottom ? 'inside' : 'outside';
}

/**
 * Drags one edge or corner by (dx, dy) and keeps the opposite side where it
 * was. Dragging past the opposite side flips the box rather than inverting it.
 */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, vw: number, vh: number): Rect {
  let left = r.x;
  let top = r.y;
  let right = r.x + r.width;
  let bottom = r.y + r.height;
  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.includes('n')) top += dy;
  if (handle.includes('s')) bottom += dy;
  return clampToViewport(normalizeRect(left, top, right, bottom), vw, vh);
}

/** Moves the box without changing its size, stopping at the viewport edges. */
export function moveRect(r: Rect, dx: number, dy: number, vw: number, vh: number): Rect {
  const x = Math.max(0, Math.min(r.x + dx, vw - r.width));
  const y = Math.max(0, Math.min(r.y + dy, vh - r.height));
  return { x, y, width: r.width, height: r.height };
}

export function cursorFor(hit: Hit): string {
  return CURSOR[hit];
}

export interface BoxSelectorHandlers {
  /** A pointer drag began (drawing, resizing or moving). */
  onDragStart?: () => void;
  /** The pointer drag ended. `usable` is false when it produced nothing. */
  onDragEnd?: (usable: boolean) => void;
  /** Pointer position, for anything that tracks the cursor. */
  onMove?: (x: number, y: number) => void;
  /** Whether the drag is currently pressed against a viewport edge. */
  onClamped?: (clamped: boolean) => void;
  /** A box is on screen and can be adjusted (only when adjusting is on). */
  onAdjust?: (rect: Rect) => void;
  /** The box is final: released (adjusting off) or confirmed (adjusting on). */
  onDone: (rect: Rect) => void;
}

export interface BoxSelectorOptions {
  /** Keep the box on screen for resizing after the drag, instead of sending it. */
  adjust: boolean;
}

type Drag =
  | { kind: 'draw'; x0: number; y0: number }
  | { kind: 'resize'; handle: Handle; x0: number; y0: number; from: Rect }
  | { kind: 'move'; x0: number; y0: number; from: Rect };

export class BoxSelector {
  private drag: Drag | null = null;
  /** The box being adjusted; null until one has been drawn. */
  private rect: Rect | null = null;
  private clamped = false;
  private finished = false;

  constructor(
    private surface: HTMLElement,
    private box: HTMLElement,
    private handlers: BoxSelectorHandlers,
    private options: BoxSelectorOptions = { adjust: false },
  ) {}

  /** True once a box has been drawn and is waiting to be adjusted or confirmed. */
  get adjusting(): boolean {
    return this.rect !== null && !this.finished;
  }

  /** Sends the adjusted box. Does nothing until one has been drawn. */
  confirm(): boolean {
    if (!this.rect || this.finished || this.drag) return false;
    this.finished = true;
    this.handlers.onDone(this.rect);
    return true;
  }

  /** Wires listeners and returns the teardown. */
  attach(): () => void {
    const off: (() => void)[] = [];
    const on = (type: string, fn: (e: never) => void) => {
      const h = fn as EventListener;
      this.surface.addEventListener(type, h);
      off.push(() => this.surface.removeEventListener(type, h));
    };

    on('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 || this.finished) return;
      e.preventDefault();
      const hit = this.rect ? hitTest(this.rect, e.clientX, e.clientY) : 'outside';
      if (hit === 'outside') this.drag = { kind: 'draw', x0: e.clientX, y0: e.clientY };
      else if (hit === 'inside') this.drag = { kind: 'move', x0: e.clientX, y0: e.clientY, from: this.rect! };
      else this.drag = { kind: 'resize', handle: hit, x0: e.clientX, y0: e.clientY, from: this.rect! };
      this.surface.setPointerCapture?.(e.pointerId);
      // Keep the grab's cursor for the whole drag, not just while hovering.
      this.surface.style.cursor = cursorFor(hit);
      this.box.classList.remove('adjusting');
      this.handlers.onDragStart?.();
      this.handlers.onMove?.(e.clientX, e.clientY);
      if (this.drag.kind === 'draw') this.draw(normalizeRect(e.clientX, e.clientY, e.clientX, e.clientY));
    });

    on('pointermove', (e: PointerEvent) => {
      this.handlers.onMove?.(e.clientX, e.clientY);
      if (!this.drag) {
        // Hovering over a box being adjusted: show what a drag would grab.
        if (this.adjusting) this.surface.style.cursor = cursorFor(hitTest(this.rect!, e.clientX, e.clientY));
        return;
      }
      const clamped = isClamped(e.clientX, e.clientY, innerWidth, innerHeight);
      if (clamped !== this.clamped) {
        this.clamped = clamped;
        this.handlers.onClamped?.(clamped);
      }
      this.draw(this.current(e.clientX, e.clientY));
    });

    on('pointerup', (e: PointerEvent) => {
      const drag = this.drag;
      if (!drag) return;
      const r = this.current(e.clientX, e.clientY);
      this.drag = null;
      if (this.clamped) {
        this.clamped = false;
        this.handlers.onClamped?.(false);
      }
      if (r.width < MIN_SIZE || r.height < MIN_SIZE) {
        // Too small to be deliberate. Keep the box being adjusted, if there is
        // one (a stray click outside it should not throw it away); otherwise
        // reset and let the user try again.
        if (this.rect) this.draw(this.rect, true);
        else this.box.style.display = 'none';
        this.handlers.onDragEnd?.(this.rect !== null);
        return;
      }
      if (!this.options.adjust) {
        this.finished = true;
        this.handlers.onDragEnd?.(true);
        this.handlers.onDone(r);
        return;
      }
      this.rect = r;
      this.draw(r, true);
      this.handlers.onDragEnd?.(true);
      this.handlers.onAdjust?.(r);
    });

    on('dblclick', (e: MouseEvent) => {
      if (this.rect && hitTest(this.rect, e.clientX, e.clientY, 0) === 'inside') {
        e.preventDefault();
        this.confirm();
      }
    });

    return () => off.forEach((f) => f());
  }

  /** The rectangle the current drag would produce with the pointer at (x, y). */
  private current(x: number, y: number): Rect {
    const d = this.drag!;
    const vw = innerWidth;
    const vh = innerHeight;
    switch (d.kind) {
      case 'draw':
        return clampToViewport(normalizeRect(d.x0, d.y0, x, y), vw, vh);
      case 'resize':
        return resizeRect(d.from, d.handle, x - d.x0, y - d.y0, vw, vh);
      case 'move':
        return moveRect(d.from, x - d.x0, y - d.y0, vw, vh);
    }
  }

  private draw(r: Rect, adjusting = false): void {
    const s = this.box.style;
    s.display = 'block';
    s.left = `${r.x}px`;
    s.top = `${r.y}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    this.box.classList.toggle('adjusting', adjusting);
  }
}
