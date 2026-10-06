/**
 * The yellow tooltip at the top of the page: a warning or a tip that fades in
 * from the top, stays a few seconds (longer while the pointer is on it), and
 * fades out. A small grey ✕ on the very left dismisses it early.
 *
 * One renderer, two places it is shown:
 *  - on the page itself (showPageTooltip), where the extension may run —
 *    the PDF viewer's limits, an extension update, an answer ready;
 *  - in a small popup under the toolbar icon (entrypoints/notice), for pages
 *    the extension cannot or must not touch (the browser's own pages, the
 *    extension stores, a blocked site) and the one-time pin prompt.
 *
 * Built from DOM nodes only: text is set as text, never parsed as markup.
 */

export interface TooltipAction {
  label: string;
  onClick: () => void;
  testid?: string;
}

export interface TooltipOptions {
  text: string;
  actions?: TooltipAction[];
  /** How long it stays, in ms; 0 keeps it until dismissed. Paused while hovered. */
  stayMs?: number;
  /** Called once it has gone, however it went. */
  onGone?: () => void;
  testid?: string;
}

export interface Tooltip {
  /** Fades it out now. */
  dismiss(): void;
  /** Replaces the text and actions (e.g. "Pinned"), keeping it on screen. */
  update(text: string, actions?: TooltipAction[], stayMs?: number): void;
  readonly el: HTMLElement;
}

export const TOOLTIP_STYLE = `
.sai-tip {
  box-sizing: border-box; display: flex; align-items: center; gap: 10px;
  max-width: min(560px, calc(100vw - 24px)); padding: 9px 12px 9px 8px;
  font: 500 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  color: var(--sai-tip-fg, #422006); background: var(--sai-tip-bg, #fef3c7);
  border: 1px solid var(--sai-tip-border, #f5d77a); border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
  animation: sai-tip-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.sai-tip.gone { animation: sai-tip-out 200ms ease-in forwards; }
.sai-tip-x {
  flex: none; display: flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0; border: 0; border-radius: 5px; cursor: pointer;
  background: transparent; color: #8a8a8a; font: inherit; font-size: 12px; line-height: 1;
}
.sai-tip-x:hover { color: #525252; background: rgba(0, 0, 0, 0.06); }
.sai-tip-text { flex: 1; min-width: 0; }
.sai-tip-actions { display: flex; gap: 6px; flex: none; }
.sai-tip-actions button {
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
  border: 1px solid #d6a92c; border-radius: 7px; padding: 4px 10px;
  color: #422006; background: rgba(255, 255, 255, 0.65);
}
.sai-tip-actions button:hover { background: #fff; }
@keyframes sai-tip-in { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: none; } }
@keyframes sai-tip-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-8px); } }
@media (prefers-reduced-motion: reduce) {
  .sai-tip { animation-duration: 1ms; }
  .sai-tip.gone { animation-duration: 1ms; }
}
`;

const DEFAULT_STAY_MS = 6000;
const WITH_ACTIONS_STAY_MS = 9000;
const OUT_MS = 200;

/** Builds a tooltip into `parent`. */
export function renderTooltip(parent: Node, opts: TooltipOptions): Tooltip {
  const el = document.createElement('div');
  el.className = 'sai-tip';
  el.setAttribute('role', 'status');
  if (opts.testid) el.setAttribute('data-testid', opts.testid);

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'sai-tip-x';
  x.textContent = '✕';
  x.title = 'Dismiss';
  x.setAttribute('aria-label', 'Dismiss');

  const text = document.createElement('span');
  text.className = 'sai-tip-text';
  const actions = document.createElement('span');
  actions.className = 'sai-tip-actions';
  el.append(x, text, actions);
  parent.appendChild(el);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stay = 0;
  let gone = false;

  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    el.classList.add('gone');
    setTimeout(() => {
      el.remove();
      opts.onGone?.();
    }, OUT_MS);
  };
  const arm = () => {
    clearTimeout(timer);
    if (stay > 0) timer = setTimeout(dismiss, stay);
  };

  const fill = (t: string, list: TooltipAction[] = [], stayMs?: number) => {
    text.textContent = t;
    actions.replaceChildren(
      ...list.map((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.label;
        if (a.testid) b.setAttribute('data-testid', a.testid);
        b.addEventListener('click', a.onClick);
        return b;
      }),
    );
    actions.hidden = list.length === 0;
    stay = stayMs ?? (list.length ? WITH_ACTIONS_STAY_MS : DEFAULT_STAY_MS);
    arm();
  };

  x.addEventListener('click', dismiss);
  // Reading it, or reaching for a button: it waits.
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', arm);
  fill(opts.text, opts.actions, opts.stayMs);

  return { dismiss, update: fill, el };
}

let current: { host: HTMLElement; tip: Tooltip } | null = null;

/**
 * Shows the tooltip at the top of the page, in its own shadow root so the
 * page's styles cannot reach it. One at a time: a new one replaces the last.
 */
export function showPageTooltip(opts: TooltipOptions): Tooltip {
  dismissPageTooltip(true);
  const host = document.createElement('selection-ai-tooltip');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `:host { all: initial; }
.wrap { position: fixed; top: 12px; left: 0; right: 0; z-index: 2147483647; display: flex; justify-content: center; pointer-events: none; }
.wrap > * { pointer-events: auto; }
${TOOLTIP_STYLE}`;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  shadow.append(style, wrap);
  document.documentElement.append(host);
  const tip = renderTooltip(wrap, {
    ...opts,
    onGone: () => {
      host.remove();
      if (current?.host === host) current = null;
      opts.onGone?.();
    },
  });
  current = { host, tip };
  return tip;
}

/** Takes the page's tooltip away (at once with `now`, else fading). */
export function dismissPageTooltip(now = false): void {
  if (!current) return;
  if (now) {
    current.host.remove();
    current = null;
  } else current.tip.dismiss();
}
