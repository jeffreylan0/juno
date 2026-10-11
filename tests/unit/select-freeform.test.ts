import { describe, expect, it } from 'vitest';
import { LassoSelector, MAX_POINTS, boundsOf, finishLasso, pathData, thin, type Lasso } from '@/entrypoints/content/select-freeform';

const circle = (cx: number, cy: number, r: number, n = 64) =>
  Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((i / n) * 2 * Math.PI), y: cy + r * Math.sin((i / n) * 2 * Math.PI) }));

describe('freeform lasso', () => {
  it('turns a drawn loop into its outline and bounding box', () => {
    const lasso = finishLasso(circle(200, 150, 50), 800, 600)!;
    expect(lasso.path.length).toBe(64);
    expect(lasso.rect.x).toBeCloseTo(150);
    expect(lasso.rect.y).toBeCloseTo(100);
    expect(lasso.rect.width).toBeCloseTo(100);
    expect(lasso.rect.height).toBeCloseTo(100, 0);
  });

  it('ignores a scribble too small to mean anything', () => {
    expect(finishLasso(circle(200, 150, 3), 800, 600)).toBeNull();
    expect(finishLasso([{ x: 1, y: 1 }, { x: 50, y: 50 }], 800, 600)).toBeNull();
  });

  it('keeps the outline on screen, since only the screen can be captured', () => {
    const lasso = finishLasso(circle(780, 300, 60), 800, 600)!;
    expect(Math.max(...lasso.path.map((p) => p.x))).toBe(800);
    expect(lasso.rect.x + lasso.rect.width).toBeLessThanOrEqual(800);
  });

  it('thins long paths but keeps both ends', () => {
    const long = Array.from({ length: 5000 }, (_, i) => ({ x: i, y: i % 7 }));
    const out = thin(long);
    expect(out).toHaveLength(MAX_POINTS);
    expect(out[0]).toEqual(long[0]);
    expect(out[out.length - 1]).toEqual(long[long.length - 1]);
  });

  it('writes SVG path data, closed when finished', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }];
    expect(pathData(pts, false)).toBe('M0.0 0.0L10.0 0.0L5.0 8.0');
    expect(pathData(pts, true)).toBe('M0.0 0.0L10.0 0.0L5.0 8.0Z');
    expect(boundsOf(pts)).toEqual({ x: 0, y: 0, width: 10, height: 8 });
  });
});

describe('LassoSelector', () => {
  function setup(adjust: boolean) {
    const surface = document.createElement('div');
    document.body.append(surface);
    const done: Lasso[] = [];
    const ends: boolean[] = [];
    const sel = new LassoSelector(surface, { onDone: (l) => done.push(l), onDragEnd: (kept) => ends.push(kept) }, { adjust });
    const off = sel.attach();
    const fire = (type: string, x: number, y: number) =>
      surface.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }) as PointerEvent);
    const loop = (cx: number, cy: number, r: number) => {
      const pts = circle(cx, cy, r, 32);
      fire('pointerdown', pts[0]!.x, pts[0]!.y);
      for (const p of pts.slice(1)) fire('pointermove', p.x, p.y);
      fire('pointerup', pts[0]!.x, pts[0]!.y);
    };
    const svg = () => surface.querySelector('svg')!;
    return { sel, done, ends, fire, loop, svg, off };
  }

  it('sends on release when adjusting is off', () => {
    const t = setup(false);
    t.loop(200, 150, 50);
    expect(t.done).toHaveLength(1);
    expect(t.ends).toEqual([false]);
  });

  it('keeps the outline until confirmed when adjusting is on', () => {
    const t = setup(true);
    t.loop(200, 150, 50);
    expect(t.done).toEqual([]);
    expect(t.ends).toEqual([true]);
    expect(t.svg().classList.contains('kept')).toBe(true);
    expect(t.sel.confirm()).toBe(true);
    expect(t.done).toHaveLength(1);
    expect(t.done[0]!.rect.x).toBeCloseTo(150, 0);
    // Once sent, it is done.
    expect(t.sel.confirm()).toBe(false);
  });

  it('replaces the kept outline with a new one, and keeps it through a stray click', () => {
    const t = setup(true);
    t.loop(200, 150, 50);
    t.loop(500, 400, 40);
    t.fire('pointerdown', 50, 50);
    t.fire('pointerup', 51, 51);
    expect(t.ends).toEqual([true, true, true]);
    t.sel.confirm();
    expect(t.done[0]!.rect.x).toBeCloseTo(460, 0);
  });

  it('confirms on a double-click inside the outline', () => {
    const t = setup(true);
    t.loop(200, 150, 50);
    t.fire('dblclick', 500, 500);
    expect(t.done).toEqual([]);
    t.fire('dblclick', 200, 150);
    expect(t.done).toHaveLength(1);
  });

  it('has nothing to confirm before an outline is drawn', () => {
    const t = setup(true);
    expect(t.sel.confirm()).toBe(false);
  });
});
