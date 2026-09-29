import { describe, expect, it } from 'vitest';
import { MAX_POINTS, boundsOf, finishLasso, pathData, thin } from '@/entrypoints/content/select-freeform';

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
