/**
 * Shadow-DOM overlay: hosts the box selector, the centred hint, and (from
 * week 12) the Safari in-page panel. Mounted only while a selection is armed
 * and removed before the tab is captured.
 *
 * The root is focusable and takes focus on mount so Escape reaches the page
 * even when the toolbar popup had it a moment ago, and Escape is also watched
 * on the document in capture so a page that swallows keys cannot trap us.
 */
import type { ContentScriptContext } from '#imports';
import type { Rect, SelectionKind } from '@shared/payload';
import { BoxSelector } from './select-box';
import { readSelection, type TextSelection } from './select-text';

/** How long the hint stays solid before fading out. */
export const HINT_IDLE_MS = 2500;

const STYLE = `
:host { all: initial; }
.root {
  position: fixed; inset: 0; z-index: 2147483647;
  user-select: none; -webkit-user-select: none; outline: none;
  pointer-events: none;                 /* text mode leaves the page usable */
}
.root.interactive { pointer-events: auto; cursor: crosshair; }
.box {
  position: fixed; border: 2px dashed var(--sai-accent, #3b82f6);
  background: color-mix(in srgb, var(--sai-accent, #3b82f6) 8%, transparent);
  box-shadow: 0 0 0 100vmax var(--sai-scrim, rgba(15, 23, 42, 0.35));
  pointer-events: none; display: none;
}
.hint {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  display: flex; align-items: center; gap: 8px;
  font: 500 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  color: var(--sai-hint-fg, #fff); background: var(--sai-hint-bg, rgba(15, 23, 42, 0.88));
  padding: 10px 16px; border-radius: 10px; white-space: nowrap;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  pointer-events: none;
  opacity: 1; transition: opacity 400ms ease;
}
.hint.faded { opacity: 0; }
.hint kbd {
  font: inherit; font-size: 12px; border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 4px; padding: 1px 5px;
}
@media (prefers-reduced-motion: reduce) { .hint { transition: none; } }
`;

const HINT_TEXT: Record<SelectionKind, string> = {
  box: 'Drag to select an area',
  text: 'Select text on the page',
  element: 'Click an element to select it',
};

export class Overlay {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private hint: HTMLElement | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cancels whatever selection is currently armed. */
  private cancelCurrent: (() => void) | null = null;

  constructor(private ctx: ContentScriptContext) {}

  get active(): boolean {
    return this.root !== null;
  }

  private mount(kind: SelectionKind): HTMLElement {
    this.unmount();
    const host = document.createElement('selection-ai-overlay');
    // Open, not closed: the overlay holds nothing worth hiding, a page that
    // wanted to interfere could remove the host either way, and open keeps it
    // inspectable in DevTools and reachable from the end-to-end tests.
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;

    const root = document.createElement('div');
    root.className = kind === 'box' ? 'root interactive' : 'root';
    root.tabIndex = -1;

    const box = document.createElement('div');
    box.className = 'box';

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.append(document.createTextNode(HINT_TEXT[kind]), sep(), kbd('Esc'), document.createTextNode('to cancel'));

    root.append(box, hint);
    shadow.append(style, root);
    document.documentElement.append(host);

    this.host = host;
    this.root = root;
    this.hint = hint;
    // Take focus so Escape lands here rather than in the toolbar popup.
    root.focus({ preventScroll: true });
    this.scheduleFade();
    return root;
  }

  unmount(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.hint = null;
  }

  /** Fades the hint after a quiet spell; any activity brings it back. */
  scheduleFade(): void {
    if (!this.hint) return;
    this.setHint(false);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.setHint(true), HINT_IDLE_MS);
  }

  /** Hides the hint immediately, for once a drag has started. */
  hideHint(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.setHint(true);
  }

  private setHint(faded: boolean): void {
    this.hint?.classList.toggle('faded', faded);
    // Mirrored on the host so the state is legible from outside the shadow root.
    this.host?.setAttribute('data-hint', faded ? 'faded' : 'visible');
  }

  /** Cancels an armed selection, resolving its promise with null. */
  abort(): void {
    this.cancelCurrent?.();
  }

  /** Resolves with a viewport rect in CSS pixels, or null when cancelled. */
  async selectBox(): Promise<Rect | null> {
    const root = this.mount('box');
    const box = root.querySelector<HTMLElement>('.box')!;
    return await this.run((finish) => {
      const selector = new BoxSelector(root, box, {
        onActivity: () => this.scheduleFade(),
        onDragStart: () => this.hideHint(),
        onDone: finish,
      });
      return selector.attach();
    });
  }

  /** Shows the hint and waits for the user to select text on the page. */
  async selectText(): Promise<TextSelection | null> {
    this.mount('text');
    return await this.run((finish) => {
      const onUp = () => {
        // The selection settles a tick after mouseup.
        setTimeout(() => {
          const sel = readSelection();
          this.scheduleFade();
          if (sel) finish(sel);
        }, 0);
      };
      document.addEventListener('mouseup', onUp, true);
      document.addEventListener('selectionchange', this.onActivity, true);
      return () => {
        document.removeEventListener('mouseup', onUp, true);
        document.removeEventListener('selectionchange', this.onActivity, true);
      };
    });
  }

  private onActivity = () => this.scheduleFade();

  /**
   * Shared plumbing: mounts Escape handling, runs `arm` (which returns its own
   * teardown), and guarantees the overlay is removed however it ends.
   */
  private run<T>(arm: (finish: (value: T | null) => void) => () => void): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      let settled = false;
      const teardown: (() => void)[] = [];
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        teardown.forEach((f) => f());
        this.cancelCurrent = null;
        this.unmount();
        resolve(value);
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      };
      // Capture on both: the page may stop propagation, and focus may sit in
      // an iframe or an input rather than on our root.
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('keydown', onKey, true);
      const onMove = () => this.scheduleFade();
      document.addEventListener('pointermove', onMove, true);
      teardown.push(() => {
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('keydown', onKey, true);
        document.removeEventListener('pointermove', onMove, true);
      });

      teardown.push(arm(finish));
      this.cancelCurrent = () => finish(null);
      this.ctx.onInvalidated(() => finish(null));
    });
  }
}

function kbd(label: string): HTMLElement {
  const el = document.createElement('kbd');
  el.textContent = label;
  return el;
}

function sep(): Text {
  return document.createTextNode('·');
}
