/**
 * Shadow-DOM overlay: hosts the box selector (and later hover highlights and
 * the Safari in-page panel). It is mounted only while a selection is active
 * and removed before the tab is captured.
 */
import type { ContentScriptContext } from '#imports';
import type { Rect } from '@shared/payload';
import { BoxSelector } from './select-box';

const STYLE = `
:host { all: initial; }
.root {
  position: fixed; inset: 0; z-index: 2147483647;
  cursor: crosshair; user-select: none; -webkit-user-select: none;
}
.box {
  position: fixed; border: 2px dashed #3b82f6; background: rgba(59,130,246,0.08);
  box-shadow: 0 0 0 100vmax rgba(15,23,42,0.35); pointer-events: none; display: none;
}
.hint {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  font: 13px/1.4 -apple-system, system-ui, sans-serif; color: #fff;
  background: rgba(15,23,42,0.85); padding: 6px 12px; border-radius: 8px; pointer-events: none;
}
`;

export class Overlay {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;

  constructor(private ctx: ContentScriptContext) {}

  private mount(): HTMLElement {
    if (this.root) return this.root;
    const host = document.createElement('selection-ai-overlay');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const root = document.createElement('div');
    root.className = 'root';
    root.innerHTML = `<div class="box"></div><div class="hint">Drag to draw a box · Esc to cancel</div>`;
    shadow.append(style, root);
    document.documentElement.append(host);
    this.host = host;
    this.root = root;
    return root;
  }

  unmount(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
  }

  /** Resolves with a viewport rect in CSS pixels, or null when cancelled. */
  async selectBox(): Promise<Rect | null> {
    const root = this.mount();
    const box = root.querySelector<HTMLElement>('.box')!;
    try {
      return await new BoxSelector(root, box, this.ctx).run();
    } finally {
      this.unmount();
    }
  }
}
