/**
 * Notices, just above the macros: anything that would make the next answer
 * fail, said before the student asks rather than after. No AI picked yet,
 * no key, a rejected key, and the chosen AI being unreachable
 * ("Disconnected"); also the chat limit dropping an old chat.
 *
 * No AI and no key are known here at once. The rest come from the
 * core's check (lib/status.ts), shown only when it was made for the
 * choice currently picked.
 *
 * With `lasts` (the app), each notice goes by itself after that long: a ring
 * round its ✕ runs down meanwhile, and pointing at the notice holds it. Gone,
 * it stays gone while it says the same thing (the panel brings notices back
 * with each new chat, and each time the app shows it).
 *
 * Settings → Selecting → *Notices in the panel* turns them all off; the very
 * first notice says where, under it.
 */
import { useEffect, useState } from 'react';
import { ASSISTANT } from '@/lib/router';
import type { AiStatus } from '@/lib/status';
import type { KeyStatus } from '@/lib/providers/types';
import { answerChoiceOf, defineItem, type Settings } from '@/lib/storage';
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

const openSettings = () => void browser.runtime.openOptionsPage();
/** Settings, at the Account section. */
const openAccount = () => void browser.runtime.openOptionsPage('account');

/** Whether the first notice, and how to turn notices off, has been shown. */
const tipItem = defineItem<boolean>('noticeTipShown', false);

function useTipShown(): boolean | null {
  const [shown, setShown] = useState<boolean | null>(null);
  useEffect(() => {
    void tipItem.getValue().then(setShown, () => setShown(true));
    return tipItem.watch(setShown);
  }, []);
  return shown;
}

export function Notices({
  lasts = null,
  settings,
  keys,
  status,
  checking,
  onRecheck,
  dropped,
  onDismissDropped,
}: {
  /** How long each notice stays, or null: until dealt with. */
  lasts?: number | null;
  settings: Settings | null;
  keys: KeyStatus | null;
  status: AiStatus | null;
  checking: boolean;
  onRecheck: () => void;
  dropped: string[] | null;
  onDismissDropped: () => void;
}) {
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const tipShown = useTipShown();
  let notices: Notice[] = [];
  const connection = settings && connectionNotice(settings, keys, status, checking, onRecheck);
  if (connection) notices.push(connection);
  if (dropped?.length && settings) {
    notices.push({
      kind: 'dropped',
      icon: 'info',
      text:
        dropped.length === 1
          ? `Deleted your oldest chat, “${dropped[0]}”.`
          : `Deleted your ${dropped.length} oldest chats.`,
      actions: [{ label: 'Keep more', onClick: openSettings, testid: 'notice-settings' }],
      onDismiss: onDismissDropped,
    });
  }
  const said = (n: Notice) => `${n.kind}:${n.title ?? ''}:${n.text}`;
  const dismiss = (n: Notice) => {
    if (lasts) setGone((g) => new Set(g).add(said(n)));
    if (tipShown === false) void tipItem.setValue(true);
    n.onDismiss?.();
  };
  if (lasts) notices = notices.filter((n) => !gone.has(said(n)));
  if (!notices.length || settings?.panelNotices === false) return null;
  return (
    <div className="notices" role="status">
      {notices.map((n, i) => (
        <div key={said(n)} className="notice" data-testid="notice" data-kind={n.kind}>
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
            {tipShown === false && i === 0 && (
              <button
                type="button"
                className="notice-tip"
                data-testid="notice-tip"
                onClick={() => {
                  void tipItem.setValue(true);
                  void browser.runtime.openOptionsPage('notices');
                }}
              >
                Turn notices off
              </button>
            )}
          </div>
          {(lasts || n.onDismiss) && (
            <button type="button" className={`icon notice-dismiss${lasts ? ' timed' : ''}`} aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(n)}>
              {lasts && (
                <svg className="notice-timer" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="10.5" pathLength={100} style={{ animationDuration: `${lasts}ms` }} onAnimationEnd={() => dismiss(n)} />
                </svg>
              )}
              <Icon name="close" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function connectionNotice(
  settings: Settings,
  keys: KeyStatus | null,
  status: AiStatus | null,
  checking: boolean,
  onRecheck: () => void,
): Notice | null {
  if (settings.provider === 'mock') {
    return {
      kind: 'unset',
      icon: 'info',
      text: 'Pick who answers.',
      actions: [{ label: 'Set up', onClick: openSettings, testid: 'notice-settings' }],
    };
  }
  if (settings.provider === 'byok' && keys && !keys[settings.vendor]) {
    return {
      kind: 'no-key',
      icon: 'warning',
      text: `Add a ${ASSISTANT[settings.vendor]} API key.`,
      actions: [{ label: 'Add a key', onClick: openSettings, testid: 'notice-settings' }],
    };
  }
  if (!status || status.choice !== answerChoiceOf(settings) || status.state === 'ok' || status.state === 'unset') return null;

  const retry: Action = { label: 'Retry', onClick: onRecheck, testid: 'notice-retry', busy: checking };
  const fix: Action = { label: 'Settings', onClick: openSettings, testid: 'notice-settings' };
  // Hosted answers have no key: what is missing is a sign-in.
  const hosted = settings.provider === 'gateway';
  switch (status.state) {
    case 'no-key':
      return { kind: 'no-key', icon: 'warning', text: status.message ?? 'No API key yet.', actions: [hosted ? { ...fix, label: 'Sign in', onClick: openAccount } : { ...fix, label: 'Add a key' }] };
    case 'bad-key':
      return {
        kind: 'bad-key',
        icon: 'warning',
        text: status.message ?? 'That API key was rejected.',
        actions: [hosted ? { ...fix, label: 'Sign in', onClick: openAccount } : { ...fix, label: 'Fix it' }],
      };
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
      return { kind: 'error', icon: 'warning', text: status.message ?? 'Something went wrong with the connection.', actions: [retry, fix] };
  }
}
