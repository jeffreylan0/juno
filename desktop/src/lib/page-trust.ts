/**
 * The in-page bar and tooltips are drawn into pages whose own scripts can't
 * be trusted. In the extension they live in closed shadow roots the page
 * can't reach into, and ignore any event the page made up (isTrusted false):
 * a page can't pick a mode, draw a selection, switch a chat to or from
 * temporary, or close the bar on the student's behalf.
 *
 * The app's overlay is a window of its own that no page can script, and the
 * end-to-end builds look inside the roots, so there the roots stay open; the
 * app's tests also click through them in script. Build flags: SAI_IN_PAGE
 * (the extension) and SAI_OPEN_SHADOW (its E2E build), in wxt.config.ts.
 */
export const IN_PAGE = import.meta.env.SAI_IN_PAGE === true;
const OPEN_SHADOW = import.meta.env.SAI_OPEN_SHADOW === true;

/** Everything a person does; one made up by the page goes no further than the root. */
const USER_EVENTS = ['click', 'dblclick', 'auxclick', 'contextmenu', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'keydown', 'keyup', 'input', 'change', 'wheel'];

/** Whether an event came from the person rather than the page's scripts. */
export const fromUser = (e: Event): boolean => !IN_PAGE || e.isTrusted;

function dropMadeUp(e: Event): void {
  if (!e.isTrusted) e.stopImmediatePropagation();
}

/** A shadow root for our UI on someone else's page. */
export function privateShadow(host: HTMLElement): ShadowRoot {
  const root = host.attachShadow({ mode: IN_PAGE && !OPEN_SHADOW ? 'closed' : 'open' });
  if (IN_PAGE) for (const type of USER_EVENTS) root.addEventListener(type, dropMadeUp, true);
  return root;
}
