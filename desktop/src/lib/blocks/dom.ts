/**
 * What every drawn block shares: elements made with DOM calls (text always
 * as text), the block's JSON read defensively (each value checked, each list
 * cut short), numbers as people write them, and axis ticks at round values.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** An HTML element, its text set as text. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** An SVG element with these attributes, added to `parent`. */
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent?.append(el);
  return el;
}

/** SVG text, as text. */
export function label(parent: Element, x: number, y: number, text: string, className: string, anchor = 'middle'): SVGTextElement {
  const t = svg('text', { x, y, 'text-anchor': anchor, class: className }, parent);
  t.textContent = text;
  return t;
}

/** A hover note on a mark (the browser's own tooltip). */
export function note(mark: Element, text: string): void {
  svg('title', {}, mark).textContent = text;
}

/** A string from the JSON, one line, at most `max` characters; '' for anything else. */
export function str(v: unknown, max = 60): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const line = String(v).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A finite number from the JSON, or NaN. */
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : NaN);

/** A list from the JSON, at most `max` long; [] for anything else. */
export const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/** An object from the JSON, or an empty one. */
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A number as an axis or a note says it: short, without float noise. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2).replace(/\.?0+e/, 'e');
  return String(Number(v.toPrecision(4)));
}

/** Round values from `lo` to `hi`, about `n` of them. */
export function ticks(lo: number, hi: number, n = 5): number[] {
  const step = niceStep((hi - lo) / n);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9 && out.length < 25; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  }
  return out;
}

export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}

/** A range widened to round values, never empty, with room past its ends (0 stays a baseline). */
export function niceRange(lo: number, hi: number): [number, number] {
  if (!(hi > lo)) [lo, hi] = lo === 0 ? [-1, 1] : [lo - Math.abs(lo) * 0.5, hi + Math.abs(hi) * 0.5];
  const room = (hi - lo) * 0.03;
  if (lo !== 0) lo -= room;
  if (hi !== 0) hi += room;
  const step = niceStep((hi - lo) / 5);
  return [Math.floor(lo / step + 1e-9) * step, Math.ceil(hi / step - 1e-9) * step];
}

/** Series colours: six, in a fixed order (panel.css --series-1…6), never cycled. */
export const SERIES = 6;

/** The key to the colours, for two series or more (one is named by the title). */
export function legend(names: string[]): HTMLElement {
  const box = h('div', 'jb-legend');
  names.forEach((name, i) => {
    const key = h('span', 'jb-key');
    key.append(h('i', `jb-swatch jb-s${i}`), name);
    box.append(key);
  });
  return box;
}

/** The figure a drawing sits in: its title, its key, the drawing. */
export function figure(kind: string, title: string): HTMLElement {
  const fig = h('figure', `jb-figure jb-${kind}`);
  if (title) fig.append(h('figcaption', 'jb-title', title));
  return fig;
}
