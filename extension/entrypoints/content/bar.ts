/**
 * The in-page control bar: a red X that finishes the chat (the bar and the
 * answer panel close), the selection modes, the current instruction, an Ask
 * button while a box is being adjusted, the ghost (the next selection starts
 * a temporary chat), and a gear that expands the bar upwards into a
 * scrollable settings menu. Warnings about the page go to the top of the
 * page instead (lib/tooltip.ts).
 *
 * The bar is built once and stays up for as long as it is on the page: while
 * selecting, while a selection is sent, and between selections, when nothing
 * is armed, the page works normally, and a chip starts the next selection.
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
import { ICON_PATHS, svgIcon } from '@/lib/icons';
import { KIND_ICON as ICONS, KIND_LABEL, KIND_ORDER } from '@/lib/kinds';
import { send } from '@/lib/messages';
import { getSettings, settingsItem, type Settings } from '@/lib/storage';
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
.chip:hover:not(:disabled) { color: #fff; background: rgba(255, 255, 255, 0.1); }
/* After the hover rule, so hovering the selected chip keeps dark-on-light. */
.chip[aria-pressed='true'], .chip[aria-pressed='true']:hover { background: rgba(255, 255, 255, 0.92); color: #0f172a; }
.chip:disabled { opacity: 0.4; cursor: default; }
.chip svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.say { opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.say.gone { visibility: hidden; }
.ask {
  display: none; align-items: center; gap: 5px; flex: none; cursor: pointer;
  font: inherit; font-size: 12px; border: 0; border-radius: 8px; padding: 4px 11px;
  background: var(--sai-accent, #3b82f6); color: #fff;
}
.ask.on { display: flex; }
.ask:hover { background: var(--sai-accent-hover, #2563eb); }
.ask svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.gear, .ghost {
  display: flex; align-items: center; justify-content: center; flex: none;
  width: 26px; height: 26px; border: 0; border-radius: 8px; cursor: pointer;
  background: rgba(255, 255, 255, 0.12); color: #fff;
}
.gear:hover, .gear[aria-expanded='true'], .ghost:hover { background: rgba(255, 255, 255, 0.26); }
.ghost[aria-pressed='true'], .ghost[aria-pressed='true']:hover { background: rgba(255, 255, 255, 0.92); color: #0f172a; }
.gear svg, .ghost svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
/* Taken out of the screenshot when the selection runs under it; back right after. */
.bar.out-of-shot { visibility: hidden; }

/* The bar is anchored at its bottom, so growing this grows it upwards. */
.settings {
  max-height: 0; overflow-y: auto; overscroll-behavior: contain;
  transition: max-height 220ms ease;
  border-top: 1px solid transparent;
}
.settings.open { max-height: min(46vh, 340px); border-top-color: rgba(255, 255, 255, 0.12); }
.settings-inner { display: flex; flex-direction: column; gap: 12px; padding: 14px 14px 12px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field > span { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; }
.field select {
  font: inherit; font-size: 12px; padding: 6px 30px 6px 8px; border-radius: 8px; cursor: pointer;
  color: #fff; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.18);
  /* The native arrow sits hard against the edge and ignores our padding. */
  -webkit-appearance: none; -moz-appearance: none; appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23ffffff' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center; background-size: 12px 12px;
}
.field select::-ms-expand { display: none; }
.field select option { color: #0f172a; background: #fff; }
.more {
  align-self: flex-start; font: inherit; font-size: 12px; cursor: pointer;
  border: 0; background: none; padding: 0; color: var(--sai-accent, #60a5fa); text-decoration: underline;
}
@media (prefers-reduced-motion: reduce) { .settings { transition: none; } }
`;

/** Shown while a drawn box waits to be adjusted and sent. */
export const ADJUST_HINT = 'Drag the edges to adjust · Enter to send';

/** Between selections: nothing armed, the page is the student's. */
export const READY_HINT = 'Pick a mode to select more';

const MODE_HINT: Record<SelectionKind, string> = {
  box: 'Drag over an area',
  text: 'Highlight some text',
  element: 'Click part of the page · ↑ ↓ to resize',
  freeform: 'Draw around it',
};

const GHOST_OFF = "Temporary chat (next selection isn't saved)";
const GHOST_ON = 'Temporary chat is on. Click to leave (deletes it)';

export interface BarHandlers {
  /** The red X: finishes the chat, which closes the bar and the answer panel. */
  onClose: () => void;
  /** The Ask button, shown while a drawn box is being adjusted. */
  onConfirm: () => void;
  onModeChange: (kind: SelectionKind) => void;
  /** The ghost, pressed. */
  onGhost: () => void;
}

export class Bar {
  readonly el: HTMLElement;
  private say: HTMLElement;
  private settings: HTMLElement;
  private settingsInner: HTMLElement;
  private gear: HTMLButtonElement;
  private ghost: HTMLButtonElement;
  private ask: HTMLButtonElement;
  private chips = new Map<SelectionKind, HTMLButtonElement>();
  private settingsBuilt = false;
  private drawing = false;
  /** The mode being selected in, or null while the bar waits between selections. */
  private kind: SelectionKind | null = null;

  constructor(
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
    close.title = 'Done (closes the bar and panel)';
    close.setAttribute('aria-label', 'Done (closes the bar and panel)');
    close.textContent = '✕';
    close.addEventListener('click', () => this.handlers.onClose());

    this.say = document.createElement('span');
    this.say.className = 'say';
    this.say.textContent = this.hint();

    this.ask = document.createElement('button');
    this.ask.type = 'button';
    this.ask.className = 'ask';
    this.ask.title = 'Send this box (Enter)';
    this.ask.append(svgIcon(ICON_PATHS.check), document.createTextNode('Ask'));
    this.ask.addEventListener('click', () => this.handlers.onConfirm());

    this.ghost = document.createElement('button');
    this.ghost.type = 'button';
    this.ghost.className = 'ghost';
    this.ghost.setAttribute('aria-label', 'Temporary chat');
    this.ghost.append(svgIcon(ICON_PATHS.ghost));
    this.ghost.addEventListener('click', () => this.handlers.onGhost());
    this.setGhost(false);

    this.gear = document.createElement('button');
    this.gear.type = 'button';
    this.gear.className = 'gear';
    this.gear.title = 'Settings';
    this.gear.setAttribute('aria-label', 'Settings');
    this.gear.setAttribute('aria-expanded', 'false');
    this.gear.append(svgIcon(ICON_PATHS.gear));
    this.gear.addEventListener('click', () => void this.toggleSettings());

    row.append(close, this.buildChips(), this.say, this.ask, this.ghost, this.gear);

    // Row, then settings: the bar is anchored at its bottom, so opening the
    // gear grows it upwards.
    this.el.append(row, this.settings);
  }

  /** Which mode is being selected in; null while the bar waits. */
  setKind(kind: SelectionKind | null): void {
    this.kind = kind;
    for (const [k, chip] of this.chips) chip.setAttribute('aria-pressed', String(k === kind));
    this.say.textContent = this.hint();
  }

  /** Whether the next selection goes into a temporary chat. */
  setGhost(on: boolean): void {
    this.ghost.setAttribute('aria-pressed', String(on));
    this.ghost.title = on ? GHOST_ON : GHOST_OFF;
  }

  /** Hides the instruction while a selection is actually being drawn. */
  setDrawing(drawing: boolean): void {
    this.drawing = drawing;
    this.say.classList.toggle('gone', drawing);
    if (drawing) this.closeSettings();
  }

  /** A box is drawn and waiting: show the Ask button and how to adjust it. */
  setAdjusting(adjusting: boolean): void {
    this.ask.classList.toggle('on', adjusting);
    this.say.textContent = adjusting ? ADJUST_HINT : this.hint();
  }

  private hint(): string {
    return this.kind ? MODE_HINT[this.kind] : READY_HINT;
  }

  /**
   * Replaces the instruction. Mid-drag the instruction is hidden (the cursor
   * tooltip takes over), but a warning such as "the selection stops at the
   * edge" still needs to be seen, so non-empty text shows through.
   */
  setInstruction(text: string): void {
    this.say.textContent = text;
    this.say.classList.toggle('gone', this.drawing && !text);
  }

  resetInstruction(): void {
    this.say.textContent = this.hint();
  }

  private buildChips(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'chips';
    for (const kind of KIND_ORDER) {
      const available = this.modes.includes(kind);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.kind = kind;
      chip.setAttribute('aria-pressed', 'false');
      chip.disabled = !available;
      chip.title = available ? MODE_HINT[kind] : unavailableTitle(kind);
      chip.append(svgIcon(ICONS[kind]), document.createTextNode(label(kind)));
      chip.addEventListener('click', () => kind !== this.kind && this.handlers.onModeChange(kind));
      this.chips.set(kind, chip);
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
      try {
        await this.buildSettings();
      } catch {
        return; // the extension was updated under this page; the controller notices on the next click
      }
      this.settingsBuilt = true;
    }
    this.settings.classList.add('open');
    this.gear.setAttribute('aria-expanded', 'true');
  }

  /**
   * The quick settings: only how selecting works, since that is what the bar
   * is for. Who answers is picked in the panel, next to the macros; keys,
   * macros and blocked sites live on the settings page, both because they
   * need more room and because this DOM belongs to the page.
   */
  private async buildSettings(): Promise<void> {
    const settings = await getSettings();
    const save = async (patch: Partial<Settings>) => {
      const current = await getSettings();
      await settingsItem.setValue({ ...current, ...patch });
    };

    this.settingsInner.append(
      field(
        'After drawing a box',
        [
          ['send', 'Send right away'],
          ['adjust', 'Let me adjust it first'],
        ],
        settings.adjustBox ? 'adjust' : 'send',
        (v) => void save({ adjustBox: v === 'adjust' }).catch(() => {}),
      ),
    );

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    more.textContent = 'All settings';
    more.addEventListener('click', () => void send({ type: 'options:open' }));
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

function unavailableTitle(kind: SelectionKind): string {
  // Only the browser's own PDF viewer takes modes away: it has no DOM to read.
  if (kind === 'text' || kind === 'element') return `${label(kind)} needs the PDF reader`;
  return `${label(kind)} doesn't work here`;
}

function label(kind: SelectionKind): string {
  return KIND_LABEL[kind];
}

