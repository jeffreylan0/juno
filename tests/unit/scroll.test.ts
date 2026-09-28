import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWheel, isScrollable, scrollTargetAt } from '@/entrypoints/content/scroll';

// jsdom has no layout engine and so no elementFromPoint; define one per test.
function pointsAt(el: Element | null, onCall?: () => void): void {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => {
      onCall?.();
      return el;
    },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(document, 'elementFromPoint');
});

/** jsdom reports every element as zero-sized, so the metrics are stubbed. */
function sized(el: Element, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollWidth', { value: 0, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: 0, configurable: true });
}

describe('isScrollable', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is true only when overflow allows it and there is more content than room', () => {
    document.body.innerHTML = `
      <div id="scrolls" style="overflow-y: auto"></div>
      <div id="tall" style="overflow-y: auto"></div>
      <div id="hidden" style="overflow-y: hidden"></div>`;
    const el = (id: string) => document.getElementById(id)!;
    sized(el('scrolls'), 2000, 400);
    sized(el('tall'), 400, 400);
    sized(el('hidden'), 2000, 400);

    expect(isScrollable(el('scrolls'))).toBe(true);
    expect(isScrollable(el('tall')), 'nothing to scroll').toBe(false);
    expect(isScrollable(el('hidden')), 'overflow hidden').toBe(false);
  });
});

describe('scrollTargetAt', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds the scrollable container under the pointer, not the document', () => {
    document.body.innerHTML = `<div id="viewer" style="overflow-y: auto"><p id="page">page</p></div>`;
    const viewer = document.getElementById('viewer')!;
    sized(viewer, 5000, 600);
    pointsAt(document.getElementById('page'));

    expect(scrollTargetAt(10, 10, null)).toBe(viewer);
  });

  it('falls back to the document when nothing under the pointer scrolls', () => {
    document.body.innerHTML = `<p id="page">page</p>`;
    pointsAt(document.getElementById('page'));
    expect(scrollTargetAt(10, 10, null)).toBe(document.scrollingElement ?? document.documentElement);
  });

  it('hides our own overlay for the hit test and puts it back', () => {
    document.body.innerHTML = `<p id="page">page</p>`;
    const host = document.createElement('selection-ai-overlay') as HTMLElement;
    host.style.display = 'block';
    document.body.append(host);
    let displayDuringHitTest: string | null = null;
    pointsAt(document.getElementById('page'), () => {
      displayDuringHitTest = host.style.display;
    });

    scrollTargetAt(10, 10, host);
    expect(displayDuringHitTest, 'overlay was still hit-testable').toBe('none');
    expect(host.style.display, 'overlay was left hidden').toBe('block');
  });
});

describe('applyWheel', () => {
  it('passes pixel deltas straight through', () => {
    const el = document.createElement('div');
    const scrollBy = vi.fn();
    el.scrollBy = scrollBy as unknown as typeof el.scrollBy;
    applyWheel(el, { deltaX: 0, deltaY: 120, deltaMode: 0 } as WheelEvent);
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 0, top: 120 }));
  });

  it('scales line deltas, which is what a classic mouse wheel sends', () => {
    const el = document.createElement('div');
    const scrollBy = vi.fn();
    el.scrollBy = scrollBy as unknown as typeof el.scrollBy;
    applyWheel(el, { deltaX: 0, deltaY: 3, deltaMode: 1 } as WheelEvent);
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ top: 48 }));
  });
});
