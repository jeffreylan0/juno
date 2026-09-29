/**
 * The panel: one conversation per tab. It follows whichever tab is active in
 * its window, renders that tab's thread from storage.session, and sends
 * questions to the background, which owns the conversation and streams the
 * answer back into storage.
 *
 * Layout, top to bottom: the selection (exactly what the model gets), the
 * conversation, then the answer macros and a large question box. A fresh
 * selection puts the short default prompt in the box; Enter or Send asks it.
 * A macro fills the box with its own prompt and sends it straight away.
 *
 * Runs in the Chrome/Edge side panel, the Firefox sidebar, and (from week 12)
 * inside the Safari in-page overlay.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ModelRef, Plan } from '@shared/payload';
import { MODEL_NAMES, MODEL_TABLE } from '@/lib/router';
import { getSettings, settingsItem, type Macro, type Settings } from '@/lib/storage';
import { chatKey, getThread, selKey, type Chat, type Turn } from '@/lib/threads';
import { isTransient, needsSettings } from '@/lib/providers/errors';
import { Answer } from './Answer';
import { SelectionCard } from './Selection';

/** How long a macro's prompt shows in the box before it is sent. */
const MACRO_FILL_MS = 140;

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
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const ours = !!chat && chat.planId === plan?.id;
  const turns = ours ? chat!.turns : [];
  const notice = ours ? chat!.notice : undefined;
  const busy = turns.some((t) => t.streaming);
  const draft = tabId !== null ? (drafts[tabId] ?? '') : '';
  const started = turns.length > 0;
  const askable = !!plan && plan.parts.length > 0 && !notice;

  useEffect(() => {
    // Clears the toolbar badge the background sets when it could not open us.
    void browser.runtime.sendMessage({ type: 'panel:ready' }).catch(() => {});
    void getSettings().then(setSettings);
    const unwatch = settingsItem.watch(() => void getSettings().then(setSettings));

    // The bar's X closes everything. Chrome 141+ closes us with
    // sidePanel.close(); older browsers need the document to close itself.
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

  // A fresh selection puts the short default prompt in the box, ready to send
  // or overwrite. (Sending straight away, when settings ask for it, is the
  // background's job.)
  useEffect(() => {
    if (!plan || !settings || tabId === null || !askable) return;
    if (prefilled.current.has(plan.id) || started) return;
    prefilled.current.add(plan.id);
    setDraft(settings.defaultPrompt);
    requestAnimationFrame(() => {
      const box = boxRef.current;
      if (!box) return;
      box.focus({ preventScroll: true });
      box.setSelectionRange(box.value.length, box.value.length);
    });
  }, [plan, settings, tabId, started, askable, setDraft]);

  // The box grows with what is typed, up to a cap, then scrolls.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, Math.round(innerHeight * 0.4))}px`;
  }, [draft]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [turns.length, turns[turns.length - 1]?.text]);

  const ask = useCallback(
    (question: string) => {
      if (!askable || tabId === null || busy) return;
      void browser.runtime.sendMessage({ type: 'chat:send', tabId, question });
      setDraft('');
    },
    [askable, tabId, busy, setDraft],
  );

  const runMacro = useCallback(
    (macro: Macro) => {
      if (!askable || busy) return;
      // Fill the box first so the student sees what is being asked, then send.
      setDraft(macro.prompt);
      setTimeout(() => ask(macro.prompt), MACRO_FILL_MS);
    },
    [askable, busy, setDraft, ask],
  );

  const stop = useCallback(() => {
    if (tabId !== null) void browser.runtime.sendMessage({ type: 'chat:stop', tabId });
  }, [tabId]);

  const retry = useCallback(() => {
    if (tabId !== null) void browser.runtime.sendMessage({ type: 'chat:retry', tabId });
  }, [tabId]);

  const placeholder = !plan ? 'Select something on the page first' : started ? 'Ask a follow-up…' : 'Ask about this selection…';

  return (
    <div className="panel" data-tab={tabId ?? ''}>
      <header className="top">
        <ModelChip settings={settings} />
        <button type="button" className="icon" title="Settings" aria-label="Settings" onClick={() => browser.runtime.openOptionsPage()}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </header>

      {settings?.provider === 'mock' && (
        <div className="mock-note" data-testid="mock-note">
          Placeholder answers — no AI is connected.{' '}
          <button type="button" className="link" onClick={() => browser.runtime.openOptionsPage()}>
            Connect Claude or ChatGPT
          </button>
        </div>
      )}

      <div className="thread" ref={threadRef}>
        {!plan && (
          <div className="empty">
            Nothing selected on this tab yet. Click the toolbar icon, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>, then
            select what you want to ask about.
          </div>
        )}
        {plan && <SelectionCard plan={plan} notice={notice} />}
        {plan &&
          turns.map((t, i) =>
            t.role === 'user' ? (
              <div key={t.id} className="turn user">
                <div className="turn-text">{t.text}</div>
              </div>
            ) : (
              <div key={t.id} className="turn assistant" data-streaming={t.streaming ? 'true' : 'false'}>
                {t.error ? (
                  <ErrorTurn turn={t} last={i === turns.length - 1} onRetry={retry} />
                ) : (
                  <Answer text={t.text} streaming={!!t.streaming} />
                )}
                {settings?.showUsage && !t.streaming && !t.error && <Usage model={t.model} usage={t.usage} cached={t.cached} />}
              </div>
            ),
          )}
      </div>

      <div className="ask">
        {settings && settings.macros.length > 0 && (
          <div className="macros" role="toolbar" aria-label="Answer macros">
            {settings.macros.map((m) => (
              <button
                key={m.id}
                type="button"
                className="macro"
                title={m.prompt}
                disabled={!askable || busy}
                onClick={() => runMacro(m)}
              >
                {m.name}
              </button>
            ))}
          </div>
        )}
        <form
          className={`composer${askable ? '' : ' off'}`}
          onSubmit={(e) => {
            e.preventDefault();
            ask(draft);
          }}
        >
          <textarea
            ref={boxRef}
            value={draft}
            placeholder={placeholder}
            aria-label="Your question"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Not while an input method is composing (pinyin, kana, …):
              // Enter there picks a candidate, it is not "send".
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask(draft);
              }
            }}
            rows={3}
            disabled={!askable}
          />
          <div className="composer-row">
            <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
            {busy ? (
              <button type="button" className="send stop" onClick={stop}>
                Stop
              </button>
            ) : (
              <button type="submit" className="send" disabled={!askable}>
                Send
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function ErrorTurn({ turn, last, onRetry }: { turn: Turn; last: boolean; onRetry: () => void }) {
  return (
    <div className="error" role="alert" data-code={turn.errorCode ?? ''}>
      <div>{turn.error}</div>
      {(needsSettings(turn.errorCode) || (last && isTransient(turn.errorCode))) && (
        <div className="error-actions">
          {needsSettings(turn.errorCode) && (
            <button type="button" onClick={() => browser.runtime.openOptionsPage()}>
              Open settings
            </button>
          )}
          {last && isTransient(turn.errorCode) && (
            <button type="button" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}
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

/** Who is answering, at a glance; a click opens settings to change it. */
function ModelChip({ settings }: { settings: Settings | null }) {
  if (!settings) return <span />;
  const vendorName = settings.vendor === 'anthropic' ? 'Claude' : 'ChatGPT';
  const label =
    settings.provider === 'mock'
      ? 'Mock answers'
      : settings.provider === 'local'
        ? `Local · ${settings.localModel}`
        : settings.provider === 'gateway'
          ? 'Hosted plan'
          : settings.modelOverride
            ? (MODEL_NAMES[settings.modelOverride.model] ?? settings.modelOverride.model)
            : `${vendorName} · Auto`;
  const title =
    settings.provider === 'byok' && !settings.modelOverride
      ? `${MODEL_NAMES[MODEL_TABLE[settings.vendor].small]} for text, ${MODEL_NAMES[MODEL_TABLE[settings.vendor].large]} for screenshots`
      : 'Change in Settings';
  return (
    <button type="button" className="model" title={title} data-testid="model-chip" onClick={() => browser.runtime.openOptionsPage()}>
      {label}
    </button>
  );
}
