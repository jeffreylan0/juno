/**
 * jsdom has no layout engine, so getClientRects is stubbed per element to
 * describe the geometry each case needs. The logic under test — visibility
 * rules and rect overlap — is what matters here; the real geometry is covered
 * end-to-end in tests/e2e.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { intersectArea, isElementVisible, textInRect } from '@/extract/visible';

function stubRects(map: Record<string, DOMRect[]>) {
  Range.prototype.getClientRects = function (this: Range) {
    const key = (this.startContainer.parentElement?.getAttribute('data-id') ?? '') as string;
    const rects = map[key] ?? [];
    return Object.assign(rects, { item: (i: number) => rects[i] ?? null }) as unknown as DOMRectList;
  };
}

const rect = (x: number, y: number, w: number, h: number) =>
  ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;

describe('intersectArea', () => {
  it('measures overlap and returns 0 when disjoint', () => {
    expect(intersectArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(25);
    expect(intersectArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 5 })).toBe(0);
  });
});

describe('isElementVisible', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('rejects display:none, visibility:hidden, opacity:0, tiny text and same-colour text', () => {
    document.body.innerHTML = `
      <p id="ok">visible</p>
      <p id="none" style="display:none">x</p>
      <p id="hidden" style="visibility:hidden">x</p>
      <p id="clear" style="opacity:0">x</p>
      <p id="tiny" style="font-size:1px">x</p>
      <p id="white" style="color:rgb(255,255,255);background-color:rgb(255,255,255)">x</p>`;
    const el = (id: string) => document.getElementById(id)!;
    expect(isElementVisible(el('ok'))).toBe(true);
    for (const id of ['none', 'hidden', 'clear', 'tiny', 'white']) {
      expect(isElementVisible(el(id)), id).toBe(false);
    }
  });
});

describe('textInRect', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps text inside the rect and drops text outside it', () => {
    document.body.innerHTML = `<p data-id="in">inside</p><p data-id="out">outside</p>`;
    stubRects({ in: [rect(10, 10, 100, 20)], out: [rect(10, 500, 100, 20)] });
    expect(textInRect({ x: 0, y: 0, width: 200, height: 100 })).toBe('inside');
  });

  it('drops hidden and decoy text even when it lies inside the rect', () => {
    document.body.innerHTML = `
      <p data-id="in">keep</p>
      <p data-id="none" style="display:none">drop-none</p>
      <p data-id="white" style="color:rgb(255,255,255);background-color:rgb(255,255,255)">drop-white</p>
      <p data-id="tiny" style="font-size:1px">drop-tiny</p>`;
    stubRects({ in: [rect(0, 0, 50, 10)], none: [rect(0, 0, 50, 10)], white: [rect(0, 0, 50, 10)], tiny: [rect(0, 0, 50, 10)] });
    const out = textInRect({ x: 0, y: 0, width: 200, height: 200 });
    expect(out).toBe('keep');
    expect(out).not.toContain('drop');
  });

  it('needs at least half the text box inside the rect', () => {
    document.body.innerHTML = `<p data-id="edge">edge</p>`;
    stubRects({ edge: [rect(90, 0, 100, 10)] }); // 10% inside
    expect(textInRect({ x: 0, y: 0, width: 100, height: 100 })).toBe('');
    stubRects({ edge: [rect(40, 0, 100, 10)] }); // 60% inside
    expect(textInRect({ x: 0, y: 0, width: 100, height: 100 })).toBe('edge');
  });

  it('separates block-level runs with newlines and ignores script and style', () => {
    document.body.innerHTML = `<p data-id="a">one</p><style data-id="s">.x{}</style><p data-id="b">two</p>`;
    stubRects({ a: [rect(0, 0, 50, 10)], b: [rect(0, 20, 50, 10)], s: [rect(0, 0, 50, 10)] });
    expect(textInRect({ x: 0, y: 0, width: 100, height: 100 })).toBe('one\ntwo');
  });
});
