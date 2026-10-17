import { describe, expect, it } from 'vitest';
import { BoxSelector, clampToViewport, hitTest, isClamped, moveRect, normalizeRect, resizeRect } from '@/selection/select-box';

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

describe('hitTest', () => {
  const r = { x: 100, y: 100, width: 200, height: 100 };

  it('grabs corners before edges', () => {
    expect(hitTest(r, 100, 100)).toBe('nw');
    expect(hitTest(r, 302, 198)).toBe('se');
    expect(hitTest(r, 300, 100)).toBe('ne');
    expect(hitTest(r, 98, 203)).toBe('sw');
  });

  it('grabs an edge from a few pixels either side', () => {
    expect(hitTest(r, 200, 95)).toBe('n');
    expect(hitTest(r, 200, 205)).toBe('s');
    expect(hitTest(r, 94, 150)).toBe('w');
    expect(hitTest(r, 306, 150)).toBe('e');
  });

  it('moves from inside and starts over from outside', () => {
    expect(hitTest(r, 200, 150)).toBe('inside');
    expect(hitTest(r, 50, 50)).toBe('outside');
    expect(hitTest(r, 200, 250)).toBe('outside');
  });

  it('picks the nearer edge on a box thinner than the grab zone', () => {
    const thin = { x: 100, y: 100, width: 200, height: 10 };
    expect(hitTest(thin, 200, 101)).toBe('n');
    expect(hitTest(thin, 200, 109)).toBe('s');
  });
});

describe('resizeRect', () => {
  const r = { x: 100, y: 100, width: 200, height: 100 };

  it('moves only the dragged edge', () => {
    expect(resizeRect(r, 'e', 50, 999, 800, 600)).toEqual({ x: 100, y: 100, width: 250, height: 100 });
    expect(resizeRect(r, 'n', 999, -40, 800, 600)).toEqual({ x: 100, y: 60, width: 200, height: 140 });
  });

  it('moves both edges of a corner', () => {
    expect(resizeRect(r, 'nw', 20, 10, 800, 600)).toEqual({ x: 120, y: 110, width: 180, height: 90 });
  });

  it('flips instead of inverting when dragged past the opposite side', () => {
    expect(resizeRect(r, 'w', 250, 0, 800, 600)).toEqual({ x: 300, y: 100, width: 50, height: 100 });
  });

  it('stays inside the viewport', () => {
    expect(resizeRect(r, 'se', 1000, 1000, 800, 600)).toEqual({ x: 100, y: 100, width: 700, height: 500 });
  });
});

describe('moveRect', () => {
  it('keeps the size and stops at the edges', () => {
    const r = { x: 100, y: 100, width: 200, height: 100 };
    expect(moveRect(r, 30, -20, 800, 600)).toEqual({ x: 130, y: 80, width: 200, height: 100 });
    expect(moveRect(r, -500, 900, 800, 600)).toEqual({ x: 0, y: 500, width: 200, height: 100 });
  });
});

describe('BoxSelector', () => {
  function setup(adjust: boolean) {
    const surface = document.createElement('div');
    const box = document.createElement('div');
    document.body.append(surface, box);
    const done: unknown[] = [];
    const adjusted: unknown[] = [];
    const sel = new BoxSelector(surface, box, { onDone: (r) => done.push(r), onAdjust: (r) => adjusted.push(r) }, { adjust });
    const off = sel.attach();
    const fire = (type: string, x: number, y: number) =>
      surface.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }) as PointerEvent);
    const drag = (x0: number, y0: number, x1: number, y1: number) => {
      fire('pointerdown', x0, y0);
      fire('pointermove', x1, y1);
      fire('pointerup', x1, y1);
    };
    return { sel, box, done, adjusted, drag, fire, off };
  }

  it('sends on release when adjusting is off', () => {
    const t = setup(false);
    t.drag(100, 100, 300, 200);
    expect(t.done).toEqual([{ x: 100, y: 100, width: 200, height: 100 }]);
    expect(t.adjusted).toEqual([]);
  });

  it('waits for a confirm when adjusting is on, and sends the adjusted box', () => {
    const t = setup(true);
    t.drag(100, 100, 300, 200);
    expect(t.done).toEqual([]);
    expect(t.sel.adjusting).toBe(true);
    expect(t.box.classList.contains('adjusting')).toBe(true);

    t.drag(300, 200, 340, 260); // pull the bottom-right corner out
    t.drag(200, 150, 210, 160); // then nudge the whole box
    expect(t.sel.confirm()).toBe(true);
    expect(t.done).toEqual([{ x: 110, y: 110, width: 240, height: 160 }]);
    expect(t.sel.confirm()).toBe(false);
  });

  it('keeps the box being adjusted when a stray click lands outside it', () => {
    const t = setup(true);
    t.drag(100, 100, 300, 200);
    t.drag(500, 500, 501, 501);
    expect(t.sel.adjusting).toBe(true);
    t.sel.confirm();
    expect(t.done).toEqual([{ x: 100, y: 100, width: 200, height: 100 }]);
  });

  it('starts over when a new box is drawn outside the old one', () => {
    const t = setup(true);
    t.drag(100, 100, 300, 200);
    t.drag(400, 300, 500, 400);
    t.sel.confirm();
    expect(t.done).toEqual([{ x: 400, y: 300, width: 100, height: 100 }]);
  });

  it('confirms on a double-click inside the box', () => {
    const t = setup(true);
    t.drag(100, 100, 300, 200);
    t.fire('dblclick', 200, 150);
    expect(t.done).toHaveLength(1);
  });
});
