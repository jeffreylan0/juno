/**
 * Scrolling while a selection is armed.
 *
 * The drag surface covers the viewport, so the wheel never reaches the page
 * underneath and nothing moves. Forwarding to `window` is not enough either:
 * in the PDF reader the thing that scrolls is a container, not the document,
 * and plenty of sites scroll an inner pane. So the wheel is handed to whatever
 * is actually scrollable under the pointer.
 */

/** Elements that belong to us and must be ignored when hit-testing the page. */
export const UI_ATTR = 'data-sai-ui';

export function isScrollable(el: Element): boolean {
  const style = getComputedStyle(el);
  const canY = /auto|scroll|overlay/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
  const canX = /auto|scroll|overlay/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
  return canY || canX;
}

/**
 * The nearest scrollable ancestor of the point, falling back to the document.
 * `hidden` is hidden for the hit test so our own overlay is never the answer.
 */
export function scrollTargetAt(x: number, y: number, hidden: HTMLElement | null, doc: Document = document): Element {
  const previous = hidden?.style.display ?? null;
  if (hidden) hidden.style.display = 'none';
  let node: Element | null = null;
  try {
    node = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(x, y) : null;
  } catch {
    node = null;
  } finally {
    if (hidden && previous !== null) hidden.style.display = previous;
  }
  while (node) {
    if (isScrollable(node)) return node;
    node = node.parentElement;
  }
  return doc.scrollingElement ?? doc.documentElement;
}

/** Applies one wheel event to `target`, matching the browser's own behaviour. */
export function applyWheel(target: Element, event: WheelEvent): void {
  // DOM_DELTA_LINE and _PAGE come through on some mice and trackpads.
  const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.clientHeight : 1;
  target.scrollBy({ left: event.deltaX * lines, top: event.deltaY * lines, behavior: 'instant' as ScrollBehavior });
}
