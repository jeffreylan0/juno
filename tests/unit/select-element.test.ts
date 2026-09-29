import { beforeEach, describe, expect, it } from 'vitest';
import { describeElement, snapTarget, widen } from '@/entrypoints/content/select-element';

/** jsdom lays nothing out, so give elements the boxes a browser would. */
function box(el: Element, x: number, y: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON() {} }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = `
    <main id="main">
      <div id="wrap"><div id="card">
        <p id="para">Balance <b id="bold">the <i id="ital">equation</i></b> now.</p>
        <p id="eq">Evaluate <span class="katex"><span class="katex-html"><span id="glyph">∫</span></span></span>.</p>
        <table id="table"><tbody><tr><td id="cell">24.10</td></tr></tbody></table>
        <figure id="fig"><svg id="svg"><g><path id="path"/></g></svg><figcaption id="cap">Fig. 1</figcaption></figure>
      </div></div>
    </main>`;
  const $ = (id: string) => document.getElementById(id)!;
  box($('main'), 0, 0, 800, 900);
  box($('wrap'), 20, 20, 760, 800);
  box($('card'), 20, 20, 760, 800); // same size as its wrapper
  box($('para'), 40, 40, 700, 24);
});

const $ = (id: string) => document.getElementById(id)!;

describe('snapTarget', () => {
  it('climbs from inline text to the paragraph it is in', () => {
    expect(snapTarget($('ital'))).toBe($('para'));
    expect(snapTarget($('bold'))).toBe($('para'));
  });

  it('takes a whole equation, never one glyph of it', () => {
    expect(snapTarget($('glyph'))!.className).toBe('katex');
  });

  it('takes the whole table from a cell and the whole figure from inside a drawing', () => {
    expect(snapTarget($('cell'))).toBe($('table'));
    expect(snapTarget($('path'))).toBe($('fig'));
  });

  it('never selects the page itself', () => {
    expect(snapTarget(document.body)).toBeNull();
    expect(snapTarget(document.documentElement)).toBeNull();
  });
});

describe('widen', () => {
  it('goes to the next visibly larger ancestor, skipping same-size wrappers', () => {
    expect(widen($('para'))).toBe($('card'));
    expect(widen($('card'))).toBe($('main'));
  });

  it('stops before the page', () => {
    expect(widen($('main'))).toBeNull();
  });
});

describe('describeElement', () => {
  it('names what was picked in words', () => {
    expect(describeElement($('para'))).toBe('Paragraph');
    expect(describeElement($('table'))).toBe('Table');
    expect(describeElement($('fig'))).toBe('Figure');
    expect(describeElement($('glyph').closest('.katex')!)).toBe('Equation');
    expect(describeElement($('card'))).toBe('Block');
  });
});
