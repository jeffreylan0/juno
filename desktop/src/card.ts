/**
 * The panel and settings as cards, like the bar: on macOS ordinary windows
 * with the title bar hidden, so the system rounds them and draws their
 * shadow (wm.rs); on Windows and Linux windows without decorations. The
 * page fills the window with its own background and its content comes in
 * with a short rise. They go at once: content fading out would leave the
 * empty window on screen for a moment. The top bar drags the window; the
 * page's own ✕ closes it (`onClose` for the panel), and so does Escape,
 * unless something on the page took it first (a menu, an editor); ⌘Q quits.
 *
 * Both are made hidden at start and kept. Settings tell the native core
 * when their page has drawn, so that, asked for before then, they never
 * flash white or empty first; the core shows and hides the panel, telling
 * it `card:enter` so it plays its entrance.
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
  /** Tells the native core once this holds (or after a moment regardless): the window may show. */
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
    playEntrance();
    opts.onEnter?.();
  });

  // Escape closes the card, as its ✕ does, once the page's own handlers have
  // had it: a menu or an editor that closes on Escape marks it handled.
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.repeat) return;
    setTimeout(() => !e.defaultPrevented && window.close());
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
export function playEntrance(): void {
  for (const el of document.querySelectorAll<HTMLElement>('.panel, .page')) {
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }
}
