/**
 * The bar: one quiet row in the manner of Claude's quick entry, only as wide
 * as its controls. A ✕ that finishes the chat (the bar and the panel close),
 * the selection modes in the middle as one segmented control, then the chats
 * (the panel, open on its list), the ghost (the next selection starts a
 * temporary chat) and a gear that expands the bar into a short settings
 * menu, and Send, when selections wait for it (the setting). While the panel
 * shows, the chats, ghost and gear are the panel's, and leave the bar. The
 * instruction shows above the row only when it adds something (a selection
 * to adjust, a warning); the cursor tooltip says the rest. A note the app
 * needs to give (a permission) attaches under the row. Every control has a
 * small tooltip that comes up after a moment.
 *
 * The bar stays up for as long as it is wanted: while selecting, while a
 * selection is sent, and between selections, when nothing is armed and the
 * app beneath works normally (wm.rs lets the pointer through), and a chip
 * starts the next selection. It sits at the edge of the screen the student
 * picked in settings (`place`), inside the menu bar, Dock or taskbar
 * (`--sai-inset-*`, from the overlay's display).
 */
import type { SelectionKind } from '@shared/payload';
import { ICON_PATHS, svgIcon } from '@/lib/icons';
import { KIND_ICON as ICONS, KIND_LABEL, KIND_ORDER } from '@/lib/kinds';
import { getSettings, settingsItem, type Settings } from '@/lib/storage';

/** Marks the app's own controls, which a selection never starts on. */
export const UI_ATTR = 'data-sai-ui';

/** Where on the screen the bar (or the panel) goes: a row and a column of a 3×3 grid. */
export type Place = `${'top' | 'middle' | 'bottom'}-${'left' | 'center' | 'right'}`;

export const BAR_STYLE = `
.bar {
  position: fixed; box-sizing: border-box; display: flex; flex-direction: column; max-width: calc(100vw - 32px);
  font: 400 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  color: var(--sai-bar-fg, #f5f4ef); background: var(--sai-bar-bg, #30302e);
  border: 1px solid var(--sai-bar-line, rgba(222, 220, 209, 0.14)); border-radius: 18px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.34), 0 2px 8px rgba(0, 0, 0, 0.2);
  pointer-events: auto; overflow: hidden;
  /* Bottom middle unless the student picked another place. */
  left: 50%; bottom: calc(var(--sai-inset-bottom, 8px) + 20px); transform: translateX(-50%);
}
.bar[data-place$='-left'] { left: calc(var(--sai-inset-left, 0px) + 20px); transform: none; }
.bar[data-place$='-right'] { left: auto; right: calc(var(--sai-inset-right, 0px) + 20px); transform: none; }
.bar[data-place^='top-'] { bottom: auto; top: calc(var(--sai-inset-top, 0px) + 20px); }
.bar[data-place^='middle-'] { bottom: auto; top: 50%; transform: translateY(-50%); }
.bar[data-place='top-center'] { transform: translateX(-50%); }
.bar[data-place='middle-center'] { transform: translate(-50%, -50%); }
/* A note or the settings widen the bar while open. */
.bar.wide { width: min(460px, calc(100vw - 32px)); }
.bar button { font: inherit; }
/* ✕ | the modes, centred | chats, ghost, gear: equal outer columns keep the
   modes in the middle. While the panel has the chats, ghost and gear (and
   Send is not shown), the row is just ✕ and the modes, evenly padded. */
.row { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 6px; min-height: 52px; box-sizing: border-box; padding: 8px; }
.start { justify-self: start; display: flex; }
.end { justify-self: end; display: flex; align-items: center; gap: 2px; }
.bar.panel-open .chats, .bar.panel-open .ghost, .bar.panel-open .gear { display: none; }
.bar.panel-open:not(:has(.ask.on)) .row { grid-template-columns: auto auto; }
.bar.panel-open:not(:has(.ask.on)) .end { display: none; }
/* Quiet round controls: the close on the left, chats, ghost and gear on the right. */
.close, .chats, .gear, .ghost {
  display: flex; align-items: center; justify-content: center; flex: none;
  width: 32px; height: 32px; padding: 0; border: 0; border-radius: 9px; cursor: pointer;
  background: transparent; color: var(--sai-bar-muted, #a6a39b);
}
.close:hover, .chats:hover, .gear:hover, .gear[aria-expanded='true'], .ghost:hover { color: var(--sai-bar-fg, #f5f4ef); background: rgba(255, 255, 255, 0.08); }
.ghost[aria-pressed='true'], .ghost[aria-pressed='true']:hover { color: var(--sai-bar-fg, #f5f4ef); background: rgba(255, 255, 255, 0.14); }
.close svg, .chats svg, .gear svg, .ghost svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.close svg { width: 16px; height: 16px; }
/* The instruction, above the row, when it adds something. What could be wide
   (it, a note, the settings) never sets the bar's width: width 0, at least the bar's. */
.say, .note, .settings { width: 0; min-width: 100%; box-sizing: border-box; }
.say {
  display: none; padding: 10px 14px 0; font-size: 13px; text-align: center; color: var(--sai-bar-muted, #a6a39b);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.say.loud:not(.gone) { display: block; }
/* The modes: one segmented control, icons only; the chosen one shows its name. */
.chips { display: flex; gap: 2px; flex: none; padding: 2px; border-radius: 11px; background: rgba(255, 255, 255, 0.06); }
.chip {
  display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; cursor: pointer;
  font-size: 13px; font-weight: 500; color: var(--sai-bar-muted, #a6a39b); background: transparent; border: 0; border-radius: 9px;
}
.chip:hover { color: var(--sai-bar-fg, #f5f4ef); background: rgba(255, 255, 255, 0.06); }
.chip .label { display: none; }
/* After the hover rule, so hovering the chosen mode keeps it as it is. */
.chip[aria-pressed='true'], .chip[aria-pressed='true']:hover { color: var(--sai-bar-fg, #f5f4ef); background: rgba(255, 255, 255, 0.14); padding: 0 11px 0 9px; }
.chip[aria-pressed='true'] .label { display: inline; }
.chip-slot { display: flex; }
/* Lets the pointer through to its wrapper, which carries the tooltip. */
.chip svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
/* Send: shown when selections wait to be sent (the setting), ready once one is drawn. */
.ask {
  display: none; align-items: center; justify-content: center; flex: none; margin-left: 4px;
  width: 32px; height: 32px; padding: 0; border: 0; border-radius: 9px; cursor: pointer;
  background: var(--sai-accent, #d97757); color: #fff;
}
.ask.on { display: flex; }
.ask:hover:not(:disabled) { background: var(--sai-accent-hover, #c6613f); }
.ask:disabled { opacity: 0.4; cursor: default; }
.ask svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.bar :focus-visible { outline: 2px solid var(--sai-accent, #d97757); outline-offset: 1px; }
/* Taken out of the screenshot when the selection runs under it; back right after. */
.bar.out-of-shot { visibility: hidden; }

/* Something the student should know or do (a permission, say), attached under the row. */
.note { display: none; align-items: center; gap: 14px; padding: 12px 12px 12px 18px; border-top: 1px solid var(--sai-bar-line, rgba(222, 220, 209, 0.14)); }
.note.on { display: flex; }
.note-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.note-title { font-size: 14px; font-weight: 600; }
.note-sub { font-size: 13px; color: var(--sai-bar-muted, #a6a39b); }
.note-actions { display: flex; gap: 8px; flex: none; }
.note-actions button {
  font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer; padding: 7px 12px; border-radius: 9px;
  color: var(--sai-bar-fg, #f5f4ef); background: rgba(255, 255, 255, 0.06); border: 1px solid var(--sai-bar-line, rgba(222, 220, 209, 0.14));
}
.note-actions button:hover { background: rgba(255, 255, 255, 0.12); }
.note-actions button.primary { color: #1f1e1d; background: #f5f4ef; border-color: transparent; }
.note-actions button.primary:hover { background: #fff; }

/* The quick settings, opened by the gear. */
.settings {
  max-height: 0; overflow-y: auto; overscroll-behavior: contain;
  transition: max-height 220ms ease;
  border-top: 1px solid transparent;
}
.settings.open { max-height: min(46vh, 340px); border-top-color: var(--sai-bar-line, rgba(222, 220, 209, 0.14)); }
.settings-inner { display: flex; flex-direction: column; gap: 12px; padding: 14px 18px 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field > span { font-size: 12px; color: var(--sai-bar-muted, #a6a39b); }
.field select {
  font: inherit; font-size: 13px; padding: 7px 30px 7px 10px; border-radius: 9px; cursor: pointer;
  color: var(--sai-bar-fg, #f5f4ef); background-color: rgba(255, 255, 255, 0.06); border: 1px solid var(--sai-bar-line, rgba(222, 220, 209, 0.14));
  /* The native arrow sits hard against the edge and ignores our padding. */
  -webkit-appearance: none; -moz-appearance: none; appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23a6a39b' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center; background-size: 12px 12px;
}
.field select::-ms-expand { display: none; }
.field select option { color: #1f1e1d; background: #fff; }
.more {
  align-self: flex-start; font-size: 13px; cursor: pointer;
  border: 0; background: none; padding: 0; color: var(--sai-bar-muted, #a6a39b); text-decoration: underline; text-underline-offset: 2px;
}
.more:hover { color: var(--sai-bar-fg, #f5f4ef); }

/* Small light tooltips: they come up after the pointer rests a moment. */
.hint {
  position: fixed; left: 0; top: 0; z-index: 1; pointer-events: none; white-space: nowrap; box-sizing: border-box;
  max-width: min(360px, calc(100vw - 16px)); overflow: hidden; text-overflow: ellipsis;
  font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  color: var(--sai-hint-fg, #1f1e1d); background: var(--sai-hint-bg, #f5f4ef);
  padding: 5px 8px; border-radius: 7px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28), 0 0 0 0.5px rgba(0, 0, 0, 0.12);
  opacity: 0; visibility: hidden; transition: opacity 120ms ease, visibility 0s linear 120ms;
}
.hint.on { opacity: 1; visibility: visible; transition: opacity 120ms ease; }
@media (prefers-reduced-motion: reduce) { .settings, .hint, .hint.on { transition: none; } }
`;

/** Shown while a drawn box waits to be adjusted and sent (Send, or Enter). */
export const ADJUST_HINT = 'Adjust the edges, then send';

/** Shown while a drawn outline waits to be sent. */
export const REDRAW_HINT = 'Draw again to redo, or send';

/** Between selections: nothing armed, the page is the student's. */
export const READY_HINT = 'Pick a mode to select';

const MODE_HINT: Record<SelectionKind, string> = {
  box: 'Drag over an area',
  freeform: 'Draw around it',
};

const GHOST_OFF = 'Temporary chat';
const GHOST_OFF_LONG = "Temporary chat (next selection isn't saved)";
const GHOST_ON = 'Leave temporary chat';
const GHOST_ON_LONG = 'Temporary chat is on. Click to leave (deletes it)';

/** How long the pointer rests on a control before its tooltip comes up. */
export const HINT_DELAY_MS = 500;
/** Moving straight on to the next control within this long shows its tooltip at once. */
const HINT_WARM_MS = 400;

/**
 * Send's three looks: `off` when a selection sends as soon as it is drawn,
 * `waiting` (dimmed) until there is one to send, `ready` once there is.
 */
export type SubmitState = 'off' | 'waiting' | 'ready';

/** A note attached under the bar's row, such as a permission the app still needs. */
export interface BarNotice {
  id: string;
  title: string;
  text?: string;
  actions: { label: string; onClick: () => void; primary?: boolean; testid?: string }[];
}

export interface BarHandlers {
  /** The ✕: finishes the chat, which closes the bar and the answer panel. */
  onClose: () => void;
  /** Send, shown while selections wait to be sent. */
  onConfirm: () => void;
  onModeChange: (kind: SelectionKind) => void;
  /** The ghost, pressed. */
  onGhost: () => void;
  /** The chats button: the panel, open on its list of chats. */
  onChats: () => void;
}

export class Bar {
  readonly el: HTMLElement;
  /** The tooltip; the overlay puts it beside the bar, since the bar clips what overflows it. */
  readonly hintEl: HTMLElement;
  private say: HTMLElement;
  private note: HTMLElement;
  private settings: HTMLElement;
  private settingsInner: HTMLElement;
  private gear: HTMLButtonElement;
  private ghost: HTMLButtonElement;
  private ask: HTMLButtonElement;
  private chips = new Map<SelectionKind, HTMLButtonElement>();
  private settingsBuilt = false;
  private drawing = false;
  private adjusting = false;
  /** The mode being selected in, or null while the bar waits between selections. */
  private kind: SelectionKind | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private hintFor: HTMLElement | null = null;
  private hintGoneAt = 0;

  constructor(private handlers: BarHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'bar';
    this.el.setAttribute(UI_ATTR, 'bar');

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'hint';
    this.hintEl.setAttribute('role', 'tooltip');
    this.hintEl.setAttribute(UI_ATTR, 'hint');

    this.settings = document.createElement('div');
    this.settings.className = 'settings';
    this.settingsInner = document.createElement('div');
    this.settingsInner.className = 'settings-inner';
    this.settings.append(this.settingsInner);

    this.note = document.createElement('div');
    this.note.className = 'note';
    this.note.setAttribute('data-testid', 'bar-notice');

    const row = document.createElement('div');
    row.className = 'row';

    const close = this.button('close', 'Close', 'Done (closes the bar and panel)', svgIcon(ICON_PATHS.close));
    close.addEventListener('click', () => this.handlers.onClose());

    this.say = document.createElement('span');
    this.say.className = 'say';
    this.say.textContent = this.hint();

    this.ask = this.button('ask', 'Send (Enter)', 'Send this selection (Enter)', svgIcon(ICON_PATHS.send));
    this.ask.addEventListener('click', () => this.handlers.onConfirm());

    this.ghost = this.button('ghost', GHOST_OFF, GHOST_OFF_LONG, svgIcon(ICON_PATHS.ghost));
    this.ghost.addEventListener('click', () => this.handlers.onGhost());
    this.setGhost(false);

    this.gear = this.button('gear', 'Settings', 'Settings', svgIcon(ICON_PATHS.gear));
    this.gear.setAttribute('aria-expanded', 'false');
    this.gear.addEventListener('click', () => void this.toggleSettings());

    const chats = this.button('chats', 'Chats', 'Your chats', svgIcon(ICON_PATHS.menu));
    chats.addEventListener('click', () => this.handlers.onChats());

    const start = document.createElement('div');
    start.className = 'start';
    start.append(close);
    const end = document.createElement('div');
    end.className = 'end';
    end.append(chats, this.ghost, this.gear, this.ask);
    row.append(start, this.buildChips(), end);
    // The instruction above the row, when it shows (it is "loud").
    this.el.append(this.say, row, this.note, this.settings);
  }

  /** Where on the screen the bar sits (the setting). */
  setPlace(place: Place): void {
    this.el.dataset.place = place;
  }

  /** The panel is open: the ghost, settings and chats are on it, not here. */
  setPanelOpen(open: boolean): void {
    this.el.classList.toggle('panel-open', open);
    if (!open) return;
    this.closeSettings();
    if (this.hintFor && this.hintFor.offsetParent === null) this.hideHint();
  }

  /** Which mode is being selected in; null while the bar waits. */
  setKind(kind: SelectionKind | null): void {
    this.kind = kind;
    for (const [k, chip] of this.chips) chip.setAttribute('aria-pressed', String(k === kind));
    this.resetInstruction();
  }

  /** Whether the next selection goes into a temporary chat. */
  setGhost(on: boolean): void {
    this.ghost.setAttribute('aria-pressed', String(on));
    this.ghost.dataset.hint = on ? GHOST_ON : GHOST_OFF;
    this.ghost.setAttribute('aria-label', on ? GHOST_ON_LONG : GHOST_OFF_LONG);
  }

  /** Hides the instruction while a selection is actually being drawn. */
  setDrawing(drawing: boolean): void {
    this.drawing = drawing;
    this.say.classList.toggle('gone', drawing);
    if (drawing) {
      this.closeSettings();
      this.hideHint();
    }
  }

  /** A selection is drawn and waiting: say how to adjust and send it. */
  setAdjusting(adjusting: boolean): void {
    this.adjusting = adjusting;
    this.resetInstruction();
  }

  /** Send's look (see SubmitState). */
  setSubmit(state: SubmitState): void {
    this.ask.classList.toggle('on', state !== 'off');
    this.ask.disabled = state !== 'ready';
    if (state === 'off' && this.hintFor === this.ask) this.hideHint();
  }

  /** Attaches a note under the row, or (null) takes it away. */
  setNotice(notice: BarNotice | null): void {
    this.note.replaceChildren();
    this.note.classList.toggle('on', !!notice);
    this.widen();
    if (!notice) {
      this.note.removeAttribute('data-id');
      return;
    }
    this.note.dataset.id = notice.id;
    const text = document.createElement('div');
    text.className = 'note-text';
    const title = document.createElement('span');
    title.className = 'note-title';
    title.textContent = notice.title;
    text.append(title);
    if (notice.text) {
      const sub = document.createElement('span');
      sub.className = 'note-sub';
      sub.textContent = notice.text;
      text.append(sub);
    }
    const actions = document.createElement('div');
    actions.className = 'note-actions';
    for (const a of notice.actions) {
      const b = document.createElement('button');
      b.type = 'button';
      if (a.primary) b.className = 'primary';
      if (a.testid) b.setAttribute('data-testid', a.testid);
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      actions.append(b);
    }
    this.note.append(text, actions);
  }

  private hint(): string {
    if (this.adjusting) return this.kind === 'freeform' ? REDRAW_HINT : ADJUST_HINT;
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
    this.say.classList.toggle('loud', !!text);
  }

  resetInstruction(): void {
    this.say.textContent = this.hint();
    // What to do next the cursor tooltip says; adjusting is worth saying here.
    this.say.classList.toggle('loud', this.adjusting);
  }

  /** The bar widens while a note or the settings need the room. */
  private widen(): void {
    this.el.classList.toggle('wide', this.note.classList.contains('on') || this.settings.classList.contains('open'));
  }

  /** A quiet icon button with a short tooltip (`hint`) and a fuller name for screen readers. */
  private button(className: string, hint: string, label: string, icon: SVGSVGElement): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.setAttribute('aria-label', label);
    b.append(icon);
    this.withHint(b, hint);
    return b;
  }

  /**
   * The tooltip comes up once the pointer has rested on `el` a moment, and
   * at once when moving straight on from another control's, like the
   * system's own. A press, or leaving, takes it away.
   */
  private withHint(el: HTMLElement, hint: string): void {
    el.dataset.hint = hint;
    el.addEventListener('pointerenter', () => {
      clearTimeout(this.hintTimer);
      const warm = Date.now() - this.hintGoneAt < HINT_WARM_MS;
      this.hintTimer = setTimeout(() => this.showHint(el), warm ? 0 : HINT_DELAY_MS);
    });
    el.addEventListener('pointerleave', () => this.hideHint());
    el.addEventListener('pointerdown', () => this.hideHint());
  }

  private showHint(el: HTMLElement): void {
    const text = el.dataset.hint;
    if (!text || !el.isConnected || this.drawing) return;
    this.hintFor = el;
    const hint = this.hintEl;
    hint.textContent = text;
    // Measured where it is, then centred above the control, inside the viewport.
    const r = el.getBoundingClientRect();
    const w = hint.offsetWidth;
    const h = hint.offsetHeight;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
    const top = r.top - h - 8 >= 4 ? r.top - h - 8 : r.bottom + 8;
    hint.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    hint.classList.add('on');
  }

  private hideHint(): void {
    clearTimeout(this.hintTimer);
    this.hintTimer = undefined;
    if (this.hintEl.classList.contains('on')) this.hintGoneAt = Date.now();
    this.hintEl.classList.remove('on');
    this.hintFor = null;
  }

  private buildChips(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'chips';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Selection mode');
    for (const kind of KIND_ORDER) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.kind = kind;
      chip.setAttribute('aria-pressed', 'false');
      const name = document.createElement('span');
      name.className = 'label';
      name.textContent = label(kind);
      chip.append(svgIcon(ICONS[kind]), name);
      chip.setAttribute('aria-label', label(kind));
      chip.addEventListener('click', () => kind !== this.kind && this.handlers.onModeChange(kind));
      const slot = document.createElement('span');
      slot.className = 'chip-slot';
      slot.append(chip);
      this.withHint(slot, label(kind));
      this.chips.set(kind, chip);
      wrap.append(slot);
    }
    return wrap;
  }

  private closeSettings(): void {
    this.settings.classList.remove('open');
    this.gear.setAttribute('aria-expanded', 'false');
    this.widen();
  }

  private async toggleSettings(): Promise<void> {
    if (this.settings.classList.contains('open')) return this.closeSettings();
    if (!this.settingsBuilt) {
      await this.buildSettings();
      this.settingsBuilt = true;
    }
    this.settings.classList.add('open');
    this.gear.setAttribute('aria-expanded', 'true');
    this.widen();
  }

  /**
   * The quick settings: only how selecting works, since that is what the bar
   * is for. Who answers is picked in the panel, next to the macros; keys
   * and macros are on the settings page, which has the room.
   */
  private async buildSettings(): Promise<void> {
    const settings = await getSettings();
    const save = async (patch: Partial<Settings>) => {
      const current = await getSettings();
      await settingsItem.setValue({ ...current, ...patch });
    };

    this.settingsInner.append(
      field(
        'After drawing a selection',
        [
          ['send', 'Send right away'],
          ['adjust', 'Let me adjust it first, then press ↑'],
        ],
        settings.adjustBox ? 'adjust' : 'send',
        (v) => void save({ adjustBox: v === 'adjust' }).catch(() => {}),
      ),
    );

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    more.textContent = 'All settings';
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
  return KIND_LABEL[kind];
}
