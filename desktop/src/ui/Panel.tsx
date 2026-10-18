/**
 * The panel: the chat the bar is filling. The shortcut brings the bar up;
 * the first selection opens the panel, and every selection after lands here
 * too. ✕ on either (or Escape on a waiting bar) hides both and finishes the
 * chat: it stays in the chat menu, or is deleted if temporary. The next
 * selection starts a new chat; so does the new-chat key (⌘⇧O, Ctrl+Shift+O),
 * which keeps the panel up.
 *
 * Layout, top to bottom:
 *  - the top bar: ✕, the chat menu, the chat's name (click to rename), the
 *    temporary-chat ghost and settings;
 *  - the chat: selections as they arrive, questions in rounded bubbles (copy,
 *    and on the latest, edit and ask again), answers paced as they stream
 *    (copy);
 *  - notices (no key, disconnected, …) floating over the end of the chat
 *    and going by themselves, then the answer macros, and the question box,
 *    with who answers beside Send, as in Claude.
 *
 * Every question carries the selections made since the last one. The box
 * starts empty (or with the student's own default prompt); Enter or Send asks
 * what is typed; a macro fills the box with its prompt and sends it. The
 * chat follows an answer as it streams, unless the student scrolled up to
 * read.
 *
 * The panel never writes a chat. It sends commands to the core, which owns
 * every chat, and renders whatever is stored.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SelectionKind } from '@shared/payload';
import { BRAND } from '@/brand';
import { ACCOUNTS } from '@/lib/account/config';
import { autoTitle, hasUsableSelection, isRemovable, pendingSelections, type AssistantItem, type Chat } from '@/lib/chats';
import { isTransient, needsSettings } from '@/lib/providers/errors';
import { getSettings, settingsItem, type Macro, type Settings } from '@/lib/storage';
import { splitWhatIRead } from '@shared/prompts';
import { Answer } from './Answer';
import { ChatMenu, TitleInput } from './ChatMenu';
import { Icon } from './icons';
import { ModelPicker } from './ModelPicker';
import { Notices } from './Notices';
import { IncomingSelection, SelectionCard } from './Selection';
import { useAccount } from './useAccount';
import { useKeyStatus } from './useKeyStatus';
import { useAiStatus, useChat, useChatList, usePanelSession } from './useChat';
import { MAC } from '../os';
import { formatShortcut, useShortcut } from './useShortcut';

/** How long a notice stays before it goes by itself (Notices.tsx). */
const NOTICE_MS = 9000;
/** Within this of the end, the chat counts as scrolled to it (fractional display scales round). */
const AT_END_PX = 4;
/** The new-chat key, as people say it. */
const NEW_CHAT_KEY = MAC ? '⌘⇧O' : 'Ctrl+Shift+O';

/** How long a macro's prompt shows in the box before it is sent. */
const MACRO_FILL_MS = 140;
/** How long a selection's placeholder waits for it before giving up. */
const INCOMING_MS = 8000;

const send = (msg: Record<string, unknown>) => browser.runtime.sendMessage(msg).catch(() => undefined);
const SYNC_EVERY_MS = 5 * 60_000;

export function Panel() {
  const { windowId, current } = usePanelSession();
  const chat = useChat(current?.chatId ?? null);
  const chats = useChatList();
  const { status, recheck, checking } = useAiStatus();
  const dropped = useDropped();
  const [settings, setSettings] = useState<Settings | null>(null);
  const keys = useKeyStatus();
  const [menuOpen, setMenuOpen] = useState(false);
  const shortcut = useShortcut();
  const account = useAccount();
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
    void getSettings().then(setSettings);
    return settingsItem.watch(() => void getSettings().then(setSettings));
  }, []);

  // Chats from the student's other computers (cloud storage): caught up when
  // the panel opens, comes back into view, opens the chat menu, and every few
  // minutes while it stays open. The core does nothing if not signed in.
  useEffect(() => {
    if (!ACCOUNTS) return;
    const catchUp = () => document.visibilityState === 'visible' && void send({ type: 'sync:now' });
    catchUp();
    const timer = setInterval(catchUp, SYNC_EVERY_MS);
    document.addEventListener('visibilitychange', catchUp);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', catchUp);
    };
  }, []);
  useEffect(() => {
    if (ACCOUNTS && menuOpen) void send({ type: 'sync:now' });
  }, [menuOpen]);

  // The new-chat key: this chat is finished; the bar comes up for the next (core/main.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'o' || !e.shiftKey || !(MAC ? e.metaKey : e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      void send({ type: 'chat:new' });
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const setDraft = useCallback(
    (text: string) => {
      if (chatId) setDrafts((d) => ({ ...d, [chatId]: text }));
    },
    [chatId],
  );

  // The app's bar has a chats button: the panel opens on the list of chats
  // (a selection on its way closes it again). The app also says when it
  // shows the panel (card:enter), which brings back notices that went by
  // themselves: their time runs out while the panel is hidden.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const onMessage = (raw: unknown) => {
      const type = (raw as { type?: string })?.type;
      if (type === 'panel:chats') setMenuOpen(true);
      else if (type === 'card:enter') setShown((n) => n + 1);
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

  // A new selection: the default prompt goes in the box (empty unless the
  // student set one) and the cursor goes after it. Sending straight away,
  // when settings ask for it, is the core's job.
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

  // A selection on its way (selection:incoming): a placeholder stands in
  // for it from the moment it is made until it lands in the chat (a
  // selection there made since), so the panel never opens on nothing. Given
  // up after a while should it not come (the selection was dropped).
  const landed = items.findLast((i) => i.kind === 'selection')?.at ?? 0;
  const [incoming, setIncoming] = useState<{ kind: SelectionKind; at: number } | null>(null);
  useEffect(() => {
    const onMessage = (raw: unknown) => {
      const msg = raw as { type?: string; kind?: SelectionKind; at?: number; windowId?: number };
      if (msg?.type !== 'selection:incoming') return;
      if (msg.windowId !== undefined && windowId !== null && msg.windowId !== windowId) return;
      setIncoming({ kind: msg.kind ?? 'box', at: msg.at ?? Date.now() });
      setMenuOpen(false);
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [windowId]);
  useEffect(() => {
    if (!incoming) return;
    if (landed >= incoming.at) return setIncoming(null);
    const timer = setTimeout(() => setIncoming(null), INCOMING_MS);
    return () => clearTimeout(timer);
  }, [incoming, landed]);

  // The chat follows what comes in (an answer streaming, a new selection),
  // until the student scrolls up, by any amount and any means (wheel,
  // trackpad, keys, scroll bar): then it stays where they are until they
  // scroll back down to the end. A new chat, or a question they ask, follows again.
  const last = items.at(-1);
  const following = useRef(true);
  const followBottom = useCallback(() => {
    const thread = threadRef.current;
    if (thread && following.current) thread.scrollTo({ top: thread.scrollHeight });
  }, []);
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    let top = thread.scrollTop;
    const atEnd = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight <= AT_END_PX;
    const onScroll = () => {
      // Up and away from the end lets go; down to the end follows again. (A
      // chat that got shorter moves the scroll up too, but stays at the end.)
      if (thread.scrollTop < top && !atEnd()) following.current = false;
      else if (thread.scrollTop > top && atEnd()) following.current = true;
      top = thread.scrollTop;
    };
    // Before the scroll it causes, so the next line of the answer can't pull the chat back down.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && thread.scrollTop > 0) following.current = false;
    };
    thread.addEventListener('scroll', onScroll, { passive: true });
    thread.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      thread.removeEventListener('scroll', onScroll);
      thread.removeEventListener('wheel', onWheel);
    };
  }, []);
  useEffect(() => {
    following.current = true;
  }, [chatId]);
  useEffect(followBottom, [followBottom, chatId, items.length, last?.kind === 'assistant' ? last.text : '', !!incoming]);

  const ask = useCallback(
    (question: string) => {
      if (!askable || !chatId || busy) return;
      following.current = true;
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
  /** Asks the latest question again: as it was, or as edited. */
  const retry = (question?: string) => {
    if (!chatId) return;
    following.current = true;
    void send({ type: 'chat:retry', chatId, ...(question !== undefined ? { question } : {}) });
  };
  // The latest question can be edited or asked again while nothing but its answer follows it (engine.ts).
  const redoable = !busy && last?.kind === 'assistant' && items.at(-2)?.kind === 'user' ? items.at(-2)!.id : null;
  const toggleTemporary = () => {
    if (windowId !== null) void send({ type: 'chat:temporary', windowId, on: !temporary });
  };

  const placeholder = !askable
    ? 'Select something first'
    : pending.length === 0
      ? 'Ask a follow-up…'
      : asked
        ? pending.length > 1
          ? 'Ask about the new ones…'
          : 'Ask about the new one…'
        : pending.length > 1
          ? 'Ask about these…'
          : 'Ask about this…';
  const canSend = askable && !!draft.trim();

  return (
    <div className="panel" data-temporary={temporary ? 'true' : 'false'} data-chat={chatId ?? ''}>
      <header className="topbar">
        <button type="button" className="icon" title="Close (finishes the chat)" aria-label="Close" data-testid="close" onClick={() => window.close()}>
          <Icon name="close" />
        </button>
        <button type="button" className="icon" aria-label="Chats" title="Chats" data-testid="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <Icon name="menu" />
        </button>
        <ChatTitle chat={chat} temporary={temporary} onRename={(title) => chatId && void send({ type: 'chat:rename', chatId, title })} />
        <button
          type="button"
          className={`icon ghost${temporary ? ' on' : ''}`}
          aria-label="Temporary chat"
          aria-pressed={temporary}
          title={temporary ? 'Leave temporary chat (deletes it)' : 'Temporary chat (not saved)'}
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
          limit={settings?.chatLimit ?? 10}
          cloud={!!settings?.cloudSync && !!account.user && !!account.entitlement?.cloud}
          currentId={chatId}
          onClose={() => setMenuOpen(false)}
          onOpen={(id) => {
            setMenuOpen(false);
            if (windowId !== null && id !== chatId) void send({ type: 'chat:open', windowId, chatId: id });
          }}
          onRename={(id, title) => void send({ type: 'chat:rename', chatId: id, title })}
          onDelete={(id) => void send({ type: 'chat:delete', chatId: id })}
        />
      )}

      <div className="thread" ref={threadRef} data-testid="thread">
        {items.length === 0 && !incoming && <Empty temporary={temporary} shortcut={shortcut} provider={settings?.provider} />}
        {chat &&
          items.map((item) => {
            switch (item.kind) {
              case 'selection':
                return (
                  <SelectionCard
                    key={item.id}
                    item={item}
                    // The chat is named after its first page; saying so again above each selection is noise.
                    showPage={autoTitle(item.plan) !== chat.title}
                    onRemove={isRemovable(chat, item.id) ? () => void send({ type: 'chat:drop-selection', chatId: chat.id, itemId: item.id }) : undefined}
                  />
                );
              case 'user':
                return <Question key={item.id} text={item.text} redo={item.id === redoable ? retry : undefined} />;
              case 'assistant':
                return (
                  <div key={item.id} className="turn assistant" data-streaming={item.streaming ? 'true' : 'false'}>
                    {item.error ? (
                      <ErrorTurn item={item} last={item === last} onRetry={() => retry()} />
                    ) : (
                      <>
                        <Answer text={item.text} streaming={!!item.streaming} onPaced={followBottom} />
                        {!item.streaming && item.text.trim() && (
                          <div className="turn-actions">
                            <CopyButton text={splitWhatIRead(item.text).body} what="answer" />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
            }
          })}
        {incoming && <IncomingSelection kind={incoming.kind} />}
      </div>

      <div className="ask">
        <Notices
          // A new chat, or the panel shown again, brings back notices that went by themselves.
          key={`${chatId ?? ''}:${shown}`}
          lasts={NOTICE_MS}
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
            <span className="composer-hint">{NEW_CHAT_KEY} new chat</span>
            {settings && <ModelPicker settings={settings} keys={keys} />}
            {busy ? (
              <button type="button" className="send stop" aria-label="Stop" title="Stop" onClick={stop}>
                <Icon name="stop" />
              </button>
            ) : (
              <button type="submit" className="send" aria-label="Send" title="Send (Enter)" disabled={!canSend}>
                <Icon name="send" />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * A question, in a rounded bubble, with what can be done with it under it:
 * copy, and on the latest question (`redo`), edit it or ask it again, which
 * replaces it and its answer.
 */
function Question({ text, redo }: { text: string; redo?: (question?: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!editing || !box.current) return;
    box.current.style.height = 'auto';
    box.current.style.height = `${box.current.scrollHeight}px`;
  }, [editing, draft]);
  useEffect(() => {
    if (!editing) return;
    const el = box.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  if (editing && redo) {
    const done = () => {
      setEditing(false);
      if (draft.trim() && draft.trim() !== text.trim()) redo(draft.trim());
    };
    return (
      <div className="turn user editing" data-testid="question">
        <div className="bubble">
          <textarea
            ref={box}
            className="edit-box"
            value={draft}
            rows={1}
            aria-label="Edit your question"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                done();
              }
            }}
          />
          <div className="edit-actions">
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={!draft.trim()} onClick={done} data-testid="edit-send">
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="turn user" data-testid="question">
      <div className="bubble turn-text">{text}</div>
      <div className="turn-actions">
        <CopyButton text={text} what="question" />
        {redo && (
          <>
            <button
              type="button"
              className="icon"
              title="Edit"
              aria-label="Edit question"
              data-testid="edit"
              onClick={() => {
                setDraft(text);
                setEditing(true);
              }}
            >
              <Icon name="pencil" />
            </button>
            <button type="button" className="icon" title="Ask again" aria-label="Ask again" data-testid="retry" onClick={() => redo()}>
              <Icon name="retry" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Copies `text`, saying so for a moment. */
function CopyButton({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="icon"
      title={copied ? 'Copied' : 'Copy'}
      aria-label={copied ? 'Copied' : `Copy ${what}`}
      data-testid={`copy-${what}`}
      onClick={() => void copyText(text).then(setCopied)}
    >
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
  );
}

/** Puts text on the clipboard; the older way where a webview offers no Clipboard API (macOS's custom scheme). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
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

/** What an empty chat says: how to start. Default text, so it is set in italics. */
function Empty({ temporary, shortcut, provider }: { temporary: boolean; shortcut: string; provider?: Settings['provider'] }) {
  const keys = formatShortcut(shortcut);
  const how = keys ? `Press ${keys} to select something.` : `Click ${BRAND.iconName} to select something.`;
  if (temporary) {
    return (
      <div className="empty temporary" data-testid="empty">
        <Icon name="ghost" className="empty-ghost" />
        <p>
          <strong>Temporary chat.</strong> Not saved.
        </p>
        <p className="privacy" data-testid="ghost-privacy">
          {provider === 'local'
            ? 'Nothing leaves your computer.'
            : provider === 'mock'
              ? 'Nothing is sent.'
              : 'The AI is asked to keep as little as it can.'}
        </p>
        <p>{how}</p>
      </div>
    );
  }
  return (
    <div className="empty" data-testid="empty">
      <p>{how}</p>
    </div>
  );
}

/**
 * When the chat limit drops an old chat, say so once. Only drops that happen
 * while this panel is open count; dismissing hides it.
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
