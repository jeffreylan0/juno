import { beforeAll, describe, expect, it } from 'vitest';
import { readSelection } from '@/entrypoints/content/select-text';

// jsdom has no layout engine, so Range geometry has to be stubbed. The real
// rect is exercised in tests/e2e against a live page.
beforeAll(() => {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 10, y: 20, left: 10, top: 20, width: 100, height: 18, right: 110, bottom: 38 }) as DOMRect;
});

/** Selects the contents of `#target` in the current document. */
function selectTarget(): void {
  const el = document.getElementById('target')!;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

describe('readSelection', () => {
  it('returns null when nothing is selected', () => {
    document.body.innerHTML = '<p id="target">hello</p>';
    window.getSelection()?.removeAllRanges();
    expect(readSelection()).toBeNull();
  });

  it('returns the trimmed text and the cloned HTML of the range', () => {
    document.body.innerHTML = '<p id="target">  an <em>integral</em>  </p>';
    selectTarget();
    const sel = readSelection();
    expect(sel?.text).toBe('an integral');
    expect(sel?.html).toContain('<em>integral</em>');
    expect(sel?.rect).toEqual({ x: 10, y: 20, width: 100, height: 18 });
  });

  it('returns null for a whitespace-only selection', () => {
    document.body.innerHTML = '<p id="target">   </p>';
    selectTarget();
    expect(readSelection()).toBeNull();
  });
});
