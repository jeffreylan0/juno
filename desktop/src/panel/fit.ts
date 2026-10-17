/**
 * The panel is as tall as its chat needs: it starts most of the screen tall
 * (wm.rs) and grows, smoothly, away from the edge it was placed at as
 * selections and answers come in, until it reaches the screen's edge, when
 * the chat scrolls instead. Within one chat it never shrinks (no jumping
 * while an answer streams); a new chat starts at the starting height again.
 *
 * Resized by hand, it stays as the student left it, and that size is kept
 * (panelSizeItem): the panel opens at it from then on, without growing.
 */
import { invoke } from '@tauri-apps/api/core';
import { panelSizeItem } from '@/lib/storage';

/** A little longer than wm.rs takes to animate a resize: the sizes on the way are ours. */
const SETTLE_MS = 260;
/**
 * Shown again, the panel is placed (and sized) by the core a moment after it
 * is told (core/main.ts reads settings in between): that resize is ours too.
 * No one resizes a panel by hand this soon after it appears.
 */
const SHOWN_MS = 1000;

export function fitToChat(): { reset: () => void } {
  let chat: string | null = null;
  let byHand = false;
  let queued = false;
  /** Until when resizes are ours (asked for and animating). */
  let oursUntil = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const measure = () => {
    queued = false;
    const panel = document.querySelector<HTMLElement>('.panel');
    const thread = panel?.querySelector<HTMLElement>('.thread');
    if (!panel || !thread || byHand || Date.now() < oursUntil) return;
    const id = panel.getAttribute('data-chat') ?? '';
    // Everything but the thread, plus all of the thread.
    const needed = Math.ceil(panel.offsetHeight - thread.clientHeight + thread.scrollHeight);
    const want = id === chat ? Math.max(needed, Math.round(innerHeight)) : needed;
    chat = id;
    if (Math.abs(want - innerHeight) < 4) return;
    oursUntil = Date.now() + SETTLE_MS;
    const animate = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    void invoke<number>('panel_fit', { height: want, animate }).catch(() => {});
  };
  const soon = () => {
    if (queued) return;
    queued = true;
    setTimeout(measure, 100);
  };

  // A resize that is not ours is the student's: kept, and remembered.
  const onResize = () => {
    if (Date.now() < oursUntil) return;
    byHand = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void panelSizeItem.setValue({ width: innerWidth, height: innerHeight }).catch(() => {}), 400);
  };
  addEventListener('resize', onResize);
  new MutationObserver(soon).observe(document.getElementById('root')!, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-chat', 'src', 'class'] });
  // Screenshots load after they are put in.
  document.addEventListener('load', soon, true);
  soon();
  return {
    // The panel is shown again (wm.rs places it): at the remembered size, or growing with its chat.
    reset: () => {
      oursUntil = Date.now() + SHOWN_MS;
      chat = null;
      void panelSizeItem.getValue().then(
        (size) => {
          byHand = !!size;
          soon();
        },
        () => soon(),
      );
    },
  };
}
