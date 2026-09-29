/**
 * The panel: one chat at a time, gathering selections from any page in this
 * window until the panel is closed. Closing it ends the chat — it stays in
 * the chat menu — and opening it again starts a new one.
 *
 * Layout, top to bottom:
 *  - the top bar: chat menu (left), the chat's name (click to rename), the
 *    temporary-chat ghost and settings (right);
 *  - the chat: selections as they arrive, questions and answers;
 *  - notices (no key, disconnected, …), then the answer macros with the model
 *    picker beside them, and a large question box.
 *
 * Every question carries the selections made since the last one. The box
 * starts empty (or with the student's own default prompt); Enter or Send asks
 * what is typed; a macro fills the box with its prompt and sends it.
 *
 * The panel never writes a chat. It sends commands to the background, which
 * owns every chat, and renders whatever is stored.
 *
 * Runs in the Chrome/Edge side panel, the Firefox sidebar, and (from week 12)
 * inside the Safari in-page overlay.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ModelRef } from '@shared/payload';
import { BRAND } from '@/brand';
import { hasUsableSelection, isRemovable, pendingSelections, type AssistantItem, type Chat } from '@/lib/chats';
import { isTransient, needsSettings } from '@/lib/providers/errors';
import { getKeys, getSettings, keysItem, settingsItem, type Keys, type Macro, type Settings } from '@/lib/storage';
import { Answer } from './Answer';
import { ChatMenu, TitleInput } from './ChatMenu';
import { Icon } from './icons';
import { ModelPicker } from './ModelPicker';
import { Notices } from './Notices';
import { SelectionCard } from './Selection';
import { useAiStatus, useChat, useChatList, usePanelSession } from './useChat';
import { useShortcut } from './useShortcut';

/** How long a macro's prompt shows in the box before it is sent. */
const MACRO_FILL_MS = 140;

const send = (msg: Record<string, unknown>) => browser.runtime.sendMessage(msg).catch(() => undefined);

export function Panel() {
  const { windowId, current } = usePanelSession();
  const chat = useChat(current?.chatId ?? null);
  const chats = useChatList();
  const { status, recheck, checking } = useAiStatus();
  const dropped = useDropped();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keys, setKeys] = useState<Keys | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const shortcut = useShortcut();
  /** Unsent drafts per chat, so switching chats does not lose what you typed. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Selections already greeted with the default prompt and the cursor. */
  const greeted = useRef(new Set<string>());
  const threadRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const chatId = current?.chatId ?? null;
  const temporary = !!current?.temporary;
  const items = chat?.items ?? [];
  const busy = items.some((i) => i.kind === 'assistant' && i.streaming);
  const askable = hasUsableSelection(chat);
  const pending = chat ? pendingSelections(chat) : [];
  const asked = items.some((i) => i.kind === 'user');
  const draft = chatId ? (drafts[chatId] ?? '') : '';
  const newest = pending.at(-1)?.id;

  useEffect(() => {
    // Clears the toolbar badge the background sets when it could not open us.
    void send({ type: 'panel:ready' });
    void getSettings().then(setSettings);
    void getKeys().then(setKeys);
    const unwatch = settingsItem.watch(() => void getSettings().then(setSettings));
    const unwatchKeys = keysItem.watch(() => void getKeys().then(setKeys));
    return () => {
      unwatch();
      unwatchKeys();
    };
  }, []);

  // The bar's X closes everything. Chrome 141+ closes us with
  // sidePanel.close(); older browsers need the document to close itself.
  useEffect(() => {
    const onMessage = (raw: unknown) => {
      const msg = raw as { type?: string; windowId?: number };
      if (msg?.type !== 'panel:close') return;
      if (msg.windowId !== undefined && windowId !== null && msg.windowId !== windowId) return;
      window.close();
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [windowId]);

  const setDraft = useCallback(
    (text: string) => {
      if (chatId) setDrafts((d) => ({ ...d, [chatId]: text }));
    },
    [chatId],
  );

  // A new selection: the default prompt goes in the box (empty unless the
  // student set one) and the cursor goes after it. Sending straight away,
  // when settings ask for it, is the background's job.
  useEffect(() => {
    if (!newest || !settings || greeted.current.has(newest)) return;
    greeted.current.add(newest);
    if (!draft.trim()) setDraft(settings.defaultPrompt);
    requestAnimationFrame(() => {
      const box = boxRef.current;
      if (!box) return;
      box.focus({ preventScroll: true });
      box.setSelectionRange(box.value.length, box.value.length);
    });
  }, [newest, settings, draft, setDraft]);

  // The box grows with what is typed, up to a cap, then scrolls.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, Math.round(innerHeight * 0.4))}px`;
  }, [draft]);

  const last = items.at(-1);
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [chatId, items.length, last?.kind === 'assistant' ? last.text : '']);

  const ask = useCallback(
    (question: string) => {
      if (!askable || !chatId || busy) return;
      void send({ type: 'chat:send', chatId, question });
      setDraft('');
    },
    [askable, chatId, busy, setDraft],
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

  const stop = () => chatId && void send({ type: 'chat:stop', chatId });
  const retry = () => chatId && void send({ type: 'chat:retry', chatId });
  const newChat = () => {
    setMenuOpen(false);
    if (windowId !== null) void send({ type: 'chat:new', windowId });
  };
  const toggleTemporary = () => {
    if (windowId !== null) void send({ type: 'chat:temporary', windowId, on: !temporary });
  };

  const placeholder = !askable
    ? 'Select something on the page first'
    : pending.length === 0
      ? 'Ask a follow-up…'
      : asked
        ? pending.length > 1
          ? 'Ask about the new selections…'
          : 'Ask about the new selection…'
        : pending.length > 1
          ? 'Ask about these selections…'
          : 'Ask about this selection…';
  const canSend = askable && !!draft.trim();

  return (
    <div className="panel" data-temporary={temporary ? 'true' : 'false'} data-chat={chatId ?? ''}>
      <header className="topbar">
        <button type="button" className="icon" aria-label="Chats" title="Chats" data-testid="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <Icon name="menu" />
        </button>
        <ChatTitle chat={chat} temporary={temporary} onRename={(title) => chatId && void send({ type: 'chat:rename', chatId, title })} />
        <button
          type="button"
          className={`icon ghost${temporary ? ' on' : ''}`}
          aria-label="Temporary chat"
          aria-pressed={temporary}
          title={temporary ? 'Leave temporary chat (it will be deleted)' : 'Temporary chat: not saved, deleted when the panel closes'}
          data-testid="temporary"
          onClick={toggleTemporary}
        >
          <Icon name="ghost" />
        </button>
        <button type="button" className="icon" title="Settings" aria-label="Settings" data-testid="settings" onClick={() => void browser.runtime.openOptionsPage()}>
          <Icon name="gear" />
        </button>
      </header>

      {menuOpen && (
        <ChatMenu
          chats={chats}
          currentId={chatId}
          onClose={() => setMenuOpen(false)}
          onNew={newChat}
          onOpen={(id) => {
            setMenuOpen(false);
            if (windowId !== null && id !== chatId) void send({ type: 'chat:open', windowId, chatId: id });
          }}
          onRename={(id, title) => void send({ type: 'chat:rename', chatId: id, title })}
          onDelete={(id) => void send({ type: 'chat:delete', chatId: id })}
        />
      )}

      <div className="thread" ref={threadRef} data-testid="thread">
        {items.length === 0 && <Empty temporary={temporary} shortcut={shortcut} />}
        {chat &&
          items.map((item) => {
            switch (item.kind) {
              case 'selection':
                return (
                  <SelectionCard
                    key={item.id}
                    item={item}
                    onRemove={isRemovable(chat, item.id) ? () => void send({ type: 'chat:drop-selection', chatId: chat.id, itemId: item.id }) : undefined}
                  />
                );
              case 'user':
                return (
                  <div key={item.id} className="turn user">
                    <div className="turn-text">{item.text}</div>
                  </div>
                );
              case 'assistant':
                return (
                  <div key={item.id} className="turn assistant" data-streaming={item.streaming ? 'true' : 'false'}>
                    {item.error ? (
                      <ErrorTurn item={item} last={item === last} onRetry={retry} />
                    ) : (
                      <Answer text={item.text} streaming={!!item.streaming} />
                    )}
                    {settings?.showUsage && !item.streaming && !item.error && <Usage model={item.model} usage={item.usage} cached={item.cached} />}
                  </div>
                );
            }
          })}
      </div>

      <div className="ask">
        <Notices
          settings={settings}
          keys={keys}
          status={status}
          checking={checking}
          onRecheck={recheck}
          dropped={dropped.titles}
          onDismissDropped={dropped.dismiss}
        />
        <div className="ask-row">
          <div className="macros" role="toolbar" aria-label="Answer macros">
            {settings?.macros.map((m) => (
              <button key={m.id} type="button" className="macro" title={m.prompt} disabled={!askable || busy} onClick={() => runMacro(m)}>
                {m.name}
              </button>
            ))}
          </div>
          {settings && <ModelPicker settings={settings} keys={keys} />}
        </div>
        <form
          className={`composer${askable ? '' : ' off'}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) ask(draft);
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
                if (canSend) ask(draft);
              }
            }}
            rows={3}
            disabled={!askable}
          />
          <div className="composer-row">
            <span className="composer-hint">
              Enter to send<span className="extra"> · Shift+Enter for a new line</span>
            </span>
            {busy ? (
              <button type="button" className="send stop" onClick={stop}>
                Stop
              </button>
            ) : (
              <button type="submit" className="send" disabled={!canSend}>
                Send
                <Icon name="send" />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

/** The chat's name in the top bar. A saved chat's name can be clicked to rename it. */
function ChatTitle({ chat, temporary, onRename }: { chat: Chat | null; temporary: boolean; onRename: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [chat?.id]);
  if (temporary) {
    return (
      <span className="chat-title temporary" data-testid="chat-title">
        Temporary chat
      </span>
    );
  }
  if (!chat) {
    return (
      <span className="chat-title muted" data-testid="chat-title">
        New chat
      </span>
    );
  }
  if (editing) {
    return (
      <TitleInput
        className="chat-title-input"
        initial={chat.title}
        onDone={(t) => {
          setEditing(false);
          if (t !== null && t !== chat.title) onRename(t);
        }}
      />
    );
  }
  return (
    <button type="button" className="chat-title" title={`${chat.title} — click to rename`} data-testid="chat-title" onClick={() => setEditing(true)}>
      {chat.title || 'Untitled chat'}
    </button>
  );
}

function Empty({ temporary, shortcut }: { temporary: boolean; shortcut: string }) {
  const how = (
    <>
      Click {BRAND.iconName}
      {shortcut ? (
        <>
          {' '}or press <kbd>{shortcut}</kbd>
        </>
      ) : null}
      , then select what you want to ask about.
    </>
  );
  if (temporary) {
    return (
      <div className="empty temporary" data-testid="empty">
        <Icon name="ghost" className="empty-ghost" />
        <p>
          <strong>Temporary chat.</strong> It won't appear in your chats, and it's deleted when you close the panel.
        </p>
        <p>{how}</p>
      </div>
    );
  }
  return (
    <div className="empty" data-testid="empty">
      <p>{how}</p>
      <p>Everything you select goes into this chat — from any page — until you close the panel.</p>
    </div>
  );
}

/**
 * When the free plan's limit drops an old chat, say so once. Only drops that
 * happen while this panel is open count; dismissing hides it.
 */
function useDropped(): { titles: string[] | null; dismiss: () => void } {
  const [titles, setTitles] = useState<string[] | null>(null);
  useEffect(() => {
    const since = Date.now();
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'session' || !('lastDropped' in changes)) return;
      const v = changes.lastDropped!.newValue as { titles: string[]; at: number } | undefined;
      if (v && v.at >= since) setTitles(v.titles);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);
  return { titles, dismiss: () => setTitles(null) };
}

function ErrorTurn({ item, last, onRetry }: { item: AssistantItem; last: boolean; onRetry: () => void }) {
  return (
    <div className="error" role="alert" data-code={item.errorCode ?? ''}>
      <div>{item.error}</div>
      {(needsSettings(item.errorCode) || (last && isTransient(item.errorCode))) && (
        <div className="error-actions">
          {needsSettings(item.errorCode) && (
            <button type="button" onClick={() => void browser.runtime.openOptionsPage()}>
              Open settings
            </button>
          )}
          {last && isTransient(item.errorCode) && (
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
