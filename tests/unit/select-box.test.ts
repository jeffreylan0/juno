import { describe, expect, it } from 'vitest';
import { clampToViewport, isClamped, normalizeRect } from '@/entrypoints/content/select-box';

describe('normalizeRect', () => {
  it('works whichever corner the drag started from', () => {
    const forward = normalizeRect(10, 20, 110, 70);
    const backward = normalizeRect(110, 70, 10, 20);
    expect(forward).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(backward).toEqual(forward);
  });
});

describe('clampToViewport', () => {
  it('keeps a rect that already fits', () => {
    expect(clampToViewport({ x: 10, y: 10, width: 100, height: 50 }, 800, 600)).toEqual({ x: 10, y: 10, width: 100, height: 50 });
  });

  it('trims a rect that runs past the fold, since only the viewport can be captured', () => {
    expect(clampToViewport({ x: 700, y: 500, width: 400, height: 400 }, 800, 600)).toEqual({ x: 700, y: 500, width: 100, height: 100 });
  });

  it('trims a rect that starts off-screen', () => {
    expect(clampToViewport({ x: -50, y: -30, width: 100, height: 100 }, 800, 600)).toEqual({ x: 0, y: 0, width: 50, height: 70 });
  });
});

describe('isClamped', () => {
  it('reports pressing against any edge', () => {
    expect(isClamped(400, 599, 800, 600)).toBe(true);
    expect(isClamped(1, 300, 800, 600)).toBe(true);
    expect(isClamped(400, 300, 800, 600)).toBe(false);
  });
});
