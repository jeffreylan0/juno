/**
 * The panel: one conversation per tab. It follows whichever tab is active in
 * its window, renders that tab's thread from storage.session, and sends
 * questions to the background, which owns the conversation and streams the
 * answer back into storage.
 *
 * The selection is the conversation's opening attachment. It sits above the
 * composer until the first question is sent, then lives inside that first
 * message; every later question is a follow-up on the same selection.
 *
 * Runs in the Chrome/Edge side panel, the Firefox sidebar, and (from week 12)
 * inside the Safari in-page overlay.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Mode, ModelRef, Plan } from '@shared/payload';
import { MODES } from '@shared/payload';
import { getSettings, settingsItem, type Settings } from '@/lib/storage';
import { chatKey, getThread, selKey, type Chat } from '@/lib/threads';
import { Answer } from './Answer';
import { SelectionCard } from './Selection';

const MODE_LABEL: Record<Mode, string> = { explain: 'Explain', hint: 'Hint', check: 'Check' };

/**
 * `?tabId=N` pins the panel to one tab. Tests use it, since they open the
 * panel as a tab of its own, and it leaves room for per-tab panels later.
 */
function pinnedTabId(): number | null {
  const raw = new URL(location.href).searchParams.get('tabId');
  return raw ? Number(raw) : null;
}

/** Tracks the tab this panel should show: pinned, or the active tab in its window. */
function useCurrentTab(): number | null {
  const [tabId, setTabId] = useState<number | null>(pinnedTabId());
  useEffect(() => {
    if (pinnedTabId() !== null) return;
    let windowId: number | undefined;
    let cancelled = false;
    void (async () => {
      const win = await browser.windows.getCurrent();
      windowId = win.id;
      const [tab] = await browser.tabs.query({ active: true, windowId });
      if (!cancelled && tab?.id !== undefined) setTabId(tab.id);
    })();
    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (windowId === undefined || info.windowId === windowId) setTabId(info.tabId);
    };
    browser.tabs.onActivated.addListener(onActivated);
    return () => {
      cancelled = true;
      browser.tabs.onActivated.removeListener(onActivated);
    };
  }, []);
  return tabId;
}

/** The stored thread for a tab, kept live by storage change events. */
function useThread(tabId: number | null): { plan: Plan | null; chat: Chat | null } {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  useEffect(() => {
    setPlan(null);
    setChat(null);
    if (tabId === null) return;
    let live = true;
    void getThread(tabId).then((t) => {
      if (!live) return;
      setPlan(t.plan);
      setChat(t.chat);
    });
    const onChanged = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      if (areaName !== 'session') return;
      if (selKey(tabId) in changes) setPlan((changes[selKey(tabId)]!.newValue as Plan | undefined) ?? null);
      if (chatKey(tabId) in changes) setChat((changes[chatKey(tabId)]!.newValue as Chat | undefined) ?? null);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, [tabId]);
  return { plan, chat };
}

export function Panel() {
  const tabId = useCurrentTab();
  const { plan, chat } = useThread(tabId);
  const [settings, setSettings] = useState<Settings | null>(null);
  /** Unsent drafts per tab, so switching tabs does not lose what you typed. */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  /** Plans already prefilled, so a stored thread is not re-prefilled on every render. */
  const prefilled = useRef(new Set<string>());
  const threadRef = useRef<HTMLDivElement>(null);

  const turns = chat?.planId === plan?.id ? (chat?.turns ?? []) : [];
  const mode: Mode = (chat?.planId === plan?.id ? chat?.mode : undefined) ?? plan?.mode ?? settings?.defaultMode ?? 'explain';
  const busy = turns.some((t) => t.streaming);
  const draft = tabId !== null ? (drafts[tabId] ?? '') : '';
  const started = turns.length > 0;

  useEffect(() => {
    // Clears the toolbar badge the background sets when it could not open us.
    void browser.runtime.sendMessage({ type: 'panel:ready' }).catch(() => {});
    void getSettings().then(setSettings);
    const unwatch = settingsItem.watch(() => void getSettings().then(setSettings));

    // The bar's X closes everything. Chrome has no sidePanel.close(), but a
    // side panel document may close its own window.
    let windowId: number | undefined;
    void browser.windows.getCurrent().then((w) => (windowId = w.id));
    const onMessage = (raw: unknown) => {
      const msg = raw as { type?: string; windowId?: number };
      if (msg?.type !== 'panel:close') return;
      if (msg.windowId !== undefined && windowId !== undefined && msg.windowId !== windowId) return;
      window.close();
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => {
      unwatch();
      browser.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  const setDraft = useCallback(
    (text: string) => {
      if (tabId === null) return;
      setDrafts((d) => ({ ...d, [tabId]: text }));
    },
    [tabId],
  );

  // A fresh selection puts the mode's saved prompt in the box, ready to edit.
  // (Sending straight away, when the settings ask for it, is the background's job.)
  useEffect(() => {
    if (!plan || !settings || tabId === null) return;
    if (prefilled.current.has(plan.id) || started) return;
    prefilled.current.add(plan.id);
    setDraft(settings.prompts[mode] ?? '');
  }, [plan, settings, tabId, started, mode, setDraft]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [turns.length, turns[turns.length - 1]?.text]);

  const send = useCallback(() => {
    if (!plan || tabId === null || busy) return;
    void browser.runtime.sendMessage({ type: 'chat:send', tabId, question: draft, mode });
    setDraft('');
  }, [plan, tabId, busy, draft, mode, setDraft]);

  const stop = useCallback(() => {
    if (tabId !== null) void browser.runtime.sendMessage({ type: 'chat:stop', tabId });
  }, [tabId]);

  const changeMode = useCallback(
    (m: Mode) => {
      if (tabId === null) return;
      void browser.runtime.sendMessage({ type: 'chat:mode', tabId, mode: m });
      // Before anything is sent, the box still holds the old mode's prompt;
      // swap it for the new one unless the student has already edited it.
      if (!started && settings && draft === (settings.prompts[mode] ?? '')) setDraft(settings.prompts[m] ?? '');
    },
    [tabId, started, settings, draft, mode, setDraft],
  );

  const placeholder = useMemo(() => {
    if (!plan) return 'Select something on the page first';
    return started ? 'Ask a follow-up…' : `Ask about the selection, then ${MODE_LABEL[mode]}`;
  }, [plan, started, mode]);

  return (
    <div className="panel" data-tab={tabId ?? ''}>
      <header className="bar">
        <div className="modes" role="tablist">
          {MODES.map((m) => (
            <button key={m} role="tab" aria-selected={m === mode} className={m === mode ? 'on' : ''} onClick={() => changeMode(m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <div className="bar-right">
          <ModelPicker settings={settings} />
          <button type="button" className="icon" title="Settings" aria-label="Settings" onClick={() => browser.runtime.openOptionsPage()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      <div className="thread" ref={threadRef}>
        {!plan && (
          <div className="empty">
            Nothing selected on this tab yet. Click the toolbar icon, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>, then
            select what you want to ask about.
          </div>
        )}
        {plan &&
          turns.map((t, i) =>
            t.role === 'user' ? (
              <div key={t.id} className="turn user">
                {/* The selection belongs to the opening message, like an attachment. */}
                {i === 0 && <SelectionCard plan={plan} variant="sent" />}
                <div className="turn-text">{t.text}</div>
              </div>
            ) : (
              <div key={t.id} className="turn assistant" data-streaming={t.streaming ? 'true' : 'false'}>
                {t.error ? <div className="error">{t.error}</div> : <Answer text={t.text} streaming={!!t.streaming} />}
                {!t.streaming && !t.error && <Usage model={t.model} usage={t.usage} cached={t.cached} />}
              </div>
            ),
          )}
      </div>

      {plan && !started && <SelectionCard plan={plan} variant="pending" />}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          disabled={!plan}
        />
        {busy ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!plan}>
            {started ? 'Send' : MODE_LABEL[mode]}
          </button>
        )}
      </form>
    </div>
  );
}

function Usage({ model, usage, cached }: { model?: ModelRef; usage?: { inputTokens: number; outputTokens: number; costUsd?: number }; cached?: boolean }) {
  return (
    <div className="usage">
      {model ? `${model.vendor}/${model.model}` : ''}
      {cached ? ' · replayed' : ''}
      {usage ? ` · ${usage.inputTokens}→${usage.outputTokens} tok` : ''}
      {usage?.costUsd !== undefined ? ` · $${usage.costUsd.toFixed(4)}` : ''}
    </div>
  );
}

function ModelPicker({ settings }: { settings: Settings | null }) {
  if (!settings) return null;
  const label =
    settings.provider === 'mock'
      ? 'mock'
      : settings.provider === 'local'
        ? `local · ${settings.localModel}`
        : settings.modelOverride
          ? settings.modelOverride.model
          : `${settings.vendor} · auto`;
  return (
    <button type="button" className="model" title="Change in Options" onClick={() => browser.runtime.openOptionsPage()}>
      {label}
    </button>
  );
}
