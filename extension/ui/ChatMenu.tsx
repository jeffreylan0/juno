/**
 * The chat menu, opened from the top-left button: a drawer over the panel,
 * like Gemini's. A search box, then every saved chat, newest first, grouped
 * by when it was last used. Each chat can be renamed or deleted in place, and
 * opening one carries on selecting into it. Temporary chats never appear here.
 *
 * There is no New chat button: a chat starts with the first selection after
 * the previous one was finished (✕ on the selection bar).
 *
 * The free plan keeps ten chats on this computer; the footer says so, so the
 * oldest one disappearing is never a surprise.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_SAVED_CHATS, type ChatSummary } from '@/lib/chats';
import { Icon } from './icons';

export function ChatMenu({
  chats,
  currentId,
  onClose,
  onOpen,
  onRename,
  onDelete,
}: {
  chats: ChatSummary[];
  currentId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // The panel re-renders while an answer streams, with a new onClose each
  // time; reading it through a ref keeps these effects from re-running (and
  // the search box from stealing focus back from a rename in progress).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) close.current();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const shown = useMemo(() => search(chats, query), [chats, query]);
  const groups = useMemo(() => groupByDay(shown, Date.now()), [shown]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Chats" data-testid="chat-menu">
        <div className="drawer-head">
          <button type="button" className="icon" aria-label="Close chats" title="Close" data-testid="menu-close" onClick={onClose}>
            <Icon name="menu" />
          </button>
          <span className="drawer-title">Chats</span>
        </div>
        <label className="search">
          <Icon name="search" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search chats"
            aria-label="Search chats"
            data-testid="chat-search"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <nav className="chat-list" aria-label="Saved chats">
          {groups.map((g) => (
            <section key={g.label}>
              <h3>{g.label}</h3>
              <ul>
                {g.chats.map((c) => (
                  <ChatRow
                    key={c.id}
                    chat={c}
                    active={c.id === currentId}
                    onOpen={() => onOpen(c.id)}
                    onRename={(t) => onRename(c.id, t)}
                    onDelete={() => onDelete(c.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
          {!groups.length && (
            <p className="chat-list-empty" data-testid="chat-list-empty">
              {query.trim() ? `No chats match “${query.trim()}”.` : 'No chats yet. Select something on a page and ask about it; the chat is kept here.'}
            </p>
          )}
        </nav>
        <footer className="drawer-foot" data-testid="chat-limit">
          Saved on this computer only. The free plan keeps your {MAX_SAVED_CHATS} most recent chats.
        </footer>
      </aside>
    </>
  );
}

function ChatRow({
  chat,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  chat: ChatSummary;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const title = chat.title || 'Untitled chat';

  if (mode === 'rename') {
    return (
      <li className="chat-row editing" data-testid="chat-row">
        <TitleInput
          initial={chat.title}
          onDone={(t) => {
            if (t !== null && t !== chat.title) onRename(t);
            setMode('view');
          }}
        />
      </li>
    );
  }

  if (mode === 'delete') {
    return (
      <li className="chat-row confirming" data-testid="chat-row">
        <span className="chat-confirm">Delete “{title}”?</span>
        <span className="chat-confirm-actions">
          <button type="button" className="danger" data-testid="confirm-delete" onClick={onDelete}>
            Delete
          </button>
          <button type="button" onClick={() => setMode('view')}>
            Cancel
          </button>
        </span>
      </li>
    );
  }

  return (
    <li className={`chat-row${active ? ' active' : ''}`} data-testid="chat-row" data-active={active ? 'true' : 'false'}>
      <button type="button" className="chat-open" title={title} onClick={onOpen} aria-current={active ? 'true' : undefined}>
        {title}
      </button>
      <span className="chat-actions">
        <button type="button" className="icon" aria-label={`Rename ${title}`} title="Rename" data-testid="rename-chat" onClick={() => setMode('rename')}>
          <Icon name="pencil" />
        </button>
        <button type="button" className="icon" aria-label={`Delete ${title}`} title="Delete" data-testid="delete-chat" onClick={() => setMode('delete')}>
          <Icon name="trash" />
        </button>
      </span>
    </li>
  );
}

/** An inline title editor: Enter or leaving it saves, Escape cancels (null). */
export function TitleInput({ initial, onDone, className = '' }: { initial: string; onDone: (title: string | null) => void; className?: string }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (t: string | null) => {
    if (done.current) return;
    done.current = true;
    const clean = t?.replace(/\s+/g, ' ').trim();
    onDone(clean ? clean : null);
  };
  return (
    <input
      className={`title-input ${className}`}
      value={value}
      autoFocus
      maxLength={120}
      aria-label="Chat name"
      data-testid="title-input"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(value);
        } else if (e.key === 'Escape') {
          // Cancel the rename only, not the drawer around it.
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

/** Every word must appear somewhere in the chat: its title, its pages or its questions. */
export function search(chats: ChatSummary[], query: string): ChatSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return chats;
  return chats.filter((c) => words.every((w) => c.search.includes(w) || c.title.toLowerCase().includes(w)));
}

/** Today, Yesterday, Previous 7 days, Older — by last use, in local time. */
export function groupByDay(chats: ChatSummary[], now: number): Array<{ label: string; chats: ChatSummary[] }> {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const today = day(now);
  const DAY = 86_400_000;
  const label = (t: number) => {
    const age = Math.round((today - day(t)) / DAY);
    if (age <= 0) return 'Today';
    if (age === 1) return 'Yesterday';
    if (age <= 7) return 'Previous 7 days';
    return 'Older';
  };
  const out: Array<{ label: string; chats: ChatSummary[] }> = [];
  for (const c of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const l = label(c.updatedAt);
    const last = out.at(-1);
    if (last?.label === l) last.chats.push(c);
    else out.push({ label: l, chats: [c] });
  }
  return out;
}
