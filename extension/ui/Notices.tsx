/**
 * Notices, just above the macros: anything that would make the next answer
 * fail or be fake, said before the student asks rather than after. Placeholder
 * answers, no key, a rejected key, and the chosen AI being unreachable
 * ("Disconnected"); also the chat limit dropping an old chat, and why the
 * icon brought no bar on a page.
 *
 * Placeholder and no-key are known here at once. The rest come from the
 * background's check (lib/status.ts), shown only when it was made for the
 * choice currently picked.
 */
import type { Unreachable } from '@/lib/current';
import { BRAND } from '@/brand';
import type { AiStatus } from '@/lib/status';
import { answerChoiceOf, type Keys, type Settings } from '@/lib/storage';
import { Icon, type IconName } from './icons';

interface Action {
  label: string;
  onClick: () => void;
  testid?: string;
  busy?: boolean;
}

interface Notice {
  kind: string;
  icon: IconName;
  title?: string;
  text: string;
  actions: Action[];
  onDismiss?: () => void;
}

const WHO = { anthropic: 'Claude', openai: 'ChatGPT' } as const;
const openSettings = () => void browser.runtime.openOptionsPage();

export function Notices({
  settings,
  keys,
  status,
  checking,
  onRecheck,
  dropped,
  onDismissDropped,
  unreachable,
  onDismissUnreachable,
}: {
  settings: Settings | null;
  keys: Keys | null;
  status: AiStatus | null;
  checking: boolean;
  onRecheck: () => void;
  dropped: string[] | null;
  onDismissDropped: () => void;
  unreachable: Unreachable | null;
  onDismissUnreachable: () => void;
}) {
  const notices: Notice[] = [];
  if (unreachable) notices.push({ ...unreachableNotice(unreachable), onDismiss: onDismissUnreachable });
  const connection = settings && connectionNotice(settings, keys, status, checking, onRecheck);
  if (connection) notices.push(connection);
  if (dropped?.length && settings) {
    const limit = settings.chatLimit;
    notices.push({
      kind: 'dropped',
      icon: 'info',
      text:
        dropped.length === 1
          ? `You keep ${limit} chats, so the oldest, “${dropped[0]}”, was deleted.`
          : `You keep ${limit} chats, so the ${dropped.length} oldest were deleted.`,
      actions: [{ label: 'Keep more', onClick: openSettings, testid: 'notice-settings' }],
      onDismiss: onDismissDropped,
    });
  }
  if (!notices.length) return null;
  return (
    <div className="notices" role="status">
      {notices.map((n) => (
        <div key={n.kind} className="notice" data-testid="notice" data-kind={n.kind}>
          <Icon name={n.icon} className="notice-icon" />
          <div className="notice-body">
            <span className="notice-text">
              {n.title && <strong>{n.title}. </strong>}
              {n.text}
            </span>
            {n.actions.length > 0 && (
              <span className="notice-actions">
                {n.actions.map((a) => (
                  <button key={a.label} type="button" className="notice-action" data-testid={a.testid} disabled={a.busy} onClick={a.onClick}>
                    {a.busy ? 'Checking…' : a.label}
                  </button>
                ))}
              </span>
            )}
          </div>
          {n.onDismiss && (
            <button type="button" className="icon notice-dismiss" aria-label="Dismiss" title="Dismiss" onClick={n.onDismiss}>
              <Icon name="close" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Why the icon brought no bar on the page it was clicked on. */
function unreachableNotice(why: Unreachable): Notice {
  switch (why) {
    case 'restricted':
      return { kind: 'bar-restricted', icon: 'info', text: "The browser doesn't let extensions onto this page, so the selection bar can't open here.", actions: [] };
    case 'blocked-site':
      return {
        kind: 'bar-blocked-site',
        icon: 'info',
        text: `${BRAND.name} is off on this site: it is on your blocked sites.`,
        actions: [{ label: 'Settings', onClick: openSettings, testid: 'notice-settings' }],
      };
    case 'file-access':
      return {
        kind: 'bar-file-access',
        icon: 'info',
        text: `To select in files on this computer, turn on “Allow access to file URLs” for ${BRAND.name}, then click ${BRAND.iconName} again.`,
        actions: [
          {
            label: 'Open extension settings',
            // Extension pages may open the browser's own extension page for us.
            onClick: () => void browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` }),
          },
        ],
      };
  }
}

function connectionNotice(
  settings: Settings,
  keys: Keys | null,
  status: AiStatus | null,
  checking: boolean,
  onRecheck: () => void,
): Notice | null {
  if (settings.provider === 'mock') {
    return {
      kind: 'placeholder',
      icon: 'info',
      text: 'Placeholder answers — no AI is connected.',
      actions: [{ label: 'Connect Claude or ChatGPT', onClick: openSettings, testid: 'notice-settings' }],
    };
  }
  if (settings.provider === 'byok' && keys && !keys[settings.vendor].trim()) {
    return {
      kind: 'no-key',
      icon: 'warning',
      text: `No ${WHO[settings.vendor]} API key yet, so nothing can be asked.`,
      actions: [{ label: 'Add a key', onClick: openSettings, testid: 'notice-settings' }],
    };
  }
  if (!status || status.choice !== answerChoiceOf(settings) || status.state === 'ok' || status.state === 'placeholder') return null;

  const retry: Action = { label: 'Retry', onClick: onRecheck, testid: 'notice-retry', busy: checking };
  const fix: Action = { label: 'Settings', onClick: openSettings, testid: 'notice-settings' };
  switch (status.state) {
    case 'no-key':
      return { kind: 'no-key', icon: 'warning', text: status.message ?? 'No API key yet.', actions: [{ ...fix, label: 'Add a key' }] };
    case 'bad-key':
      return { kind: 'bad-key', icon: 'warning', text: status.message ?? 'The API key was rejected.', actions: [{ ...fix, label: 'Fix the key' }] };
    case 'disconnected':
      return {
        kind: 'disconnected',
        icon: 'unplugged',
        title: 'Disconnected',
        text: status.message ?? `Can't reach ${status.who}.`,
        actions: settings.provider === 'local' ? [retry, fix] : [retry],
      };
    case 'unavailable':
      return { kind: 'unavailable', icon: 'warning', text: status.message ?? 'Not available yet.', actions: [fix] };
    case 'error':
      return { kind: 'error', icon: 'warning', text: status.message ?? 'Something is wrong with the connection.', actions: [retry, fix] };
  }
}
