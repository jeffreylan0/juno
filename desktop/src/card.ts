/**
 * The panel and settings as cards, like the bar: on macOS ordinary windows
 * with the title bar hidden, so the system rounds them and draws their
 * shadow (wm.rs); on Windows and Linux windows without decorations. The
 * page fills the window with its own background and its content comes in
 * with a short rise. They go at once: content fading out would leave the
 * empty window on screen for a moment. The top bar drags the window; the
 * page's own ✕ (SURFACE.ownWindow) closes it; ⌘Q quits.
 *
 * Settings are made hidden and shown from here once the page has drawn, so
 * they never flash white or empty first. The panel is made at start and
 * kept: the core shows and hides it, telling it `card:enter` so it plays its
 * entrance.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { browser } from './platform/install';
import { MAC } from './os';

/** What on the top bar is a control, not a place to drag the window by. */
const CONTROLS = 'button, a, input, select, textarea, label, [role="button"], [contenteditable="true"]';

export interface CardOptions {
  /** Where the window can be dragged by. */
  drag: string;
  /** Shows the window once this holds (or after a moment regardless). Without it, someone else shows it. */
  ready?: () => boolean;
  /** ✕ asks for this instead of closing the window (the panel: the core finishes the chat, then hides it). */
  onClose?: () => void;
  /** The window is about to show again (`card:enter`). */
  onEnter?: () => void;
}

export function cardWindow(opts: CardOptions): void {
  const root = document.documentElement;
  // An attribute, not a class: the pages have classes of their own (settings' `.card`).
  root.dataset.card = 'in';

  // The top bar, wherever it is not a control, moves the window.
  document.addEventListener('mousedown', (e) => {
    const target = e.target as Element | null;
    if (e.button !== 0 || !target?.closest(opts.drag) || target.closest(CONTROLS)) return;
    void getCurrentWindow().startDragging().catch(() => {});
  });

  // The page's ✕.
  if (opts.onClose) window.close = opts.onClose;

  // Shown by the core again (the panel): its entrance plays again.
  browser.runtime.onMessage.addListener((msg) => {
    if ((msg as { type?: string })?.type !== 'card:enter') return;
    enter();
    opts.onEnter?.();
  });

  // ⌘Q quits the app from its windows, as in any Mac app (it has no menu bar of its own).
  document.addEventListener('keydown', (e) => {
    if (MAC && e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      void invoke('quit').catch(() => {});
    }
  });

  if (!opts.ready) return;
  const ready = opts.ready;
  const started = performance.now();
  const show = () => {
    if (!ready() && performance.now() - started < 800) return void requestAnimationFrame(show);
    requestAnimationFrame(() => requestAnimationFrame(() => void invoke('window_show').catch(() => {})));
  };
  requestAnimationFrame(show);
}

/** Plays the entrance again (the window is about to show). */
function enter(): void {
  for (const el of document.querySelectorAll<HTMLElement>('.panel, .page')) {
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }
}
