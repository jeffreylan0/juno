/**
 * Which parts of the overlay take the pointer, told to the native core
 * (wm.rs polls the pointer against them, since a window that lets clicks
 * through hears nothing of the pointer itself):
 *
 *  - while a selection is armed, drawn or adjusted: all of it;
 *  - while the bar waits: only the bar and any tooltip, so the app beneath
 *    works as usual everywhere else;
 *  - nothing on screen at all (the bar went, the tooltip faded): the window
 *    is hidden, once an empty frame has been drawn: a window hidden with
 *    the bar still in its last frame shows that frame for a moment the next
 *    time it comes up.
 *
 * Arming a selection also gives the overlay the keyboard, so Escape (and
 * Enter on an adjusted box) reach it: after the first selection the panel
 * has it, for typing a question, and a chip pressed with the mouse does not
 * move it on every system.
 */
import type { Transport } from '../platform/transport';

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ARMED = new Set(['armed', 'drawing', 'adjusting']);

export interface PointerState {
  interactive: boolean;
  regions: Region[];
  /** Nothing of ours is on screen. */
  idle: boolean;
}

/** Reads the state off the page: the bar's host, its state, and the tooltips. */
export function readPointerState(doc: Document = document): PointerState {
  const host = doc.querySelector('selection-ai-overlay');
  const tips = [...doc.querySelectorAll('selection-ai-tooltip')];
  const state = host?.getAttribute('data-state') ?? '';
  const regions: Region[] = [];
  const bar = host?.shadowRoot?.querySelector('.bar');
  if (bar && !host?.hasAttribute('data-leaving')) regions.push(box(bar));
  for (const tip of tips) tip.shadowRoot?.querySelectorAll('.sai-tip').forEach((el) => regions.push(box(el)));
  return { interactive: !!host && ARMED.has(state), regions, idle: !host && tips.length === 0 };
}

function box(el: Element): Region {
  const r = el.getBoundingClientRect();
  return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
}

export function trackPointer(t: Transport, doc: Document = document): () => void {
  let last = '';
  let wasIdle = true;
  let wasInteractive = false;
  const report = () => {
    const s = readPointerState(doc);
    if (s.interactive && !wasInteractive) void t.invoke('overlay_focus').catch(() => {});
    wasInteractive = s.interactive;
    const key = JSON.stringify([s.interactive, s.regions]);
    if (key !== last) {
      last = key;
      void t.invoke('overlay_pointer', { interactive: s.interactive, regions: s.regions }).catch(() => {});
    }
    // Only on the way from something to nothing: right after the core shows
    // the window, the bar is not drawn yet.
    if (s.idle && !wasIdle) hideWhenClear();
    wasIdle = s.idle;
  };
  // At once when a selection is armed, or the pointer would go through to
  // the app before the first drag; and, while anything shows, on a timer for
  // whatever moves or grows (the gear's settings, a tooltip's text).
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Hides the window after two frames, if nothing came back meanwhile. */
  const hideWhenClear = () =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (readPointerState(doc).idle) void t.invoke('overlay_hide').catch(() => {});
      }),
    );
  const watch = () => {
    report();
    if (!wasIdle && timer === undefined) timer = setInterval(watch, 150);
    else if (wasIdle && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const observer = new MutationObserver(watch);
  observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'data-leaving'] });
  watch();
  return () => {
    observer.disconnect();
    clearInterval(timer);
  };
}
