/**
 * Drag to draw a box. Returns the viewport rectangle in CSS pixels.
 * Week 3 adds Option-drag to subtract regions; for now a single drag.
 */
import type { ContentScriptContext } from '#imports';
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

export class BoxSelector {
  constructor(
    private root: HTMLElement,
    private box: HTMLElement,
    private ctx: ContentScriptContext,
  ) {}

  run(): Promise<Rect | null> {
    return new Promise((resolve) => {
      let start: { x: number; y: number } | null = null;
      const off: (() => void)[] = [];
      const finish = (r: Rect | null) => {
        off.forEach((f) => f());
        resolve(r);
      };
      const on = <K extends keyof HTMLElementEventMap>(
        target: HTMLElement | Window,
        type: K | 'keydown',
        fn: (e: never) => void,
      ) => {
        const h = fn as EventListener;
        target.addEventListener(type, h, { capture: true });
        off.push(() => target.removeEventListener(type, h, { capture: true }));
      };

      on(this.root, 'pointerdown', (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        start = { x: e.clientX, y: e.clientY };
        this.root.setPointerCapture(e.pointerId);
        this.draw(normalizeRect(start.x, start.y, e.clientX, e.clientY));
      });
      on(this.root, 'pointermove', (e: PointerEvent) => {
        if (!start) return;
        this.draw(normalizeRect(start.x, start.y, e.clientX, e.clientY));
      });
      on(this.root, 'pointerup', (e: PointerEvent) => {
        if (!start) return;
        const r = clampToViewport(normalizeRect(start.x, start.y, e.clientX, e.clientY), innerWidth, innerHeight);
        start = null;
        if (r.width < MIN_SIZE || r.height < MIN_SIZE) {
          this.box.style.display = 'none';
          return; // too small: let the user try again
        }
        finish(r);
      });
      on(window, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      });
      this.ctx.onInvalidated(() => finish(null));
    });
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
