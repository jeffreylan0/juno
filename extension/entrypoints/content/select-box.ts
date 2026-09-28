/**
 * Drag to draw a box. Returns the viewport rectangle in CSS pixels.
 *
 * The rectangle is clamped to the viewport because `captureVisibleTab` only
 * ever returns what is on screen — a box drawn past the fold would silently
 * produce a crop that does not match what the student selected. The caller is
 * told when that clamp is biting so it can say so.
 */
import type { Rect } from '@shared/payload';

const MIN_SIZE = 8;
/** How close to an edge counts as "you have hit the end of the screen". */
const EDGE_SLOP = 2;

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

export interface BoxSelectorHandlers {
  /** The drag began, so the instruction can hand over to the cursor tooltip. */
  onDragStart?: () => void;
  /** The drag ended without producing a usable rectangle. */
  onDragCancel?: () => void;
  /** Pointer position, for anything that tracks the cursor. */
  onMove?: (x: number, y: number) => void;
  /** Whether the drag is currently pressed against a viewport edge. */
  onClamped?: (clamped: boolean) => void;
  /** A usable rectangle was drawn. */
  onDone: (rect: Rect) => void;
}

export class BoxSelector {
  private start: { x: number; y: number } | null = null;
  private clamped = false;

  constructor(
    private surface: HTMLElement,
    private box: HTMLElement,
    private handlers: BoxSelectorHandlers,
  ) {}

  /** Wires listeners and returns the teardown. */
  attach(): () => void {
    const off: (() => void)[] = [];
    const on = (type: string, fn: (e: never) => void) => {
      const h = fn as EventListener;
      this.surface.addEventListener(type, h);
      off.push(() => this.surface.removeEventListener(type, h));
    };

    on('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.start = { x: e.clientX, y: e.clientY };
      this.surface.setPointerCapture(e.pointerId);
      this.handlers.onDragStart?.();
      this.handlers.onMove?.(e.clientX, e.clientY);
      this.draw(normalizeRect(this.start.x, this.start.y, e.clientX, e.clientY));
    });

    on('pointermove', (e: PointerEvent) => {
      this.handlers.onMove?.(e.clientX, e.clientY);
      if (!this.start) return;
      const clamped = isClamped(e.clientX, e.clientY, innerWidth, innerHeight);
      if (clamped !== this.clamped) {
        this.clamped = clamped;
        this.handlers.onClamped?.(clamped);
      }
      this.draw(clampToViewport(normalizeRect(this.start.x, this.start.y, e.clientX, e.clientY), innerWidth, innerHeight));
    });

    on('pointerup', (e: PointerEvent) => {
      if (!this.start) return;
      const r = clampToViewport(normalizeRect(this.start.x, this.start.y, e.clientX, e.clientY), innerWidth, innerHeight);
      this.start = null;
      this.clamped = false;
      if (r.width < MIN_SIZE || r.height < MIN_SIZE) {
        // Too small to be deliberate: reset and let the user try again.
        this.box.style.display = 'none';
        this.handlers.onDragCancel?.();
        return;
      }
      this.handlers.onDone(r);
    });

    return () => off.forEach((f) => f());
  }

  private draw(r: Rect): void {
    const s = this.box.style;
    s.display = 'block';
    s.left = `${r.x}px`;
    s.top = `${r.y}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
  }
}
