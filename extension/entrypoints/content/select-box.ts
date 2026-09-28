/**
 * Drag to draw a box. Returns the viewport rectangle in CSS pixels.
 * Week 3 adds Option-drag to subtract regions; for now a single drag.
 */
import type { Rect } from '@shared/payload';

const MIN_SIZE = 8;

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

export interface BoxSelectorHandlers {
  /** Pointer movement while NOT dragging, so the hint can stay awake. */
  onActivity?: () => void;
  /** The drag began, so the hint can get out of the way. */
  onDragStart?: () => void;
  /** The drag ended without producing a usable rectangle. */
  onDragCancel?: () => void;
  /** A usable rectangle was drawn. */
  onDone: (rect: Rect) => void;
}

export class BoxSelector {
  private start: { x: number; y: number } | null = null;

  constructor(
    private root: HTMLElement,
    private box: HTMLElement,
    private handlers: BoxSelectorHandlers,
  ) {}

  /** Wires listeners and returns the teardown. */
  attach(): () => void {
    const off: (() => void)[] = [];
    const on = (type: string, fn: (e: never) => void) => {
      const h = fn as EventListener;
      this.root.addEventListener(type, h, { capture: true });
      off.push(() => this.root.removeEventListener(type, h, { capture: true }));
    };

    on('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.start = { x: e.clientX, y: e.clientY };
      this.root.setPointerCapture(e.pointerId);
      this.handlers.onDragStart?.();
      this.draw(normalizeRect(this.start.x, this.start.y, e.clientX, e.clientY));
    });

    on('pointermove', (e: PointerEvent) => {
      if (!this.start) {
        // Only idle movement counts as activity. Reporting it mid-drag would
        // cancel the fade that onDragStart just triggered, which is what left
        // the hint sitting on top of the selection.
        this.handlers.onActivity?.();
        return;
      }
      this.draw(normalizeRect(this.start.x, this.start.y, e.clientX, e.clientY));
    });

    on('pointerup', (e: PointerEvent) => {
      if (!this.start) return;
      const r = clampToViewport(normalizeRect(this.start.x, this.start.y, e.clientX, e.clientY), innerWidth, innerHeight);
      this.start = null;
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
