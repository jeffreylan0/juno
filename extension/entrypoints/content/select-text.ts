/**
 * Reads the current text range. Week 3 widens it to whole KaTeX or MathJax
 * expressions so half an integral never reaches the model; for now it returns
 * the plain text, the cloned HTML and the bounding rect.
 */
import type { Rect } from '@shared/payload';

export interface TextSelection {
  rect: Rect;
  text: string;
  html: string;
}

/** Current text selection, or null when there is none. */
export function readSelection(doc: Document = document): TextSelection | null {
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const text = sel.toString().trim();
  if (!text) return null;
  const r = range.getBoundingClientRect();
  const container = doc.createElement('div');
  container.append(range.cloneContents());
  return { rect: { x: r.left, y: r.top, width: r.width, height: r.height }, text, html: container.innerHTML };
}
