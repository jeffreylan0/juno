/**
 * Freeform (lasso) selection: draw any closed shape around what you want to
 * ask about. The AI gets the shape's bounding box with everything outside
 * the outline blanked (see src-tauri/src/crop.rs), so a neighbouring diagram or an
 * answer key beside the problem cannot leak into the question.
 *
 * With adjusting on (the same setting as a box's), letting go keeps the
 * outline on screen instead of sending it: drawing again replaces it, and
 * Enter, a double-click inside it or the bar's Send sends it.
 *
 * Points are viewport CSS pixels and clamped to the viewport, for the same
 * reason boxes are: `captureVisibleTab` only sees what is on screen.
 */
import type { Point, Rect } from '@shared/payload';
import { MIN_SIZE, clampToViewport, isClamped } from './select-box';

/** Minimum pointer travel between recorded points; keeps paths small. */
const STEP = 2.5;
/** Paths are simplified to at most this many points before sending. */
export const MAX_POINTS = 400;

export interface Lasso {
  /** Bounding box of the outline, in viewport CSS pixels. */
  rect: Rect;
  /** The closed outline. */
  path: Point[];
}

export function boundsOf(path: Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of path) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Evenly thins a path to at most `max` points, always keeping the ends. */
export function thin(path: Point[], max = MAX_POINTS): Point[] {
  if (path.length <= max) return path;
  const out: Point[] = [];
  const step = (path.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(path[Math.round(i * step)]!);
  return out;
}

/** The finished lasso, or null when the shape is too small to mean anything. */
export function finishLasso(points: Point[], vw: number, vh: number): Lasso | null {
  if (points.length < 3) return null;
  const path = thin(points.map((p) => ({ x: Math.max(0, Math.min(p.x, vw)), y: Math.max(0, Math.min(p.y, vh)) })));
  const rect = clampToViewport(boundsOf(path), vw, vh);
  if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return null;
  return { rect, path };
}

/** SVG path data for an outline, closed or still being drawn. */
export function pathData(points: Point[], closed: boolean): string {
  if (!points.length) return '';
  const [first, ...rest] = points;
  return `M${first!.x.toFixed(1)} ${first!.y.toFixed(1)}${rest.map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('')}${closed ? 'Z' : ''}`;
}

export interface LassoHandlers {
  onDragStart?: () => void;
  /** The drag ended; `kept` when an outline is on screen afterwards (adjusting on). */
  onDragEnd?: (kept: boolean) => void;
  onMove?: (x: number, y: number) => void;
  onClamped?: (clamped: boolean) => void;
  onDone: (lasso: Lasso) => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface LassoOptions {
  /** Keep the outline on screen after the drag, until it is sent. */
  adjust: boolean;
}

export class LassoSelector {
  private points: Point[] = [];
  private drawing = false;
  private clamped = false;
  /** The outline waiting to be sent (adjusting on); null until one is drawn. */
  private kept: Lasso | null = null;
  private finished = false;
  private svg: SVGSVGElement;
  private scrim: SVGPathElement;
  private outline: SVGPathElement;

  constructor(
    private surface: HTMLElement,
    private handlers: LassoHandlers,
    private options: LassoOptions = { adjust: false },
  ) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'lasso');
    this.scrim = document.createElementNS(SVG_NS, 'path');
    this.scrim.setAttribute('class', 'lasso-scrim');
    this.scrim.setAttribute('fill-rule', 'evenodd');
    this.outline = document.createElementNS(SVG_NS, 'path');
    this.outline.setAttribute('class', 'lasso-line');
    this.svg.append(this.scrim, this.outline);
    surface.append(this.svg);
  }

  /** Sends the outline on screen. Does nothing until one has been drawn. */
  confirm(): boolean {
    if (!this.kept || this.finished || this.drawing) return false;
    this.finished = true;
    this.handlers.onDone(this.kept);
    return true;
  }

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
      this.drawing = true;
      this.svg.classList.remove('kept');
      this.points = [{ x: e.clientX, y: e.clientY }];
      this.surface.setPointerCapture?.(e.pointerId);
      this.handlers.onDragStart?.();
      this.handlers.onMove?.(e.clientX, e.clientY);
      this.render();
    });

    on('pointermove', (e: PointerEvent) => {
      this.handlers.onMove?.(e.clientX, e.clientY);
      if (!this.drawing) return;
      const last = this.points[this.points.length - 1]!;
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < STEP) return;
      const clamped = isClamped(e.clientX, e.clientY, innerWidth, innerHeight);
      if (clamped !== this.clamped) {
        this.clamped = clamped;
        this.handlers.onClamped?.(clamped);
      }
      this.points.push({ x: Math.max(0, Math.min(e.clientX, innerWidth)), y: Math.max(0, Math.min(e.clientY, innerHeight)) });
      this.render();
    });

    on('pointerup', (e: PointerEvent) => {
      if (!this.drawing) return;
      this.drawing = false;
      this.points.push({ x: e.clientX, y: e.clientY });
      if (this.clamped) {
        this.clamped = false;
        this.handlers.onClamped?.(false);
      }
      const lasso = finishLasso(this.points, innerWidth, innerHeight);
      if (!lasso) {
        // Too small to be deliberate: the outline waiting, if there is one, stays.
        this.points = this.kept?.path ?? [];
        this.svg.classList.toggle('kept', !!this.kept);
        this.render(!!this.kept);
        this.handlers.onDragEnd?.(!!this.kept);
        return;
      }
      this.points = lasso.path;
      this.render(true);
      if (this.options.adjust) {
        this.kept = lasso;
        this.svg.classList.add('kept');
        this.handlers.onDragEnd?.(true);
        return;
      }
      this.finished = true;
      this.handlers.onDragEnd?.(false);
      this.handlers.onDone(lasso);
    });

    on('dblclick', (e: MouseEvent) => {
      const r = this.kept?.rect;
      if (r && e.clientX >= r.x && e.clientX <= r.x + r.width && e.clientY >= r.y && e.clientY <= r.y + r.height) {
        e.preventDefault();
        this.confirm();
      }
    });

    return () => off.forEach((f) => f());
  }

  /**
   * The outline, plus a scrim over everything outside it: a full-viewport
   * rectangle with the shape cut out (even-odd fill), so what will be sent
   * stays bright while you draw. Before there is a shape to cut out, the
   * scrim covers everything, as the armed screen's dim did.
   */
  private render(closed = false): void {
    const d = pathData(this.points, closed || this.points.length > 2);
    const full = `M0 0H${innerWidth}V${innerHeight}H0Z`;
    this.scrim.setAttribute('d', this.points.length > 2 ? `${full}${d}` : this.drawing ? full : '');
    this.outline.setAttribute('d', pathData(this.points, closed));
  }
}
