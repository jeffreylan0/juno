/**
 * Element selection: hover to highlight one element, click to pick it. The AI
 * gets a screenshot snapped to the element's exact edges — like a box, but
 * without the fiddly drag — so nothing is read off the page here either.
 *
 * What the pointer is literally over is usually too small to be useful: a
 * <span> inside a sentence, one glyph of a KaTeX formula, a <td>. So the hit is
 * snapped to something a student means — a paragraph, a whole equation, a
 * table, a figure — and ↑/↓ widen to the parent or narrow back.
 */
import type { Rect } from '@shared/payload';
import { clampToViewport } from './select-box';

/** Tags that live inside a line of text; a hit on one climbs to its block. */
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'FONT', 'I', 'KBD', 'LABEL',
  'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR',
]);

/**
 * Things that are one unit however they are built. Checked outermost-first,
 * so a hit anywhere in a displayed equation picks the whole display.
 */
const ATOMIC = [
  '.katex-display',
  'mjx-container',
  '.MathJax_Display',
  '.katex',
  '.MathJax',
  'math',
  'table',
  'figure',
  'pre',
  'picture',
  'svg',
  'img',
  'canvas',
  'video',
];

/** Extra pixels around the element, so antialiased edges are not shaved off. */
export const ELEMENT_PAD = 3;

function isPage(el: Element | null): boolean {
  return !el || el === document.documentElement || el === document.body;
}

/** The outermost atomic container of `el`, if it is inside one. */
function atomicAncestor(el: Element): Element | null {
  for (const sel of ATOMIC) {
    // For nested SVGs and tables the outermost one is the figure.
    let found: Element | null = el.closest(sel);
    while (found?.parentElement?.closest(sel)) found = found.parentElement.closest(sel);
    if (found && !isPage(found)) return found;
  }
  return null;
}

/** What a hit on `el` should select, or null for the page itself. */
export function snapTarget(el: Element | null): Element | null {
  if (!el || isPage(el)) return null;
  const atomic = atomicAncestor(el);
  if (atomic) return atomic;
  let cur: Element = el;
  while (INLINE_TAGS.has(cur.tagName) && cur.parentElement && !isPage(cur.parentElement)) {
    const display = getComputedStyle(cur).display;
    // An inline-looking tag laid out as a block is a block for our purposes.
    if (display && !display.startsWith('inline') && display !== 'contents') break;
    cur = cur.parentElement;
  }
  return isPage(cur) ? null : cur;
}

function sameBox(a: DOMRect, b: DOMRect): boolean {
  return Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}

/**
 * The next visibly larger ancestor. Wrappers that are exactly the same size
 * are skipped, or ↑ would appear to do nothing.
 */
export function widen(el: Element): Element | null {
  const box = el.getBoundingClientRect();
  let cur = el.parentElement;
  while (cur && !isPage(cur) && sameBox(cur.getBoundingClientRect(), box)) cur = cur.parentElement;
  return isPage(cur) ? null : cur;
}

/** A name for what was picked, for the highlight's tag and the panel. */
export function describeElement(el: Element): string {
  if (el.matches('.katex, .katex-display, mjx-container, .MathJax, .MathJax_Display, math')) return 'Equation';
  switch (el.tagName) {
    case 'TABLE':
      return 'Table';
    case 'IMG':
    case 'PICTURE':
      return 'Image';
    case 'SVG':
    case 'svg':
    case 'CANVAS':
    case 'FIGURE':
      return 'Figure';
    case 'VIDEO':
      return 'Video';
    case 'PRE':
    case 'CODE':
      return 'Code';
    case 'P':
      return 'Paragraph';
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'Heading';
    case 'UL':
    case 'OL':
    case 'DL':
      return 'List';
    case 'LI':
      return 'List item';
    case 'BLOCKQUOTE':
      return 'Quote';
    case 'FORM':
      return 'Form';
    case 'SECTION':
    case 'ARTICLE':
    case 'MAIN':
    case 'ASIDE':
      return 'Section';
    default:
      return 'Block';
  }
}

export interface PickedElement {
  rect: Rect;
  label: string;
  /** Part of the element was off screen and is not in the capture. */
  clipped: boolean;
}

export interface ElementPickerHandlers {
  /** The highlighted element changed (null: nothing under the pointer). */
  onHighlight: (rect: Rect | null, label: string) => void;
  /** The pointer moved, for anything tracking it. */
  onMove?: (x: number, y: number) => void;
  /** The student picked the highlighted element. */
  onPick: (picked: PickedElement) => void;
  /** True for events that started on our own UI. */
  isOurs: (e: Event) => boolean;
}

export class ElementPicker {
  private current: Element | null = null;
  /** Narrower elements left behind by ↑, so ↓ can go back to them. */
  private trail: Element[] = [];
  private picking = false;
  private raf = 0;

  constructor(
    private host: Element,
    private handlers: ElementPickerHandlers,
  ) {}

  /** Wires listeners and returns the teardown. */
  attach(): () => void {
    const off: (() => void)[] = [];
    const on = (target: EventTarget, type: string, fn: (e: never) => void, opts: AddEventListenerOptions = { capture: true }) => {
      const h = fn as EventListener;
      target.addEventListener(type, h, opts);
      off.push(() => target.removeEventListener(type, h, opts));
    };

    on(window, 'pointermove', (e: PointerEvent) => {
      this.handlers.onMove?.(e.clientX, e.clientY);
      if (this.picking || this.handlers.isOurs(e)) return;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (!hit || hit === this.host || this.host.contains(hit)) return;
      const target = snapTarget(hit);
      if (target === this.current || (target && this.trail.includes(target))) return;
      this.trail = [];
      this.set(target);
    });

    // The page must not act on the click that picks: no links followed, no
    // buttons pressed, no text selection started.
    const swallow = (e: MouseEvent) => {
      if (this.handlers.isOurs(e) || e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    on(window, 'pointerdown', swallow);
    on(window, 'mousedown', swallow);
    on(window, 'mouseup', swallow);
    on(window, 'click', (e: MouseEvent) => {
      if (this.handlers.isOurs(e) || e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void this.pick();
    });

    on(window, 'keydown', (e: KeyboardEvent) => {
      if (this.handlers.isOurs(e)) return;
      if (e.key === 'ArrowUp' && this.current) {
        const up = widen(this.current);
        if (up) {
          this.trail.push(this.current);
          this.set(up);
        }
      } else if (e.key === 'ArrowDown' && this.trail.length) {
        this.set(this.trail.pop()!);
      } else if (e.key === 'Enter' && this.current) {
        void this.pick();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });

    // The highlight is in viewport coordinates, so it follows the page.
    const follow = () => {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.set(this.current, true));
    };
    on(window, 'scroll', follow, { capture: true, passive: true });
    on(window, 'resize', follow, { passive: true });

    return () => {
      cancelAnimationFrame(this.raf);
      off.forEach((f) => f());
    };
  }

  private set(el: Element | null, refresh = false): void {
    if (!refresh && el === this.current) return;
    this.current = el;
    this.handlers.onHighlight(el ? padded(el.getBoundingClientRect()) : null, el ? describeElement(el) : '');
  }

  /**
   * Brings the element on screen if it is not, then reports what can be
   * captured. `captureVisibleTab` only sees the viewport, so an element taller
   * than the screen is captured from its top down and flagged as clipped.
   */
  private async pick(): Promise<void> {
    const el = this.current;
    if (!el || this.picking) return;
    this.picking = true;
    let r = el.getBoundingClientRect();
    const offscreen = r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth;
    if (offscreen) {
      const fits = r.height <= innerHeight;
      el.scrollIntoView({ block: fits ? 'nearest' : 'start', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
      await frames(2);
      r = el.getBoundingClientRect();
    }
    const full = padded(r);
    const rect = clampToViewport(full, innerWidth, innerHeight);
    const clipped = rect.width < full.width - ELEMENT_PAD * 2 - 1 || rect.height < full.height - ELEMENT_PAD * 2 - 1;
    this.handlers.onPick({ rect, label: describeElement(el), clipped });
  }
}

function padded(r: DOMRect): Rect {
  return { x: r.left - ELEMENT_PAD, y: r.top - ELEMENT_PAD, width: r.width + ELEMENT_PAD * 2, height: r.height + ELEMENT_PAD * 2 };
}

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
}
