/**
 * Text and Element in the app, from what it read off the screen
 * (desktop/src-tauri/src/read): lines of text with each word's box, and the
 * other apps' windows. Pure geometry, so it is unit-tested; the overlay draws
 * it (content/select-screen.ts).
 *
 * The app reads the screen on the computer itself (Vision on macOS,
 * Windows.Media.Ocr on Windows) rather than asking for accessibility access,
 * which would let it read and control every other app: Screen Recording,
 * which any screenshot needs, stays the only permission.
 */
import type { Point, Rect } from '@shared/payload';

export interface ScreenWord {
  text: string;
  rect: Rect;
}

export interface ScreenLine {
  text: string;
  rect: Rect;
  words: ScreenWord[];
  /** 0 to 1 (1 where the system gives none). */
  confidence: number;
}

/** Another app's window, in the overlay's CSS pixels, front to back. */
export interface ScreenWindow {
  app: string;
  title: string;
  rect: Rect;
}

export interface ScreenRead {
  lines: ScreenLine[];
  windows: ScreenWindow[];
}

/** Reads the screen under the overlay. The app has one; the extension reads the page's DOM instead. */
export type ScreenReader = () => Promise<ScreenRead>;

export interface LayoutLine extends ScreenLine {
  /** Which paragraph it is in (an index into `paragraphs`). */
  para: number;
}

export interface Layout {
  /** In reading order: rows top to bottom, left to right within a row. */
  lines: LayoutLine[];
  paragraphs: Rect[];
  windows: ScreenWindow[];
  viewport: { width: number; height: number };
}

/** A word, by its line (in `Layout.lines`) and its place in that line. */
export interface WordAt {
  line: number;
  word: number;
}

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;

export function unionOf(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map(right)) - x, height: Math.max(...rects.map(bottom)) - y };
}

function pad(r: Rect, dx: number, dy = dx): Rect {
  return { x: r.x - dx, y: r.y - dy, width: r.width + 2 * dx, height: r.height + 2 * dy };
}

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= right(r) && y >= r.y && y <= bottom(r);
}

/** Distance from a point to a rect (0 inside). */
function distance(r: Rect, x: number, y: number): number {
  const dx = Math.max(r.x - x, 0, x - right(r));
  const dy = Math.max(r.y - y, 0, y - bottom(r));
  return Math.hypot(dx, dy);
}

/**
 * Two lines (`a` above `b`) belong to one paragraph when they are about the
 * same size, close together (less than about a line apart) and in the same
 * column: overlapping, and either starting near each other or mostly over
 * one another.
 */
export function sameParagraph(a: Rect, b: Rect): boolean {
  const ha = a.height;
  const hb = b.height;
  if (Math.max(ha, hb) / Math.max(1, Math.min(ha, hb)) > 1.6) return false;
  const gap = b.y - bottom(a);
  if (gap < -0.5 * Math.min(ha, hb) || gap > 0.9 * Math.max(ha, hb)) return false;
  const overlap = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
  if (overlap <= 0) return false;
  return Math.abs(a.x - b.x) <= 2.5 * Math.max(ha, hb) || overlap >= 0.6 * Math.min(a.width, b.width);
}

/** Lines in reading order: grouped into rows by their middles, each row left to right. */
export function readingOrder(lines: ScreenLine[]): ScreenLine[] {
  const byTop = [...lines].sort((a, b) => a.rect.y - b.rect.y);
  const rows: ScreenLine[][] = [];
  for (const line of byTop) {
    const middle = line.rect.y + line.rect.height / 2;
    const row = rows[rows.length - 1];
    const first = row?.[0];
    if (first && middle >= first.rect.y && middle <= bottom(first.rect)) row.push(line);
    else rows.push([line]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.rect.x - b.rect.x));
}

export function layoutOf(read: ScreenRead, viewport: { width: number; height: number }): Layout {
  const usable = read.lines
    .map((l) => ({ ...l, words: [...l.words].filter((w) => w.text.trim()).sort((a, b) => a.rect.x - b.rect.x) }))
    .filter((l) => l.words.length > 0 && l.rect.width > 0 && l.rect.height > 0);
  const ordered = readingOrder(usable);

  // Paragraphs: union-find over neighbouring lines.
  const parent = ordered.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      const a = ordered[i]!.rect;
      const b = ordered[j]!.rect;
      if (i !== j && b.y > a.y + a.height / 2 && sameParagraph(a, b)) parent[find(j)] = find(i);
    }
  }
  const ids = new Map<number, number>();
  const members: Rect[][] = [];
  const lines: LayoutLine[] = ordered.map((l, i) => {
    const root = find(i);
    if (!ids.has(root)) {
      ids.set(root, members.length);
      members.push([]);
    }
    const para = ids.get(root)!;
    members[para]!.push(l.rect);
    return { ...l, para };
  });
  return { lines, paragraphs: members.map(unionOf), windows: read.windows, viewport };
}

/** The line under a point, allowing a little room around it; null over no text. */
export function lineAt(layout: Layout, x: number, y: number): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  layout.lines.forEach((l, i) => {
    const h = l.rect.height;
    if (!contains(pad(l.rect, h * 0.5, h * 0.35), x, y)) return;
    const d = Math.abs(y - (l.rect.y + h / 2));
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

/**
 * The word nearest a point: in the line under it, or the nearest line when
 * `reach` allows (in line heights; Infinity while dragging, so the selection
 * follows the pointer anywhere). Null when there is no text that near.
 */
export function wordNear(layout: Layout, x: number, y: number, reach = 1.5): WordAt | null {
  let line = lineAt(layout, x, y);
  if (line === null) {
    let bestDistance = Infinity;
    layout.lines.forEach((l, i) => {
      const d = distance(l.rect, x, y);
      if (d <= reach * l.rect.height && d < bestDistance) {
        line = i;
        bestDistance = d;
      }
    });
  }
  if (line === null) return null;
  const words = layout.lines[line]!.words;
  let word = 0;
  let bestDistance = Infinity;
  words.forEach((w, i) => {
    const d = x < w.rect.x ? w.rect.x - x : x > right(w.rect) ? x - right(w.rect) : 0;
    if (d < bestDistance) {
      word = i;
      bestDistance = d;
    }
  });
  return { line, word };
}

const before = (a: WordAt, b: WordAt) => a.line < b.line || (a.line === b.line && a.word <= b.word);

/**
 * The words from one to another, as a text selection runs: the rest of the
 * first line, the lines between, the start of the last. Lines beside them in
 * another column (not over the first and last lines' span) are left out.
 */
export function wordsBetween(layout: Layout, a: WordAt, b: WordAt): WordAt[] {
  const [s, e] = before(a, b) ? [a, b] : [b, a];
  const out: WordAt[] = [];
  if (s.line === e.line) {
    for (let w = s.word; w <= e.word; w++) out.push({ line: s.line, word: w });
    return out;
  }
  const first = layout.lines[s.line]!;
  const last = layout.lines[e.line]!;
  const left = Math.min(first.rect.x, last.rect.x);
  const span = Math.max(right(first.rect), right(last.rect));
  for (let w = s.word; w < first.words.length; w++) out.push({ line: s.line, word: w });
  for (let i = s.line + 1; i < e.line; i++) {
    const l = layout.lines[i]!;
    const overlap = Math.min(right(l.rect), span) - Math.max(l.rect.x, left);
    if (overlap < 0.3 * l.rect.width) continue;
    for (let w = 0; w < l.words.length; w++) out.push({ line: i, word: w });
  }
  for (let w = 0; w <= e.word; w++) out.push({ line: e.line, word: w });
  return out;
}

/** Selected words, grouped by line, in order. */
function byLine(words: WordAt[]): Map<number, number[]> {
  const lines = new Map<number, number[]>();
  for (const w of words) lines.set(w.line, [...(lines.get(w.line) ?? []), w.word]);
  return lines;
}

/** The selected text: words by spaces, lines of a paragraph by spaces, paragraphs by blank lines. */
export function textOf(layout: Layout, words: WordAt[]): string {
  let text = '';
  let para = -1;
  for (const [line, idx] of byLine(words)) {
    const l = layout.lines[line]!;
    const part = idx.map((w) => l.words[w]!.text).join(' ');
    text += para === -1 ? part : l.para === para ? ` ${part}` : `\n\n${part}`;
    para = l.para;
  }
  return text;
}

/** The lowest confidence among the selected lines. */
export function confidenceOf(layout: Layout, words: WordAt[]): number {
  return Math.min(1, ...[...byLine(words).keys()].map((i) => layout.lines[i]!.confidence));
}

/**
 * One box per selected line, from its first selected word to its last. Lines
 * next to each other meet halfway, so the highlight reads as one block and
 * the outline (outlinesOf) has no seams.
 */
export function highlightRects(layout: Layout, words: WordAt[]): Rect[] {
  const rects = [...byLine(words)].map(([line, idx]) => {
    const l = layout.lines[line]!;
    const ws = idx.map((w) => l.words[w]!.rect);
    const x = Math.min(...ws.map((r) => r.x));
    const padX = Math.max(1, l.rect.height * 0.12);
    const padY = Math.max(1, l.rect.height * 0.18);
    return pad({ x, y: l.rect.y, width: Math.max(...ws.map(right)) - x, height: l.rect.height }, padX, padY);
  });
  for (let i = 0; i + 1 < rects.length; i++) {
    const a = rects[i]!;
    const b = rects[i + 1]!;
    const gap = b.y - bottom(a);
    if (gap > -a.height && gap < a.height) {
      const middle = bottom(a) + gap / 2;
      a.height = middle - a.y;
      b.height = bottom(b) - middle;
      b.y = middle;
    }
  }
  return rects;
}

/**
 * Outlines around highlight boxes: boxes that meet and overlap sideways
 * become one staircase polygon (down the right side, back up the left).
 */
export function outlinesOf(rects: Rect[]): Point[][] {
  const groups: Rect[][] = [];
  for (const r of rects) {
    const group = groups[groups.length - 1];
    const prev = group?.[group.length - 1];
    const meets = prev && Math.abs(bottom(prev) - r.y) < 0.5 && Math.min(right(prev), right(r)) > Math.max(prev.x, r.x);
    if (meets) group!.push(r);
    else groups.push([r]);
  }
  return groups.map((g) => [
    ...g.flatMap((r) => [
      { x: right(r), y: r.y },
      { x: right(r), y: bottom(r) },
    ]),
    ...[...g].reverse().flatMap((r) => [
      { x: r.x, y: bottom(r) },
      { x: r.x, y: r.y },
    ]),
  ]);
}

/**
 * Whether the text read off the screen may not say exactly what is on it, so
 * the picture should go along: the system was unsure, or it looks like
 * mathematics, where a lost superscript changes the question (x² read as x2).
 */
export function needsPicture(text: string, confidence: number): boolean {
  if (confidence < 0.75) return true;
  return /[=+±×÷^√∫∑∏πθλμσΣΔ≤≥≠≈∞]|\d\s*\/\s*\d|\b[a-zA-Z]\d\b|\b\d+[a-zA-Z]\b|\b[a-zA-Z]\(\s*[a-zA-Z0-9]/.test(text);
}

/** What Element can pick under a point, smallest first: a line, its paragraph, the window, the screen. */
export interface Target {
  kind: 'line' | 'paragraph' | 'window' | 'screen';
  rect: Rect;
  label: string;
  window?: ScreenWindow;
}

export function targetsAt(layout: Layout, x: number, y: number): Target[] {
  const out: Target[] = [];
  const line = lineAt(layout, x, y);
  const l = line === null ? null : layout.lines[line]!;
  const para = l ? layout.paragraphs[l.para]! : layout.paragraphs.find((p) => contains(pad(p, 8), x, y));
  const window = windowAt(layout, x, y);
  if (l && para && layout.lines.filter((o) => o.para === l.para).length > 1) out.push({ kind: 'line', rect: pad(l.rect, 4, 3), label: 'Line', window });
  if (para) out.push({ kind: 'paragraph', rect: pad(para, 6), label: 'Paragraph', window });
  if (window) out.push({ kind: 'window', rect: window.rect, label: window.app ? `Window · ${window.app}` : 'Window', window });
  out.push({ kind: 'screen', rect: { x: 0, y: 0, ...layout.viewport }, label: 'Screen' });
  return out.map((t) => ({ ...t, rect: clampTo(t.rect, layout.viewport) }));
}

function clampTo(r: Rect, v: { width: number; height: number }): Rect {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return { x, y, width: Math.min(v.width, right(r)) - x, height: Math.min(v.height, bottom(r)) - y };
}

/** The frontmost window at a point. */
export function windowAt(layout: Layout, x: number, y: number): ScreenWindow | undefined {
  return layout.windows.find((w) => contains(w.rect, x, y));
}

/**
 * A selection's title in the app: the window it was made over, and the app,
 * unless the window's title already names it ("Chapter 3.pdf · Preview",
 * "Lab report - Word").
 */
export function windowTitle(source: { app: string; title: string }): string {
  const app = source.app.trim();
  const title = source.title.replace(/\s+/g, ' ').trim();
  if (!title) return app;
  if (!app || title.toLowerCase().includes(app.toLowerCase())) return title;
  return `${title} · ${app}`;
}
