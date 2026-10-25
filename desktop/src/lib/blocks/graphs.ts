/**
 * Graphs in answers, drawn as SVG from a block's JSON:
 *
 *   ```plot  {"fns":[{"f":"x^2-1","label":"f"}],"x":[-3,3],"y":[-2,8],"points":[[1,0,"root"]]}
 *   ```chart {"type":"bar|line|scatter|pie","labels":[…],"series":[{"name":"…","values":[…]}],"x":"…","y":"…"}
 *
 * Thin marks on recessive axes: 2px lines, bars rounded at their value end,
 * a key for two series or more, and each value on hover (a plot reads off
 * every curve at the pointer). Curves are sampled where they are defined
 * and lifted where they leave the view (an asymptote is not a line).
 */
import { compile } from './expr';
import { SERIES, figure, fmt, label, legend, list, niceRange, note, num, obj, str, svg, ticks } from './dom';

const W = 360;
const H = 220;
const SAMPLES = 360;

interface Frame {
  root: SVGSVGElement;
  /** The data area: it clips what leaves it. */
  area: SVGSVGElement;
  sx: (v: number) => number;
  sy: (v: number) => number;
  /** The data area's size. */
  pw: number;
  ph: number;
  ml: number;
  mt: number;
}

/**
 * Axes for x from `xr` and y from `yr`: grid lines at round values (or the
 * categories' own ticks), the axes through 0 where 0 is in view, titles if
 * named.
 */
function frame(
  xr: [number, number],
  yr: [number, number],
  opts: { xTicks?: { at: number; text: string }[]; xTitle?: string; yTitle?: string; xGrid?: boolean; summary: string },
): Frame {
  const ml = 40 + (opts.yTitle ? 14 : 0);
  const mb = 22 + (opts.xTitle ? 14 : 0);
  const mt = 8;
  const mr = 12;
  const pw = W - ml - mr;
  const ph = H - mt - mb;
  const sx = (v: number) => ((v - xr[0]) / (xr[1] - xr[0])) * pw;
  const sy = (v: number) => ph - ((v - yr[0]) / (yr[1] - yr[0])) * ph;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'jb-svg', role: 'img', 'aria-label': opts.summary });
  const axes = svg('g', { transform: `translate(${ml} ${mt})` }, root);

  for (const t of ticks(yr[0], yr[1])) {
    svg('line', { x1: 0, x2: pw, y1: sy(t), y2: sy(t), class: t === 0 ? 'jb-axis' : 'jb-grid' }, axes);
    label(axes, -6, sy(t) + 3.5, fmt(t), 'jb-tick', 'end');
  }
  const xTicks = opts.xTicks ?? ticks(xr[0], xr[1], 6).map((at) => ({ at, text: fmt(at) }));
  // As many labels as fit; the rest keep their grid line.
  const room = Math.max(...xTicks.map((t) => t.text.length), 1) * 6 + 6;
  const every = Math.max(1, Math.ceil((xTicks.length * room) / pw));
  xTicks.forEach((t, i) => {
    if (opts.xGrid) svg('line', { x1: sx(t.at), x2: sx(t.at), y1: 0, y2: ph, class: t.at === 0 ? 'jb-axis' : 'jb-grid' }, axes);
    if (i % every === 0) label(axes, sx(t.at), ph + 14, t.text, 'jb-tick');
  });
  if (opts.xTitle) label(axes, pw / 2, ph + 30, opts.xTitle, 'jb-axis-title');
  if (opts.yTitle) svg('text', { transform: `translate(${-ml + 11} ${ph / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'jb-axis-title' }, axes).textContent = opts.yTitle;

  const area = svg('svg', { x: ml, y: mt, width: pw, height: ph, viewBox: `0 0 ${pw} ${ph}`, overflow: 'hidden' }, root);
  return { root, area, sx, sy, pw, ph, ml, mt };
}

/** A ```plot block: curves of y = f(x), with points marked. */
export function plotBlock(spec: unknown): HTMLElement {
  const s = obj(spec);
  const fns = list(s.fns ?? s.functions, SERIES)
    .map((raw, i) => {
      const f = obj(typeof raw === 'string' ? { f: raw } : raw);
      const src = str(f.f ?? f.expr, 200);
      return { fn: compile(src), name: str(f.label) || `y = ${src}`, i };
    })
    .filter((f): f is { fn: (x: number) => number; name: string; i: number } => !!f.fn);
  const points = list(s.points, 40)
    .map((p) => list(p, 3))
    .map(([x, y, text]) => ({ x: num(x), y: num(y), text: str(text, 30) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!fns.length && !points.length) throw new Error('nothing to plot');

  const [x0, x1] = list(s.x, 2).map(num);
  const xr: [number, number] = Number.isFinite(x0) && Number.isFinite(x1) && x1! > x0! ? [x0!, x1!] : [-10, 10];
  const xs = Array.from({ length: SAMPLES + 1 }, (_, k) => xr[0] + ((xr[1] - xr[0]) * k) / SAMPLES);
  const curves = fns.map((f) => xs.map((x) => f.fn(x)));

  const [y0, y1] = list(s.y, 2).map(num);
  let yr: [number, number];
  if (Number.isFinite(y0) && Number.isFinite(y1) && y1! > y0!) yr = [y0!, y1!];
  else {
    // From what the curves mostly do: a spike towards an asymptote doesn't flatten the rest.
    const seen = [...curves.flat(), ...points.map((p) => p.y)].filter(Number.isFinite).sort((a, b) => a - b);
    const lo = seen[Math.floor(seen.length * 0.02)] ?? -1;
    const hi = seen[Math.ceil(seen.length * 0.98) - 1] ?? 1;
    const pad = (hi - lo) * 0.08 || 1;
    yr = niceRange(lo - pad, hi + pad);
  }

  const title = str(s.title, 80);
  const fig = figure('plot', title);
  if (fns.length > 1) fig.append(legend(fns.map((f) => f.name)));
  const fr = frame(xr, yr, { xGrid: true, xTitle: str(s.xlabel), yTitle: str(s.ylabel), summary: title || `Graph of ${fns.map((f) => f.name).join(', ')}` });
  const span = yr[1] - yr[0];

  curves.forEach((ys, c) => {
    let d = '';
    let pen = false;
    ys.forEach((y, k) => {
      // Off the chart by more than its height, or undefined: the pen lifts.
      if (!Number.isFinite(y) || y < yr[0] - span || y > yr[1] + span) return void (pen = false);
      d += `${pen ? 'L' : 'M'}${fr.sx(xs[k]!).toFixed(1)} ${fr.sy(y).toFixed(1)}`;
      pen = true;
    });
    const path = svg('path', { d, class: `jb-line jb-s${fns[c]!.i}` }, fr.area);
    note(path, fns[c]!.name);
  });
  for (const p of points) {
    const dot = svg('circle', { cx: fr.sx(p.x), cy: fr.sy(p.y), r: 4, class: 'jb-dot' }, fr.area);
    note(dot, `${p.text ? `${p.text}: ` : ''}(${fmt(p.x)}, ${fmt(p.y)})`);
    if (p.text) label(fr.area, fr.sx(p.x) + 7, fr.sy(p.y) - 7, p.text, 'jb-point-label', 'start');
  }
  if (fns.length) readout(fr, xr, fns);
  fig.append(fr.root);
  return fig;
}

/** Where the pointer is, each curve's value there: a line, a dot on each curve and the numbers. */
function readout(fr: Frame, xr: [number, number], fns: { fn: (x: number) => number; name: string; i: number }[]): void {
  const g = svg('g', { class: 'jb-readout', visibility: 'hidden' }, fr.area);
  const line = svg('line', { y1: 0, y2: fr.ph, class: 'jb-cross' }, g);
  const dots = fns.map((f) => svg('circle', { r: 4, class: `jb-dot jb-s${f.i}` }, g));
  const text = label(g, 6, 13, '', 'jb-readout-text', 'start');
  fr.root.addEventListener('pointermove', (e) => {
    const box = fr.root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W - fr.ml;
    if (px < 0 || px > fr.pw) return void g.setAttribute('visibility', 'hidden');
    const x = xr[0] + (px / fr.pw) * (xr[1] - xr[0]);
    line.setAttribute('x1', String(px));
    line.setAttribute('x2', String(px));
    const values = fns.map((f, k) => {
      const y = f.fn(x);
      dots[k]!.setAttribute('cx', String(px));
      dots[k]!.setAttribute('cy', String(Number.isFinite(y) ? fr.sy(y) : -99));
      return fns.length > 1 ? `${f.name}: ${fmt(y)}` : `y = ${fmt(y)}`;
    });
    text.textContent = `x = ${fmt(x)}   ${values.join('   ')}`;
    g.setAttribute('visibility', 'visible');
  });
  fr.root.addEventListener('pointerleave', () => g.setAttribute('visibility', 'hidden'));
}

/** A ```chart block: bar, line, scatter or pie. */
export function chartBlock(spec: unknown): HTMLElement {
  const s = obj(spec);
  const type = ['bar', 'line', 'scatter', 'pie'].includes(String(s.type)) ? String(s.type) : 'bar';
  const title = str(s.title, 80);
  const fig = figure('chart', title);
  const series = list(s.series, SERIES).map((raw, i) => {
    const o = obj(Array.isArray(raw) ? { values: raw } : raw);
    return { name: str(o.name) || `Series ${i + 1}`, values: list(o.values, type === 'scatter' ? 300 : 60), i };
  });
  if (!series.length) throw new Error('no data');
  if (type === 'pie') return pie(fig, list(s.labels, 60).map((l) => str(l, 40)), series[0]!.values.map(num), title);
  if (series.length > 1) fig.append(legend(series.map((x) => x.name)));
  const xTitle = str(s.x ?? s.xlabel);
  const yTitle = str(s.y ?? s.ylabel);

  if (type === 'scatter') {
    const pts = series.map((x) => x.values.map((p) => list(p, 2).map(num)).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)) as [number, number][]);
    const all = pts.flat();
    if (!all.length) throw new Error('no points');
    const xr = niceRange(Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0])));
    const yr = niceRange(Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1])));
    const fr = frame(xr, yr, { xGrid: true, xTitle, yTitle, summary: title || 'Scatter chart' });
    pts.forEach((ps, k) =>
      ps.forEach(([x, y]) => note(svg('circle', { cx: fr.sx(x), cy: fr.sy(y), r: 4, class: `jb-dot jb-fill jb-s${k}` }, fr.area), `${series[k]!.name}: (${fmt(x)}, ${fmt(y)})`)),
    );
    fig.append(fr.root);
    return fig;
  }

  const values = series.map((x) => x.values.map(num));
  const n = Math.max(...values.map((v) => v.length));
  const labels = Array.from({ length: n }, (_, k) => str(list(s.labels, 60)[k], 14) || String(k + 1));
  const finite = values.flat().filter(Number.isFinite);
  if (!finite.length) throw new Error('no values');
  // Bars stand on 0; a line shows how values move, so it spans what they do.
  const yr = type === 'bar' ? niceRange(Math.min(0, ...finite), Math.max(0, ...finite)) : niceRange(Math.min(...finite), Math.max(...finite));
  // Categories are bands; a line runs through their middles.
  const fr = frame([0, n], yr, { xTicks: labels.map((text, k) => ({ at: k + 0.5, text })), xTitle, yTitle, summary: title || `${type === 'bar' ? 'Bar' : 'Line'} chart` });

  if (type === 'line') {
    values.forEach((vs, k) => {
      const d = vs.map((v, j) => (Number.isFinite(v) ? `${j && Number.isFinite(vs[j - 1]!) ? 'L' : 'M'}${fr.sx(j + 0.5).toFixed(1)} ${fr.sy(v).toFixed(1)}` : '')).join('');
      svg('path', { d, class: `jb-line jb-s${k}` }, fr.area);
      vs.forEach((v, j) => {
        if (!Number.isFinite(v)) return;
        const dot = svg('circle', { cx: fr.sx(j + 0.5), cy: fr.sy(v), r: n <= 24 ? 4 : 0, class: `jb-dot jb-fill jb-s${k}` }, fr.area);
        note(dot, `${labels[j]}${series.length > 1 ? ` · ${series[k]!.name}` : ''}: ${fmt(v)}`);
      });
    });
  } else {
    const band = fr.pw / n;
    const group = band * 0.72;
    const w = Math.max(1, (group - 2 * (values.length - 1)) / values.length);
    const base = fr.sy(Math.max(yr[0], Math.min(0, yr[1])));
    values.forEach((vs, k) =>
      vs.forEach((v, j) => {
        if (!Number.isFinite(v)) return;
        const x = j * band + (band - group) / 2 + k * (w + 2);
        const bar = svg('path', { d: barPath(x, w, base, fr.sy(v)), class: `jb-bar jb-s${k}` }, fr.area);
        note(bar, `${labels[j]}${series.length > 1 ? ` · ${series[k]!.name}` : ''}: ${fmt(v)}`);
      }),
    );
  }
  fig.append(fr.root);
  return fig;
}

/** A bar from the baseline to its value, rounded (4px) at the value end only. */
function barPath(x: number, w: number, base: number, end: number): string {
  const up = end < base ? 1 : -1;
  const r = Math.min(4, w / 2, Math.abs(base - end));
  return `M${x} ${base}V${end + up * r}Q${x} ${end} ${x + r} ${end}H${x + w - r}Q${x + w} ${end} ${x + w} ${end + up * r}V${base}Z`;
}

/** Shares of one whole: six slices at most, the smallest folded into Other, each named with its share. */
function pie(fig: HTMLElement, labels: string[], raw: number[], title: string): HTMLElement {
  let slices = raw.map((v, k) => ({ v, name: labels[k] || `Part ${k + 1}` })).filter((x) => Number.isFinite(x.v) && x.v > 0);
  if (slices.length > SERIES) {
    const sorted = [...slices].sort((a, b) => b.v - a.v);
    const rest = sorted.slice(SERIES - 1).reduce((t, x) => t + x.v, 0);
    slices = [...sorted.slice(0, SERIES - 1), { v: rest, name: 'Other' }];
  }
  const total = slices.reduce((t, x) => t + x.v, 0);
  if (!total) throw new Error('nothing to share');
  const pct = (v: number) => `${fmt(Math.round((v / total) * 1000) / 10)}%`;
  fig.append(legend(slices.map((x) => `${x.name} ${pct(x.v)}`)));
  const root = svg('svg', { viewBox: '0 0 220 220', class: 'jb-svg jb-pie-svg', role: 'img', 'aria-label': title || 'Pie chart' });
  let a = -Math.PI / 2;
  slices.forEach((x, k) => {
    const sweep = (x.v / total) * Math.PI * 2;
    const mark =
      slices.length === 1
        ? svg('circle', { cx: 110, cy: 110, r: 100, class: `jb-slice jb-s${k}` }, root)
        : svg('path', { d: arc(110, 110, 100, a, a + sweep), class: `jb-slice jb-s${k}` }, root);
    note(mark, `${x.name}: ${fmt(x.v)} (${pct(x.v)})`);
    a += sweep;
  });
  fig.append(root);
  return fig;
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  return `M${cx} ${cy}L${p(a0)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}Z`;
}

