/**
 * Diagrams in answers: a ```diagram block's nodes and arrows, laid out in
 * layers (down the page, or across with "dir":"right") and drawn as SVG.
 *
 *   ```diagram {"dir":"down","nodes":[{"id":"a","label":"Light"}],"edges":[{"from":"a","to":"b","label":"absorbed"}]}
 *
 * Each node sits a layer below everything that points to it (an arrow back
 * up, closing a cycle, is drawn but doesn't count), nodes in a layer are
 * ordered to keep arrows from crossing, and labels wrap inside their boxes.
 * Wider than the panel, it scrolls rather than shrinking past legibility.
 */
import { figure, h, label, list, note, obj, str, svg } from './dom';

const GAP = 18;
const LAYER_GAP = 44;
const CHAR = 6.6;
const LINE = 15;

interface Box {
  id: string;
  lines: string[];
  w: number;
  h: number;
  layer: number;
  x: number;
  y: number;
}

export function diagramBlock(spec: unknown): HTMLElement {
  const s = obj(spec);
  const across = /^(right|lr|across|horizontal)$/i.test(str(s.dir ?? s.direction));
  const boxes: Box[] = [];
  const index = new Map<string, number>();
  const add = (id: string, text: string) => {
    if (!id || index.has(id) || boxes.length >= 40) return;
    index.set(id, boxes.length);
    const lines = wrap(text || id);
    boxes.push({ id, lines, w: Math.max(56, Math.max(...lines.map((l) => l.length)) * CHAR + 22), h: lines.length * LINE + 14, layer: 0, x: 0, y: 0 });
  };
  for (const raw of list(s.nodes, 40)) {
    const o = obj(typeof raw === 'string' ? { id: raw } : raw);
    add(str(o.id, 40) || str(o.label, 40), str(o.label ?? o.id, 80));
  }
  const edges = list(s.edges, 80)
    .map((raw) => {
      const o = obj(Array.isArray(raw) ? { from: raw[0], to: raw[1], label: raw[2] } : raw);
      const [from, to] = [str(o.from, 40), str(o.to, 40)];
      // An arrow to a node not listed brings the node.
      add(from, from);
      add(to, to);
      return { a: index.get(from)!, b: index.get(to)!, text: str(o.label, 30), back: false };
    })
    .filter((e) => e.a !== undefined && e.b !== undefined && e.a !== e.b);
  if (!boxes.length) throw new Error('no nodes');

  // Arrows that close a cycle (found by walking from each node in turn) don't set layers.
  const state = boxes.map(() => 0);
  const visit = (u: number) => {
    state[u] = 1;
    for (const e of edges) {
      if (e.a !== u) continue;
      if (state[e.b] === 1) e.back = true;
      else if (state[e.b] === 0) visit(e.b);
    }
    state[u] = 2;
  };
  boxes.forEach((_, u) => state[u] || visit(u));
  const forward = edges.filter((e) => !e.back);
  for (let pass = 0; pass < boxes.length; pass++) {
    let moved = false;
    for (const e of forward) {
      if (boxes[e.b]!.layer <= boxes[e.a]!.layer) {
        boxes[e.b]!.layer = boxes[e.a]!.layer + 1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const layers: number[][] = [];
  boxes.forEach((b, i) => (layers[b.layer] ??= []).push(i));

  // Twice down and up: each node moves toward the middle of what it connects to.
  const rank = new Map<number, number>();
  const rerank = () => layers.forEach((l) => l.forEach((n, k) => rank.set(n, k)));
  rerank();
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers.keys() : [...layers.keys()].reverse();
    for (const li of order) {
      const pull = (n: number) => {
        const near = forward.filter((e) => (down ? e.b === n : e.a === n)).map((e) => rank.get(down ? e.a : e.b)!);
        return near.length ? near.reduce((t, r) => t + r, 0) / near.length : rank.get(n)!;
      };
      layers[li]!.sort((p, q) => pull(p) - pull(q));
      rerank();
    }
  }

  // Layers along the flow, nodes side by side across it, each layer centred.
  const along = (b: Box) => (across ? b.w : b.h);
  const side = (b: Box) => (across ? b.h : b.w);
  const gap = LAYER_GAP + (edges.some((e) => e.text) && across ? 40 : 0);
  const breadth = Math.max(...layers.map((l) => l.reduce((t, n) => t + side(boxes[n]!), 0) + GAP * (l.length - 1)));
  let at = 0;
  for (const l of layers) {
    const depth = Math.max(...l.map((n) => along(boxes[n]!)));
    let cross = (breadth - (l.reduce((t, n) => t + side(boxes[n]!), 0) + GAP * (l.length - 1))) / 2;
    for (const n of l) {
      const b = boxes[n]!;
      const off = at + (depth - along(b)) / 2;
      if (across) [b.x, b.y] = [off, cross];
      else [b.x, b.y] = [cross, off];
      cross += side(b) + GAP;
    }
    at += depth + gap;
  }
  // Room beside the layers for arrows back around the outside.
  const pad = 8;
  const width = (across ? at - gap : breadth + 40) + pad * 2;
  const height = (across ? breadth + 40 : at - gap) + pad * 2;

  const title = str(s.title, 80);
  const fig = figure('diagram', title);
  const root = svg('svg', { viewBox: `${-pad} ${-pad} ${width} ${height}`, class: 'jb-svg', role: 'img', 'aria-label': title || 'Diagram' });
  root.style.width = `${width}px`;
  root.style.minWidth = `${Math.round(width * 0.75)}px`;
  const lines = svg('g', {}, root);
  const marks = svg('g', {}, root);

  for (const e of edges) {
    const [p, q] = [boxes[e.a]!, boxes[e.b]!];
    let from: [number, number];
    let to: [number, number];
    let c1: [number, number];
    let c2: [number, number];
    if (q.layer > p.layer) {
      // Out of one side, into the next layer's.
      from = across ? [p.x + p.w, p.y + p.h / 2] : [p.x + p.w / 2, p.y + p.h];
      to = across ? [q.x, q.y + q.h / 2] : [q.x + q.w / 2, q.y];
      const mid = across ? (to[0] - from[0]) / 2 : (to[1] - from[1]) / 2;
      c1 = across ? [from[0] + mid, from[1]] : [from[0], from[1] + mid];
      c2 = across ? [to[0] - mid, to[1]] : [to[0], to[1] - mid];
    } else {
      // Back up (a cycle) or within a layer: around the outside.
      from = across ? [p.x + p.w / 2, p.y + p.h] : [p.x + p.w, p.y + p.h / 2];
      to = across ? [q.x + q.w / 2, q.y + q.h] : [q.x + q.w, q.y + q.h / 2];
      c1 = across ? [from[0], from[1] + 40] : [from[0] + 40, from[1]];
      c2 = across ? [to[0], to[1] + 40] : [to[0] + 40, to[1]];
    }
    const path = svg('path', { d: `M${from}C${c1} ${c2} ${to}`, class: 'jb-edge' }, lines);
    note(path, `${p.lines.join(' ')} → ${q.lines.join(' ')}${e.text ? ` (${e.text})` : ''}`);
    // The arrowhead, along the curve's last stretch.
    const [dx, dy] = [to[0] - c2[0], to[1] - c2[1]];
    const len = Math.hypot(dx, dy) || 1;
    const [ux, uy] = [dx / len, dy / len];
    const tip = `${to}`;
    const back = (k: number) => `${to[0] - ux * 8 + uy * k},${to[1] - uy * 8 - ux * k}`;
    svg('path', { d: `M${tip}L${back(4)}L${back(-4)}Z`, class: 'jb-arrow' }, lines);
    if (e.text) {
      const mx = (from[0] + 3 * c1[0] + 3 * c2[0] + to[0]) / 8;
      const my = (from[1] + 3 * c1[1] + 3 * c2[1] + to[1]) / 8;
      const w = e.text.length * 6 + 8;
      svg('rect', { x: mx - w / 2, y: my - 8, width: w, height: 16, rx: 4, class: 'jb-edge-label-bg' }, marks);
      label(marks, mx, my + 4, e.text, 'jb-edge-label');
    }
  }
  for (const b of boxes) {
    const g = svg('g', {}, marks);
    svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, class: 'jb-node' }, g);
    b.lines.forEach((line, k) => label(g, b.x + b.w / 2, b.y + 7 + LINE * (k + 1) - 3.5, line, 'jb-node-label'));
  }

  const scroll = h('div', 'jb-scroll');
  scroll.append(root);
  fig.append(scroll);
  return fig;
}

/** A label in lines of about 18 characters, three at most. */
function wrap(text: string, max = 18, most = 3): string[] {
  const out: string[] = [];
  for (const word of text.split(' ')) {
    const last = out.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= max) out[out.length - 1] = `${last} ${word}`;
    else out.push(word.length > max ? `${word.slice(0, max - 1)}…` : word);
  }
  if (out.length > most) out.splice(most - 1, out.length, `${out[most - 1]!.slice(0, max - 1)}…`);
  return out;
}
