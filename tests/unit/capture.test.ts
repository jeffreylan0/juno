import { describe, expect, it } from 'vitest';
import { fitWithin, pathToCrop, toDeviceRect } from '@/lib/capture';

describe('capture geometry', () => {
  it('scales CSS pixels by devicePixelRatio', () => {
    expect(toDeviceRect({ x: 10, y: 20, width: 30, height: 40 }, 2, { width: 2000, height: 2000 })).toEqual({
      x: 20,
      y: 40,
      width: 60,
      height: 80,
    });
  });

  it('clamps to the captured image', () => {
    const r = toDeviceRect({ x: -5, y: 990, width: 50, height: 50 }, 1, { width: 1000, height: 1000 });
    expect(r).toEqual({ x: 0, y: 990, width: 45, height: 10 });
  });

  it('rounds outward so no edge pixels are lost', () => {
    const r = toDeviceRect({ x: 0.4, y: 0.4, width: 10.2, height: 10.2 }, 1, { width: 100, height: 100 });
    expect(r).toEqual({ x: 0, y: 0, width: 11, height: 11 });
  });

  it('downscales only when the longest edge exceeds the limit', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(3136, 1000, 1568)).toEqual({ width: 1568, height: 500 });
  });
});

describe('freeform masking geometry', () => {
  it('maps the outline into the crop, at device pixels and after downscaling', () => {
    // A 100×50 CSS box at (10, 20) on a 2× screen → 200×100 device px, shown at half size.
    const src = toDeviceRect({ x: 10, y: 20, width: 100, height: 50 }, 2, { width: 2000, height: 2000 });
    const out = { width: 100, height: 50 };
    const pts = pathToCrop([{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 60, y: 70 }], 2, src, out);
    expect(pts).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 50 }]);
  });
});
