/**
 * The panel and settings as cards, like the bar: no title bar (wm.rs makes
 * them without one), rounded on macOS (Windows 11 rounds them itself),
 * coming in with a short rise and going out with a fade. The top bar drags
 * the window; the page's own ✕ (SURFACE.ownWindow) closes it; ⌘Q quits.
 *
 * Each window is made hidden and shown from here once the page has drawn,
 * so it never flashes white or empty first.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { browser } from './platform/install';
import { MAC } from './os';

/** How long the exit plays before the window goes. */
const LEAVE_MS = 150;

/** What on the top bar is a control, not a place to drag the window by. */
const CONTROLS = 'button, a, input, select, textarea, label, [role="button"], [contenteditable="true"]';

export function cardWindow(opts: { drag: string; ready: () => boolean }): void {
  const root = document.documentElement;
  root.classList.add('card');
  if (MAC) root.classList.add('mac');

  // The top bar, wherever it is not a control, moves the window.
  document.addEventListener('mousedown', (e) => {
    const target = e.target as Element | null;
    if (e.button !== 0 || !target?.closest(opts.drag) || target.closest(CONTROLS)) return;
    void getCurrentWindow().startDragging().catch(() => {});
  });

  // Closing plays the exit first: the page's ✕, or the core finishing the chat.
  let leaving = false;
  const close = window.close.bind(window);
  window.close = () => {
    if (leaving) return;
    leaving = true;
    root.classList.add('leaving');
    setTimeout(close, LEAVE_MS);
  };
  browser.runtime.onMessage.addListener((msg) => {
    if ((msg as { type?: string })?.type === 'card:leave') window.close();
  });

  // ⌘Q quits the app from its windows, as in any Mac app (it has no menu bar of its own).
  document.addEventListener('keydown', (e) => {
    if (MAC && e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      void invoke('quit').catch(() => {});
    }
  });

  // Shown once there is something to show (or after a moment regardless).
  const started = performance.now();
  const show = () => {
    if (!opts.ready() && performance.now() - started < 800) return void requestAnimationFrame(show);
    requestAnimationFrame(() => requestAnimationFrame(() => void invoke('window_show').catch(() => {})));
  };
  requestAnimationFrame(show);
}
