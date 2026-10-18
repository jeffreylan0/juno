/**
 * The panel's view of chats: which one this window shows, its contents, the
 * menu's list, and the AI's status — all read from storage and kept live by
 * storage change events. The core is the only writer.
 */
import { useEffect, useRef, useState } from 'react';
import { INDEX_KEY, chatKey, getChat, listChats, type Chat, type ChatSummary } from '@/lib/chats';
import { currentKey, getCurrent, type Current } from '@/lib/current';
import { getImage, isImageRef, isInlineImage } from '@/lib/images';
import { PANEL_PORT, type PanelPortMsg } from '@/lib/messages';
import { WINDOW_ID, type Port } from '@/platform/browser';
import { STATUS_KEY, type AiStatus } from '@/lib/status';

type Changes = Record<string, { newValue?: unknown }>;

/**
 * The panel's session: the chat it shows (the app has one panel, so one
 * "window" of chats: WINDOW_ID). Holding the port open is what tells the
 * core the panel is there; its closing (the page crashed or reloaded) ends
 * the chat.
 */
export function usePanelSession(): Current | null {
  const [current, setCurrentState] = useState<Current | null>(null);
  const latest = useRef<Current | null>(null);

  useEffect(() => {
    let alive = true;
    let port: Port | undefined;
    const update = (c: Current | null) => {
      if (!alive) return;
      latest.current = c;
      setCurrentState(c);
    };

    const connect = () => {
      if (!alive) return;
      const reconnecting = latest.current;
      port = browser.runtime.connect({ name: PANEL_PORT });
      port.onMessage.addListener((msg) => {
        if ((msg as { type?: string } | null)?.type === 'ready') void getCurrent(WINDOW_ID).then(update);
      });
      // The core reloaded: say hello again, keeping this chat.
      port.onDisconnect.addListener(() => {
        if (alive) setTimeout(connect, 150);
      });
      const hello: PanelPortMsg = {
        type: 'hello',
        ...(reconnecting ? { claim: { chatId: reconnecting.chatId, temporary: reconnecting.temporary } } : {}),
      };
      port.postMessage(hello);
    };

    // Deferred a tick so React's development double-mount does not open and
    // close a chat before the real one.
    const start = setTimeout(connect, 0);

    const key = currentKey(WINDOW_ID);
    const onChanged = (changes: Changes, area: string) => {
      if (area !== 'session' || !(key in changes)) return;
      update((changes[key]!.newValue as Current | undefined) ?? null);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      clearTimeout(start);
      browser.storage.onChanged.removeListener(onChanged);
      port?.disconnect();
    };
  }, []);

  return current;
}

/** One chat, live. Null until it has something in it (empty chats are not stored). */
export function useChat(chatId: string | null): Chat | null {
  const [chat, setChat] = useState<Chat | null>(null);
  useEffect(() => {
    setChat(null);
    if (!chatId) return;
    let alive = true;
    void getChat(chatId).then((c) => alive && setChat(c));
    const key = chatKey(chatId);
    const onChanged = (changes: Changes, area: string) => {
      if ((area === 'local' || area === 'session') && key in changes) setChat((changes[key]!.newValue as Chat | undefined) ?? null);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, [chatId]);
  return chat;
}

/** The chat menu's list, newest first. */
export function useChatList(): ChatSummary[] {
  const [list, setList] = useState<ChatSummary[]>([]);
  useEffect(() => {
    let alive = true;
    void listChats().then((l) => alive && setList(l));
    const onChanged = (changes: Changes, area: string) => {
      if (area !== 'local' || !(INDEX_KEY in changes)) return;
      const next = (changes[INDEX_KEY]!.newValue as ChatSummary[] | undefined) ?? [];
      setList([...next].sort((a, b) => b.updatedAt - a.updatedAt));
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return list;
}

/**
 * Whether the chosen AI is reachable. Checked when the panel opens, when the
 * computer goes on- or offline, and when the panel comes back into view (a
 * check less than a minute old is reused); `recheck` forces one.
 */
export function useAiStatus(): { status: AiStatus | null; recheck: () => void; checking: boolean } {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const check = useRef((force: boolean) => {
    setChecking(true);
    void browser.runtime
      .sendMessage({ type: 'ai:check', force })
      .then((s) => s && setStatus(s as AiStatus))
      .catch(() => {})
      .finally(() => setChecking(false));
  });

  useEffect(() => {
    let alive = true;
    void browser.storage.session.get(STATUS_KEY).then((got) => {
      const s = got[STATUS_KEY] as AiStatus | undefined;
      if (alive && s) setStatus(s);
    });
    check.current(false);
    const onChanged = (changes: Changes, area: string) => {
      if (area === 'session' && STATUS_KEY in changes) setStatus((changes[STATUS_KEY]!.newValue as AiStatus | undefined) ?? null);
    };
    const onNetwork = () => check.current(true);
    const onVisible = () => document.visibilityState === 'visible' && check.current(false);
    browser.storage.onChanged.addListener(onChanged);
    addEventListener('online', onNetwork);
    addEventListener('offline', onNetwork);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChanged);
      removeEventListener('online', onNetwork);
      removeEventListener('offline', onNetwork);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return { status, recheck: () => check.current(true), checking };
}

/** Screenshots never change, so each is read from the image store once. */
const pixels = new Map<string, string>();

/**
 * A screenshot's pixels, from the image store when the chat holds a
 * reference: undefined while loading, null if it is gone.
 */
export function useImage(dataUrl: string): string | null | undefined {
  const ref = isImageRef(dataUrl) ? dataUrl : null;
  const inline = isInlineImage(dataUrl) ? dataUrl : null;
  const [src, setSrc] = useState<string | null | undefined>(ref ? pixels.get(ref) : inline);
  useEffect(() => {
    if (!ref) {
      setSrc(inline);
      return;
    }
    if (pixels.has(ref)) {
      setSrc(pixels.get(ref));
      return;
    }
    let alive = true;
    setSrc(undefined);
    void getImage(ref)
      .then((found) => {
        if (found) pixels.set(ref, found);
        if (alive) setSrc(found ?? null);
      })
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [dataUrl, ref]);
  return src;
}
