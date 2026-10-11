/**
 * The toolbar popup that carries the yellow tooltip (lib/tooltip.ts) where it
 * cannot go on the page: the browser's own pages, the extension stores, a
 * blocked site, files without access, and the one-time prompt to pin the
 * icon. The background opens it with action.openPopup() and says which one
 * in the query string (`?kind=`). It closes itself when the tooltip fades.
 */
import { BRAND } from '@/brand';
import { send } from '@/lib/messages';
import { TOOLTIP_STYLE, renderTooltip, type TooltipOptions } from '@/lib/tooltip';

/** Clicks on the icon go back to bringing up the bar. */
void browser.action.setPopup({ popup: '' }).catch(() => {});

const kind = new URL(location.href).searchParams.get('kind');
const close = () => window.close();

const style = document.createElement('style');
style.textContent = `
html, body { margin: 0; background: var(--sai-tip-bg, #30302e); }
body { width: 360px; }
#root .sai-tip { max-width: none; border: 0; border-radius: 0; box-shadow: none; padding: 12px 14px 12px 10px; }
${TOOLTIP_STYLE}`;
document.head.append(style);
const root = document.getElementById('root')!;

const NOTICES: Record<string, TooltipOptions> = {
  restricted: { text: "Selections don't work on this page." },
  'blocked-site': {
    text: `${BRAND.name} is off on this site.`,
    actions: [{ label: 'Change', onClick: () => void browser.runtime.openOptionsPage().then(close) }],
  },
  'file-access': {
    text: 'To select in files on your computer, allow file access.',
    actions: [
      {
        label: 'Allow',
        // Extension pages may open the browser's own page for this extension.
        onClick: () => void browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` }).then(close),
      },
    ],
  },
  pinned: { text: `Pinned. Click it any time to select.`, stayMs: 2500 },
};

if (kind === 'pin') {
  const tip = renderTooltip(root, {
    text: `Pin ${BRAND.name} so it's always one click away.`,
    stayMs: 20_000,
    testid: 'pin-tip',
    actions: [
      {
        label: 'Show me how',
        testid: 'pin-how',
        onClick: () => {
          tip.update('Click the puzzle piece 🧩 at the top right, then the pin 📌 next to ' + BRAND.name + '.', [], 0);
          // Clicking the puzzle piece closes this popup; the background
          // watches for the pin and says so from the icon itself.
          void send({ type: 'pin:watch' });
        },
      },
    ],
    onGone: close,
  });
} else {
  renderTooltip(root, { ...(NOTICES[kind ?? ''] ?? NOTICES.restricted!), testid: `notice-${kind}`, onGone: close });
}
