/**
 * The in-page control bar: a red cancel X, the selection modes, the current
 * instruction, and a gear that expands the bar upwards into a scrollable
 * settings menu. Notices sit underneath the control row.
 *
 * It is pinned near the bottom of the viewport. A position setting can move it
 * later; for now every surface agrees on one place so it is always findable.
 *
 * One rule worth keeping: nothing secret is ever rendered here. This lives in
 * the page's DOM behind an open shadow root, so a hostile page could read
 * anything we put in it. API keys stay on the options page, which is an
 * extension page the page cannot reach.
 */
import type { SelectionKind } from '@shared/payload';
import { MODES, type Mode } from '@shared/payload';
import { getSettings, settingsItem, type SendBehavior, type Settings } from '@/lib/storage';
import { UI_ATTR } from './scroll';

export const BAR_STYLE = `
.bar {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  display: flex; flex-direction: column; max-width: min(720px, calc(100vw - 32px));
  font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  color: var(--sai-bar-fg, #f8fafc); background: var(--sai-bar-bg, rgba(15, 23, 42, 0.94));
  border-radius: 14px; box-shadow: 0 14px 40px rgba(0, 0, 0, 0.38);
  pointer-events: auto; overflow: hidden;
}
.row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; }
.close {
  display: flex; align-items: center; justify-content: center; flex: none;
  width: 26px; height: 26px; border: 0; border-radius: 8px; cursor: pointer;
  background: var(--sai-danger, #dc2626); color: #fff; font: inherit; font-size: 14px;
}
.close:hover { background: var(--sai-danger-hover, #ef4444); }
.chips { display: flex; gap: 2px; background: rgba(255, 255, 255, 0.12); padding: 2px; border-radius: 9px; flex: none; }
.chip {
  display: flex; align-items: center; gap: 5px; cursor: pointer; font: inherit; font-size: 12px;
  color: rgba(255, 255, 255, 0.72); background: transparent; border: 0; border-radius: 7px; padding: 4px 9px;
}
.chip:hover:not(:disabled) { color: #fff; }
.chip[aria-pressed='true'] { background: rgba(255, 255, 255, 0.92); color: #0f172a; }
.chip:disabled { opacity: 0.4; cursor: default; }
.chip svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.say { opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.say.gone { visibility: hidden; }
.gear {
  display: flex; align-items: center; justify-content: center; flex: none;
  width: 26px; height: 26px; border: 0; border-radius: 8px; cursor: pointer;
  background: rgba(255, 255, 255, 0.12); color: #fff;
}
.gear:hover, .gear[aria-expanded='true'] { background: rgba(255, 255, 255, 0.26); }
.gear svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }

.notices { display: flex; flex-direction: column; }
.notice {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.12); font-size: 12px; line-height: 1.45;
}
.notice button {
  font: inherit; font-size: 12px; cursor: pointer; border: 0; border-radius: 7px;
  padding: 4px 10px; background: var(--sai-accent, #3b82f6); color: #fff; flex: none;
}

/* The bar is anchored at its bottom, so growing this grows it upwards. */
.settings {
  max-height: 0; overflow-y: auto; overscroll-behavior: contain;
  transition: max-height 220ms ease;
  border-bottom: 1px solid transparent;
}
.settings.open { max-height: min(46vh, 340px); border-bottom-color: rgba(255, 255, 255, 0.12); }
.settings-inner { display: flex; flex-direction: column; gap: 12px; padding: 14px 14px 12px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field > span { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; }
.field select {
  font: inherit; font-size: 12px; padding: 6px 8px; border-radius: 8px; cursor: pointer;
  color: #fff; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.18);
}
.field select option { color: #0f172a; background: #fff; }
.more {
  align-self: flex-start; font: inherit; font-size: 12px; cursor: pointer;
  border: 0; background: none; padding: 0; color: var(--sai-accent, #60a5fa); text-decoration: underline;
}
@media (prefers-reduced-motion: reduce) { .settings { transition: none; } }
`;

const MODE_HINT: Record<SelectionKind, string> = {
  box: 'Drag to select an area',
  text: 'Select text on the page',
  element: 'Click an element to select it',
};

const ICONS: Record<SelectionKind, string> = {
  box: '<rect x="3" y="5" width="18" height="14" rx="2" stroke-dasharray="3 2.4"/>',
  text: '<path d="M5 6.5V5h14v1.5"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  element: '<path d="M4 4h16v6H4z"/><path d="M4 14h7v6H4z"/><path d="M14 14h6v6h-6z"/>',
};

const GEAR =
  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';

export interface BarHandlers {
  onCancel: () => void;
  onModeChange: (kind: SelectionKind) => void;
}

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

export class Bar {
  readonly el: HTMLElement;
  private say: HTMLElement;
  private notices: HTMLElement;
  private settings: HTMLElement;
  private settingsInner: HTMLElement;
  private gear: HTMLButtonElement;
  private settingsBuilt = false;

  constructor(
    private kind: SelectionKind,
    private modes: SelectionKind[],
    private handlers: BarHandlers,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'bar';
    this.el.setAttribute(UI_ATTR, 'bar');

    this.settings = document.createElement('div');
    this.settings.className = 'settings';
    this.settingsInner = document.createElement('div');
    this.settingsInner.className = 'settings-inner';
    this.settings.append(this.settingsInner);

    const row = document.createElement('div');
    row.className = 'row';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.title = 'Cancel (Escape)';
    close.setAttribute('aria-label', 'Cancel selection');
    close.textContent = '✕';
    close.addEventListener('click', () => this.handlers.onCancel());

    this.say = document.createElement('span');
    this.say.className = 'say';
    this.say.textContent = MODE_HINT[kind];

    this.gear = document.createElement('button');
    this.gear.type = 'button';
    this.gear.className = 'gear';
    this.gear.title = 'Settings';
    this.gear.setAttribute('aria-label', 'Settings');
    this.gear.setAttribute('aria-expanded', 'false');
    this.gear.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${GEAR}</svg>`;
    this.gear.addEventListener('click', () => void this.toggleSettings());

    row.append(close, this.buildChips(), this.say, this.gear);

    this.notices = document.createElement('div');
    this.notices.className = 'notices';

    this.el.append(this.settings, row, this.notices);
  }

  /** Hides the instruction while a selection is actually being drawn. */
  setDrawing(drawing: boolean): void {
    this.say.classList.toggle('gone', drawing);
    if (drawing) this.closeSettings();
  }

  setInstruction(text: string): void {
    this.say.textContent = text;
  }

  resetInstruction(): void {
    this.say.textContent = MODE_HINT[this.kind];
  }

  /** Adds a notice row under the controls. Returns a function that removes it. */
  notice(text: string, action: NoticeAction | null): () => void {
    const row = document.createElement('div');
    row.className = 'notice';
    const label = document.createElement('span');
    label.textContent = text;
    row.append(label);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      row.append(button);
    }
    this.notices.append(row);
    return () => row.remove();
  }

  private buildChips(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'chips';
    for (const kind of ['box', 'text', 'element'] as SelectionKind[]) {
      const available = this.modes.includes(kind);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.kind = kind;
      chip.setAttribute('aria-pressed', String(kind === this.kind));
      chip.disabled = !available;
      chip.title = available ? MODE_HINT[kind] : `${label(kind)} selection is not available here`;
      chip.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>`;
      chip.append(document.createTextNode(label(kind)));
      if (available && kind !== this.kind) {
        chip.addEventListener('click', () => this.handlers.onModeChange(kind));
      }
      wrap.append(chip);
    }
    return wrap;
  }

  private closeSettings(): void {
    this.settings.classList.remove('open');
    this.gear.setAttribute('aria-expanded', 'false');
  }

  private async toggleSettings(): Promise<void> {
    if (this.settings.classList.contains('open')) return this.closeSettings();
    if (!this.settingsBuilt) {
      await this.buildSettings();
      this.settingsBuilt = true;
    }
    this.settings.classList.add('open');
    this.gear.setAttribute('aria-expanded', 'true');
  }

  /**
   * The quick settings. Deliberately the ones worth changing mid-task; keys,
   * prompts and blocked sites live on the options page, both because they need
   * more room and because this DOM belongs to the page.
   */
  private async buildSettings(): Promise<void> {
    const settings = await getSettings();
    const save = async (patch: Partial<Settings>) => {
      const current = await getSettings();
      await settingsItem.setValue({ ...current, ...patch });
    };

    this.settingsInner.append(
      field('Selection mode', [['box', 'Box — drag around anything'], ['text', 'Text — select text on the page']], settings.defaultSelectionKind, (v) =>
        void save({ defaultSelectionKind: v as SelectionKind }),
      ),
      field('Ask mode', MODES.map((m) => [m, modeLabel(m)] as [string, string]), settings.defaultMode, (v) => void save({ defaultMode: v as Mode })),
      field(
        'When a selection lands',
        [
          ['prefill', 'Fill the box and wait'],
          ['auto', 'Send straight away'],
          ['auto-box', 'Send box selections only'],
        ],
        settings.sendBehavior,
        (v) => void save({ sendBehavior: v as SendBehavior }),
      ),
      field(
        'Answered by',
        [
          ['mock', 'Mock — replay, no spend'],
          ['local', 'Local — Ollama'],
          ['byok', 'My own API key'],
          ['gateway', 'Hosted plan'],
        ],
        settings.provider,
        (v) => void save({ provider: v as Settings['provider'] }),
      ),
    );

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    more.textContent = 'All settings, keys and prompts';
    more.addEventListener('click', () => void browser.runtime.sendMessage({ type: 'options:open' }).catch(() => {}));
    this.settingsInner.append(more);
  }
}

function field(name: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const title = document.createElement('span');
  title.textContent = name;
  const select = document.createElement('select');
  for (const [v, text] of options) {
    const option = document.createElement('option');
    option.value = v;
    option.textContent = text;
    option.selected = v === value;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  wrap.append(title, select);
  return wrap;
}

function label(kind: SelectionKind): string {
  return kind[0]!.toUpperCase() + kind.slice(1);
}

function modeLabel(mode: Mode): string {
  return mode[0]!.toUpperCase() + mode.slice(1);
}
