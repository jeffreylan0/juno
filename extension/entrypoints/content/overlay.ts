/**
 * Shadow-DOM overlay: the box selector, the centred hint with its mode chips,
 * and (from week 12) the Safari in-page panel. Mounted only while a selection
 * is armed and removed before the tab is captured.
 *
 * The hint is the only UI between clicking the toolbar icon and selecting, so
 * it carries the mode switcher. It appears only once the page can actually
 * take input, hides while you drag, and fades when you leave it alone.
 */
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
  display: flex; align-items: center; gap: 10px;
  font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  color: var(--sai-hint-fg, #fff); background: var(--sai-hint-bg, rgba(15, 23, 42, 0.92));
  padding: 8px 10px; border-radius: 12px; white-space: nowrap;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.34);
  pointer-events: auto;                 /* the chips are clickable */
  opacity: 1; transition: opacity 300ms ease;
}
.hint.faded { opacity: 0; pointer-events: none; }
.hint.hidden { display: none; }
.chips { display: flex; gap: 2px; background: rgba(255, 255, 255, 0.12); padding: 2px; border-radius: 9px; }
.chip {
  display: flex; align-items: center; gap: 5px; cursor: pointer;
  font: inherit; font-size: 12px; color: rgba(255, 255, 255, 0.72);
  background: transparent; border: 0; border-radius: 7px; padding: 4px 9px;
}
.chip:hover:not(:disabled) { color: #fff; }
.chip[aria-pressed='true'] { background: rgba(255, 255, 255, 0.92); color: #0f172a; }
.chip:disabled { opacity: 0.4; cursor: default; }
.chip svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.say { opacity: 0.85; }
.hint kbd {
  font: inherit; font-size: 11px; border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 4px; padding: 1px 5px;
}
.note {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; pointer-events: auto;
  font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  color: #fff; background: var(--sai-hint-bg, rgba(15, 23, 42, 0.92));
  padding: 10px 14px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.34);
}
.note button {
  font: inherit; font-size: 12px; cursor: pointer; border: 0; border-radius: 7px;
  padding: 5px 11px; background: var(--sai-accent, #3b82f6); color: #fff;
}
@media (prefers-reduced-motion: reduce) { .hint { transition: none; } }
`;

const HINT_TEXT: Record<SelectionKind, string> = {
  box: 'Drag to select an area',
  text: 'Select text on the page',
  element: 'Click an element to select it',
};

const ICONS: Record<SelectionKind, string> = {
  box: '<rect x="3" y="5" width="18" height="14" rx="2" stroke-dasharray="3 2.4"/>',
  text: '<path d="M5 6.5V5h14v1.5"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  element: '<path d="M4 4h16v6H4z"/><path d="M4 14h7v6H4z"/><path d="M14 14h6v6h-6z"/>',
};

export interface OverlayHandlers {
  /** The user picked a different mode from the hint's chips. */
  onModeChange: (kind: SelectionKind) => void;
}

/**
 * Just enough of WXT's ContentScriptContext to tear down cleanly. The reader is
 * an extension page and has no such context, so it passes a no-op.
 */
export interface OverlayHost {
  onInvalidated(cb: () => void): void;
}

export class Overlay {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private hint: HTMLElement | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private dragging = false;
  /** Cancels whatever selection is currently armed. */
  private cancelCurrent: (() => void) | null = null;

  constructor(
    private ctx: OverlayHost,
    private handlers: OverlayHandlers,
  ) {}

  get active(): boolean {
    return this.root !== null;
  }

  private mount(kind: SelectionKind, modes: SelectionKind[]): HTMLElement {
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
    hint.append(buildChips(kind, modes, this.handlers.onModeChange), say(HINT_TEXT[kind]), kbd('Esc'), say('to cancel'));

    root.append(box, hint);
    shadow.append(style, root);
    document.documentElement.append(host);

    this.host = host;
    this.root = root;
    this.hint = hint;
    this.dragging = false;
    // Take focus so Escape lands here rather than wherever it was.
    root.focus({ preventScroll: true });

    // Only promise "drag here" once the page can actually take the input. A
    // keyboard shortcut fired from another surface can arm us while focus is
    // still elsewhere, and a hint nobody can act on is worse than none.
    if (document.hasFocus()) this.scheduleFade();
    else {
      this.setHint(true, true);
      const reveal = () => {
        window.removeEventListener('focus', reveal);
        document.removeEventListener('pointermove', reveal, true);
        this.scheduleFade();
      };
      window.addEventListener('focus', reveal);
      document.addEventListener('pointermove', reveal, true);
    }
    return root;
  }

  unmount(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.hint = null;
    this.dragging = false;
  }

  /** Fades the hint after a quiet spell; any activity brings it back. */
  scheduleFade(): void {
    if (!this.hint || this.dragging) return;
    this.setHint(false);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.setHint(true), HINT_IDLE_MS);
  }

  /** Takes the hint away for the duration of a drag. */
  private startDrag(): void {
    this.dragging = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.setHint(true);
  }

  private endDrag(): void {
    this.dragging = false;
    this.scheduleFade();
  }

  private setHint(faded: boolean, hidden = false): void {
    this.hint?.classList.toggle('faded', faded);
    this.hint?.classList.toggle('hidden', hidden);
    // Mirrored on the host so the state is legible from outside the shadow root.
    this.host?.setAttribute('data-hint', hidden ? 'hidden' : faded ? 'faded' : 'visible');
  }

  /** Cancels an armed selection, resolving its promise with null. */
  abort(): void {
    this.cancelCurrent?.();
  }

  /**
   * Shows a one-off notice at the bottom of the screen with an action button.
   * Used for things the page itself cannot do, such as opening a PDF in the
   * reader. Returns a function that removes it.
   */
  notice(text: string, action: { label: string; onClick: () => void } | null): () => void {
    if (!this.root) return () => {};
    const note = document.createElement('div');
    note.className = 'note';
    note.append(say(text));
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      note.append(button);
    }
    this.root.append(note);
    return () => note.remove();
  }

  /** Resolves with a viewport rect in CSS pixels, or null when cancelled. */
  async selectBox(modes: SelectionKind[]): Promise<Rect | null> {
    const root = this.mount('box', modes);
    const box = root.querySelector<HTMLElement>('.box')!;
    return await this.run((finish) => {
      const selector = new BoxSelector(root, box, {
        onActivity: () => this.scheduleFade(),
        onDragStart: () => this.startDrag(),
        onDragCancel: () => this.endDrag(),
        onDone: finish,
      });
      return selector.attach();
    });
  }

  /** Shows the hint and waits for the user to select text on the page. */
  async selectText(modes: SelectionKind[]): Promise<TextSelection | null> {
    this.mount('text', modes);
    return await this.run((finish) => {
      const onDown = () => this.startDrag();
      const onUp = () => {
        // The selection settles a tick after mouseup.
        setTimeout(() => {
          const sel = readSelection();
          this.endDrag();
          if (sel) finish(sel);
        }, 0);
      };
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('mouseup', onUp, true);
      return () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('mouseup', onUp, true);
      };
    });
  }

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
      // an input rather than on our root.
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

function buildChips(active: SelectionKind, modes: SelectionKind[], onPick: (k: SelectionKind) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  for (const kind of ['box', 'text', 'element'] as SelectionKind[]) {
    const available = modes.includes(kind);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.kind = kind;
    chip.setAttribute('aria-pressed', String(kind === active));
    chip.disabled = !available;
    chip.title = available ? HINT_TEXT[kind] : `${label(kind)} selection is not available here`;
    chip.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>`;
    chip.append(document.createTextNode(label(kind)));
    if (available && kind !== active) {
      chip.addEventListener('pointerdown', (e) => {
        // The overlay swallows pointerdown for the box drag, so act on it here.
        e.preventDefault();
        e.stopPropagation();
        onPick(kind);
      });
    }
    wrap.append(chip);
  }
  return wrap;
}

function label(kind: SelectionKind): string {
  return kind[0]!.toUpperCase() + kind.slice(1);
}

function kbd(text: string): HTMLElement {
  const el = document.createElement('kbd');
  el.textContent = text;
  return el;
}

function say(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'say';
  el.textContent = text;
  return el;
}
