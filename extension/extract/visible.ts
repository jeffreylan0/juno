/**
 * Keeps only visible text inside a selection: real size, on screen, not
 * hidden, and with some contrast against its background. Week-4 scope will
 * add contrast measurement and iframe traversal; this version handles
 * display/visibility/opacity/size and rect intersection.
 */
import type { Rect } from '@shared/payload';

const MIN_FONT_PX = 4;
const MIN_OVERLAP = 0.5;

export function intersectArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Parses a computed length/number, falling back when the property is absent. */
function num(value: string, fallback: number): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

export function isElementVisible(el: Element, win: Window = window): boolean {
  const style = win.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  // An absent property must not read as 0 — that would hide everything.
  if (num(style.opacity, 1) === 0) return false;
  if (num(style.fontSize, 16) < MIN_FONT_PX) return false;
  // White-on-white and similar: same fully opaque colour for text and background.
  if (style.color && style.backgroundColor && style.color === style.backgroundColor && !style.backgroundColor.includes('rgba')) {
    return false;
  }
  return true;
}

/** Text nodes whose rendered boxes overlap `rect` (viewport CSS px), in document order. */
export function textInRect(rect: Rect, doc: Document = document): string {
  const win = doc.defaultView ?? window;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return NodeFilter.FILTER_REJECT;
      if (parent.closest('selection-ai-overlay')) return NodeFilter.FILTER_REJECT;
      if (!(node.textContent ?? '').trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const pieces: string[] = [];
  let lastBlock: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const parent = text.parentElement!;
    if (!isAncestryVisible(parent, win)) continue;
    const range = doc.createRange();
    range.selectNodeContents(text);
    let inside = 0;
    let total = 0;
    for (const r of Array.from(range.getClientRects())) {
      const box = { x: r.left, y: r.top, width: r.width, height: r.height };
      total += box.width * box.height;
      inside += intersectArea(box, rect);
    }
    if (total === 0 || inside / total < MIN_OVERLAP) continue;
    const block = parent.closest('p,div,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,section,article') ?? parent;
    if (lastBlock && block !== lastBlock) pieces.push('\n');
    pieces.push(text.textContent ?? '');
    lastBlock = block;
  }
  return pieces
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const visibilityCache = new WeakMap<Element, boolean>();

function isAncestryVisible(el: Element, win: Window): boolean {
  let node: Element | null = el;
  const chain: Element[] = [];
  while (node && node !== el.ownerDocument.documentElement) {
    const cached = visibilityCache.get(node);
    if (cached !== undefined) {
      if (!cached) return false;
      break;
    }
    chain.push(node);
    if (!isElementVisible(node, win)) {
      chain.forEach((n) => visibilityCache.set(n, false));
      return false;
    }
    node = node.parentElement;
  }
  chain.forEach((n) => visibilityCache.set(n, true));
  return true;
}
