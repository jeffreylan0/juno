/**
 * Text and Element in the app, drawn on the overlay over what the app read
 * off the screen (lib/screen-text.ts):
 *
 *  - Text: drag across words, as in Live Text; the selection runs like a
 *    text selection, line by line. A double-click takes one word.
 *  - Element: hovering lights up the paragraph (or window, or screen) under
 *    the pointer; ↑ widens it, ↓ narrows it to a line; a click or Enter picks.
 *
 * As with Box and Freeform, the screen stays dimmed outside what is selected.
 */
import type { Point, Rect } from '@shared/payload';
import {
  confidenceOf,
  highlightRects,
  lineAt,
  needsPicture,
  outlinesOf,
  targetsAt,
  textOf,
  unionOf,
  windowAt,
  wordNear,
  wordsBetween,
  type Layout,
  type ScreenWindow,
  type Target,
  type WordAt,
} from '@/lib/screen-text';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A click that moves less than this is a click, not a drag. */
const CLICK_SLOP = 4;

export interface ScreenTextSelection {
  text: string;
  rect: Rect;
  /** The highlight's outline, when it is one shape: the picture (if one goes) is cut to it. */
  path?: Point[];
  /** The picture should go along with the text (see needsPicture). */
  unsure: boolean;
  window?: ScreenWindow;
}

/** The dim, with holes where the selection is, and a tint over the holes. */
class Marks {
  private svg: SVGSVGElement;
  private scrim: SVGPathElement;
  private tint: SVGPathElement;

  constructor(surface: HTMLElement) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'marks');
    this.scrim = document.createElementNS(SVG_NS, 'path');
    this.scrim.setAttribute('class', 'marks-scrim');
    this.scrim.setAttribute('fill-rule', 'evenodd');
    this.tint = document.createElementNS(SVG_NS, 'path');
    this.tint.setAttribute('class', 'marks-tint');
    this.svg.append(this.scrim, this.tint);
    surface.append(this.svg);
    this.set([]);
  }

  set(shapes: Point[][]): void {
    const d = shapes.map((s) => `M${s.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}Z`).join('');
    this.scrim.setAttribute('d', `M0 0H${innerWidth}V${innerHeight}H0Z${d}`);
    this.tint.setAttribute('d', d);
  }
}

export interface ScreenTextHandlers {
  onDragStart?: () => void;
  /** The drag ended; `kept` when a selection is on screen afterwards (adjusting on). */
  onDragEnd?: (kept: boolean) => void;
  onMove?: (x: number, y: number) => void;
  onDone: (selection: ScreenTextSelection) => void;
}

export class ScreenTextSelector {
  private marks: Marks;
  private anchor: WordAt | null = null;
  private focus: WordAt | null = null;
  private down: Point | null = null;
  private moved = false;
  private kept: { words: WordAt[]; selection: ScreenTextSelection } | null = null;
  private finished = false;

  constructor(
    private surface: HTMLElement,
    private layout: Layout,
    private handlers: ScreenTextHandlers,
    private options: { adjust: boolean } = { adjust: false },
  ) {
    this.marks = new Marks(surface);
  }

  /** Sends the selection on screen. Does nothing until there is one. */
  confirm(): boolean {
    if (!this.kept || this.finished || this.down) return false;
    this.finished = true;
    this.handlers.onDone(this.kept.selection);
    return true;
  }

  attach(): () => void {
    const off: (() => void)[] = [];
    const on = (type: string, fn: (e: never) => void) => {
      const h = fn as EventListener;
      this.surface.addEventListener(type, h);
      off.push(() => this.surface.removeEventListener(type, h));
    };

    on('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 || this.finished) return;
      const at = wordNear(this.layout, e.clientX, e.clientY);
      if (!at) return;
      e.preventDefault();
      this.surface.setPointerCapture?.(e.pointerId);
      this.anchor = this.focus = at;
      this.down = { x: e.clientX, y: e.clientY };
      this.moved = false;
      this.handlers.onDragStart?.();
    });

    on('pointermove', (e: PointerEvent) => {
      this.handlers.onMove?.(e.clientX, e.clientY);
      if (!this.down) {
        this.surface.style.cursor = lineAt(this.layout, e.clientX, e.clientY) === null ? 'default' : 'text';
        return;
      }
      if (!this.moved && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < CLICK_SLOP) return;
      this.moved = true;
      this.focus = wordNear(this.layout, e.clientX, e.clientY, Infinity) ?? this.focus;
      this.show(this.current());
    });

    on('pointerup', () => {
      if (!this.down) return;
      this.down = null;
      // A click is not a selection: whatever was kept stays.
      if (!this.moved) {
        this.show(this.kept?.words ?? []);
        this.handlers.onDragEnd?.(!!this.kept);
        return;
      }
      this.finish(this.current());
    });

    on('dblclick', (e: MouseEvent) => {
      const at = wordNear(this.layout, e.clientX, e.clientY, 0);
      if (!at || this.finished) return;
      e.preventDefault();
      this.handlers.onDragStart?.();
      this.finish([at]);
    });

    return () => off.forEach((f) => f());
  }

  private current(): WordAt[] {
    return this.anchor && this.focus ? wordsBetween(this.layout, this.anchor, this.focus) : [];
  }

  private finish(words: WordAt[]): void {
    if (!words.length) {
      this.handlers.onDragEnd?.(!!this.kept);
      return;
    }
    const selection = this.selectionOf(words);
    this.show(words);
    if (this.options.adjust) {
      this.kept = { words, selection };
      this.handlers.onDragEnd?.(true);
      return;
    }
    this.finished = true;
    this.handlers.onDragEnd?.(false);
    this.handlers.onDone(selection);
  }

  private show(words: WordAt[]): void {
    this.marks.set(outlinesOf(highlightRects(this.layout, words)));
  }

  private selectionOf(words: WordAt[]): ScreenTextSelection {
    const rects = highlightRects(this.layout, words);
    const outlines = outlinesOf(rects);
    const rect = unionOf(rects);
    const text = textOf(this.layout, words);
    return {
      text,
      rect,
      ...(outlines.length === 1 ? { path: outlines[0] } : {}),
      unsure: needsPicture(text, confidenceOf(this.layout, words)),
      window: windowAt(this.layout, rect.x + rect.width / 2, rect.y + rect.height / 2),
    };
  }
}

export interface ScreenElementHandlers {
  onHighlight?: (target: Target | null) => void;
  onPick: (target: Target) => void;
}

/**
 * Hover lights up a target; the level the student chose with ↑ ↓ (paragraph
 * to begin with) is kept as the pointer moves, wherever there is one.
 */
export class ScreenElementPicker {
  private pick: HTMLElement;
  private tag: HTMLElement;
  private targets: Target[] = [];
  private index = 0;
  private level: Target['kind'] = 'paragraph';
  private done = false;

  constructor(
    private surface: HTMLElement,
    private layout: Layout,
    private handlers: ScreenElementHandlers,
  ) {
    this.pick = document.createElement('div');
    this.pick.className = 'pick';
    this.tag = document.createElement('div');
    this.tag.className = 'tag';
    this.tag.setAttribute('data-testid', 'element-tag');
    surface.append(this.pick, this.tag);
  }

  attach(): () => void {
    const onMove = (e: PointerEvent) => this.hover(e.clientX, e.clientY);
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.choose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!this.targets.length) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const next = this.index + (e.key === 'ArrowUp' ? 1 : -1);
        if (next < 0 || next >= this.targets.length) return;
        this.index = next;
        this.level = this.targets[next]!.kind;
        this.show();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.choose();
      }
    };
    this.surface.addEventListener('pointermove', onMove);
    this.surface.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
    return () => {
      this.surface.removeEventListener('pointermove', onMove);
      this.surface.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  private hover(x: number, y: number): void {
    this.targets = targetsAt(this.layout, x, y);
    const order: Target['kind'][] = ['line', 'paragraph', 'window', 'screen'];
    // The chosen level if it is here, otherwise the next larger one that is.
    const want = order.indexOf(this.level);
    const i = this.targets.findIndex((t) => order.indexOf(t.kind) >= want);
    this.index = i === -1 ? this.targets.length - 1 : i;
    this.show();
  }

  private show(): void {
    const t = this.targets[this.index];
    this.handlers.onHighlight?.(t ?? null);
    if (!t) {
      this.pick.style.display = this.tag.style.display = 'none';
      return;
    }
    Object.assign(this.pick.style, { display: 'block', left: `${t.rect.x}px`, top: `${t.rect.y}px`, width: `${t.rect.width}px`, height: `${t.rect.height}px` });
    this.pick.dataset.kind = t.kind;
    this.tag.textContent = t.label;
    this.tag.style.display = 'block';
    // Above the target when there is room, otherwise just inside it.
    const top = t.rect.y >= 26 ? t.rect.y - 24 : t.rect.y + 6;
    this.tag.style.transform = `translate(${Math.max(6, t.rect.x)}px, ${Math.max(6, top)}px)`;
  }

  private choose(): void {
    const t = this.targets[this.index];
    if (!t || this.done) return;
    this.done = true;
    this.handlers.onPick(t);
  }
}
