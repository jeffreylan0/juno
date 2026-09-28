/**
 * A small independent toast, outside the selection overlay's lifetime.
 *
 * Used for the one thing the background cannot do on its own: if Chrome
 * refuses to open the answer panel because the drag's user activation had
 * already lapsed, a click on this button is a fresh gesture in a page context,
 * which Chrome does accept.
 */
const STYLE = `
:host { all: initial; }
.toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  z-index: 2147483647; display: flex; align-items: center; gap: 10px;
  font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  color: var(--sai-hint-fg, #fff); background: var(--sai-hint-bg, rgba(15, 23, 42, 0.92));
  padding: 10px 14px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.34);
}
.toast button {
  font: inherit; font-size: 12px; cursor: pointer; border: 0; border-radius: 7px;
  padding: 5px 11px; background: var(--sai-accent, #3b82f6); color: #fff;
}
.toast .close { background: transparent; color: rgba(255, 255, 255, 0.6); padding: 4px 6px; }
`;

let current: HTMLElement | null = null;

export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** Shows a toast, replacing any previous one. Returns a dismiss function. */
export function showToast(text: string, action: ToastAction | null, autoHideMs = 0): () => void {
  dismissToast();
  const host = document.createElement('selection-ai-toast');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;

  const toast = document.createElement('div');
  toast.className = 'toast';
  const label = document.createElement('span');
  label.textContent = text;
  toast.append(label);

  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.onClick();
      dismissToast();
    });
    toast.append(button);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', dismissToast);
  toast.append(close);

  shadow.append(style, toast);
  document.documentElement.append(host);
  current = host;
  if (autoHideMs > 0) setTimeout(() => host === current && dismissToast(), autoHideMs);
  return dismissToast;
}

export function dismissToast(): void {
  current?.remove();
  current = null;
}
