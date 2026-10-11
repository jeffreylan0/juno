/**
 * The panel is as tall as its chat needs: it starts most of the screen tall
 * (wm.rs) and grows downwards as selections and answers come in, until it
 * reaches the bottom of the screen, when the chat scrolls instead. Within
 * one chat it never shrinks (no jumping while an answer streams); a new chat
 * starts at the starting height again. Resized by hand, it stays as the
 * student left it until it is next shown (`reset`), when wm.rs puts it back.
 */
import { invoke } from '@tauri-apps/api/core';

export function fitToChat(): { reset: () => void; stop: () => void } {
  let chat: string | null = null;
  let asked = 0;
  let pending = false;
  let byHand = false;
  let queued = false;

  const measure = () => {
    queued = false;
    const panel = document.querySelector<HTMLElement>('.panel');
    const thread = panel?.querySelector<HTMLElement>('.thread');
    if (!panel || !thread || byHand || pending) return;
    const id = panel.getAttribute('data-chat') ?? '';
    // Everything but the thread, plus all of the thread.
    const needed = Math.ceil(panel.offsetHeight - thread.clientHeight + thread.scrollHeight);
    const want = id === chat ? Math.max(needed, Math.round(innerHeight)) : needed;
    chat = id;
    if (Math.abs(want - innerHeight) < 4) return;
    pending = true;
    asked = want;
    void invoke<number>('panel_fit', { height: want })
      .then((h) => (asked = h))
      .catch(() => {})
      .finally(() => setTimeout(() => (pending = false), 120));
  };
  const soon = () => {
    if (queued) return;
    queued = true;
    setTimeout(measure, 100);
  };

  // A resize we did not ask for is the student's.
  const onResize = () => {
    if (!pending && asked && Math.abs(innerHeight - asked) > 8) byHand = true;
  };
  addEventListener('resize', onResize);
  const observer = new MutationObserver(soon);
  observer.observe(document.getElementById('root')!, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-chat', 'src', 'class'] });
  // Screenshots load after they are put in.
  document.addEventListener('load', soon, true);
  soon();
  return {
    reset: () => {
      byHand = false;
      chat = null;
      soon();
    },
    stop: () => {
      observer.disconnect();
      removeEventListener('resize', onResize);
      document.removeEventListener('load', soon, true);
    },
  };
}
