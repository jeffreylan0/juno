/**
 * The part of the WebExtension API the extension's shared code uses, for the
 * app's windows. With it installed as `globalThis.browser`, lib/ (chats,
 * the current chat, images, settings, accounts, sync), ui/ (the panel) and
 * the settings page run unchanged — as do WXT's `storage` helpers, which
 * read `globalThis.browser`.
 *
 *  - storage.local / storage.session: kept by the native core (store.rs),
 *    shared by every window; every change reaches every window's
 *    `onChanged`, as in the extension.
 *  - runtime.sendMessage: from any window to the core window, which plays
 *    the extension's background and answers; from the core, to every other
 *    window, unanswered (like the background telling its pages).
 *  - runtime.connect: a port to the core. It disconnects when either window
 *    goes, which is how the core hears that the panel was closed.
 *  - windows.getCurrent: the app has one panel, so one "window", WINDOW_ID.
 */
import type { Transport } from './transport';

/** The one window of chats (lib/current.ts keys everything by window). */
export const WINDOW_ID = 1;
export const RUNTIME_ID = 'selection-ai-desktop';
/** How long a message waits for the core's answer before giving up. */
const REPLY_TIMEOUT_MS = 120_000;

type Listener = (...args: never[]) => unknown;

/** chrome.events.Event, minimally. */
export class Ev<L extends Listener> {
  private set = new Set<L>();
  addListener(l: L): void {
    this.set.add(l);
  }
  removeListener(l: L): void {
    this.set.delete(l);
  }
  hasListener(l: L): boolean {
    return this.set.has(l);
  }
  hasListeners(): boolean {
    return this.set.size > 0;
  }
  get listeners(): L[] {
    return [...this.set];
  }
  fire(...args: Parameters<L>): void {
    for (const l of this.listeners) {
      try {
        (l as (...a: Parameters<L>) => unknown)(...args);
      } catch (err) {
        console.error('[selection-ai] listener failed', err);
      }
    }
  }
}

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type AreaName = 'local' | 'session';
type MessageListener = (message: unknown, sender: Sender, sendResponse: (response?: unknown) => void) => unknown;

export interface Sender {
  id: string;
  /** The window it came from: core, overlay, panel or settings. */
  origin: string;
  url: string;
}

export interface Port {
  name: string;
  sender: Sender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: Ev<(message: unknown, port: Port) => void>;
  onDisconnect: Ev<(port: Port) => void>;
}

interface Wire {
  msg: { id: string; from: string; msg: unknown; reply: boolean };
  reply: { id: string; value: unknown };
  connect: { portId: string; name: string; from: string };
  port: { portId: string; msg: unknown };
  disconnect: { portId: string };
}

let counter = 0;
const uid = () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface BrowserOptions {
  /** The label of the window that plays the background. */
  core?: string;
  /** Opens a link in the student's browser. */
  openUrl?: (url: string) => void;
  /** The page's origin, for getURL. */
  origin?: string;
}

export function createBrowser(t: Transport, opts: BrowserOptions = {}) {
  const core = opts.core ?? 'core';
  const isCore = t.label === core;
  const origin = opts.origin ?? (typeof location === 'undefined' ? 'tauri://localhost' : location.origin);
  const sender = (from: string): Sender => ({ id: RUNTIME_ID, origin: from, url: `${origin}/${from}.html` });

  // ── storage ────────────────────────────────────────────────────────────
  const anyChanged = new Ev<(changes: Changes, areaName: string) => void>();
  const makeArea = (name: AreaName) => {
    const onChanged = new Ev<(changes: Changes) => void>();
    return {
      onChanged,
      async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
        const list = keys == null ? null : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const got = await t.invoke<Record<string, unknown>>('storage_get', { area: name, keys: list });
        // An object of defaults: stored values over them.
        return keys && typeof keys === 'object' && !Array.isArray(keys) ? { ...keys, ...got } : got;
      },
      async set(items: Record<string, unknown>): Promise<void> {
        // Stored as JSON, like the extension's structured clone of plain data;
        // undefined values are left out as they would be there.
        await t.invoke('storage_set', { area: name, items: JSON.parse(JSON.stringify(items ?? {})) });
      },
      async remove(keys: string | string[]): Promise<void> {
        await t.invoke('storage_remove', { area: name, keys: typeof keys === 'string' ? [keys] : keys });
      },
      async clear(): Promise<void> {
        await t.invoke('storage_clear', { area: name });
      },
    };
  };
  const local = makeArea('local');
  const session = makeArea('session');
  const areas: Record<AreaName, ReturnType<typeof makeArea>> = { local, session };

  // ── runtime: messages ──────────────────────────────────────────────────
  const onMessage = new Ev<MessageListener>();
  const replies = new Map<string, (value: unknown) => void>();

  /**
   * Runs this window's listeners for a message; `respond` is called once:
   * with the first answer (sendResponse, or a promise's value), or with
   * undefined when every listener that might answer did not.
   */
  const dispatch = (msg: unknown, from: string, respond: (value: unknown) => void) => {
    let done = false;
    const once = (value?: unknown) => {
      if (done) return;
      done = true;
      respond(value);
    };
    let waiting = 0;
    const settled = (value: unknown) => {
      if (value !== undefined) once(value);
      else if (--waiting === 0) once(undefined);
    };
    for (const l of onMessage.listeners) {
      let r: unknown;
      try {
        r = l(msg, sender(from), once);
      } catch (err) {
        console.error('[selection-ai] message listener failed', err);
        continue;
      }
      if (r === true) waiting++;
      else if (r && typeof (r as Promise<unknown>).then === 'function') {
        waiting++;
        (r as Promise<unknown>).then(settled, () => settled(undefined));
      }
    }
    if (waiting === 0) once(undefined);
  };

  const sendMessage = (msg: unknown): Promise<unknown> => {
    if (isCore) {
      // The background telling its pages: nobody answers.
      void t.emit('rt:msg', { id: uid(), from: t.label, msg, reply: false } satisfies Wire['msg']).catch(() => {});
      return Promise.resolve(undefined);
    }
    const id = uid();
    return new Promise((resolve) => {
      const timer = setTimeout(() => replies.delete(id) && resolve(undefined), REPLY_TIMEOUT_MS);
      replies.set(id, (value) => {
        clearTimeout(timer);
        replies.delete(id);
        resolve(value);
      });
      t.emitTo(core, 'rt:msg', { id, from: t.label, msg, reply: true } satisfies Wire['msg']).catch(() => {
        replies.get(id)?.(undefined);
      });
    });
  };

  // ── runtime: ports ─────────────────────────────────────────────────────
  const onConnect = new Ev<(port: Port) => void>();
  const ports = new Map<string, { port: Port; other: string; close: () => void }>();

  const makePort = (portId: string, name: string, other: string): Port => {
    let closed = false;
    const close = () => {
      if (closed) return false;
      closed = true;
      ports.delete(portId);
      return true;
    };
    const port: Port = {
      name,
      sender: sender(other),
      onMessage: new Ev(),
      onDisconnect: new Ev(),
      postMessage(message) {
        if (closed) throw new Error('Attempting to use a disconnected port object');
        void t.emitTo(other, 'rt:port', { portId, msg: message } satisfies Wire['port']).catch(() => {});
      },
      disconnect() {
        // As in the extension, only the other end hears about it.
        if (close()) void t.emitTo(other, 'rt:disconnect', { portId } satisfies Wire['disconnect']).catch(() => {});
      },
    };
    ports.set(portId, {
      port,
      other,
      close: () => {
        if (close()) port.onDisconnect.fire(port);
      },
    });
    return port;
  };

  const connect = ({ name = '' }: { name?: string } = {}): Port => {
    const portId = uid();
    const port = makePort(portId, name, core);
    void t.emitTo(core, 'rt:connect', { portId, name, from: t.label } satisfies Wire['connect']).catch(() => ports.get(portId)?.close());
    return port;
  };

  // ── wiring ─────────────────────────────────────────────────────────────
  const ready = Promise.all([
    t.listen<{ area: AreaName; changes: Changes }>('storage:changed', ({ area, changes }) => {
      areas[area]?.onChanged.fire(changes);
      anyChanged.fire(changes, area);
    }),
    t.listen<Wire['msg']>('rt:msg', ({ id, from, msg, reply }) => {
      if (from === t.label) return;
      dispatch(msg, from, (value) => {
        if (reply) void t.emitTo(from, 'rt:reply', { id, value: value ?? null } satisfies Wire['reply']).catch(() => {});
      });
    }),
    t.listen<Wire['reply']>('rt:reply', ({ id, value }) => replies.get(id)?.(value ?? undefined)),
    t.listen<Wire['connect']>('rt:connect', ({ portId, name, from }) => onConnect.fire(makePort(portId, name, from))),
    t.listen<Wire['port']>('rt:port', ({ portId, msg }) => {
      const p = ports.get(portId)?.port;
      p?.onMessage.fire(msg, p);
    }),
    t.listen<Wire['disconnect']>('rt:disconnect', ({ portId }) => ports.get(portId)?.close()),
    // A window was closed (the native core says): its ports are gone.
    t.listen<string>('rt:gone', (label) => {
      for (const p of [...ports.values()]) if (p.other === label) p.close();
    }),
  ]);

  const settingsPage = /(?:options|settings)\.html(#[\w-]*)?$/;
  const openTab = async ({ url }: { url?: string }) => {
    if (!url) return;
    const page = settingsPage.exec(url);
    if (page) await t.invoke('settings_open', { hash: page[1]?.slice(1) ?? null });
    else opts.openUrl?.(url);
  };

  /** A message for one window only, unanswered (the core telling the overlay's bar). */
  const tell = (label: string, msg: unknown): Promise<void> =>
    t.emitTo(label, 'rt:msg', { id: uid(), from: t.label, msg, reply: false } satisfies Wire['msg']).catch(() => {});

  let shortcut: Promise<string> | null = null;
  const browser = {
    /** Resolves once this window hears events (tests wait for it). */
    ready,
    tell,
    storage: { local, session, onChanged: anyChanged },
    runtime: {
      id: RUNTIME_ID,
      lastError: undefined,
      getURL: (path: string) => `${origin}/${path.replace(/^\//, '').replace(/^options\.html/, 'web/settings.html')}`,
      getManifest: () => ({ manifest_version: 3, name: 'Selection AI', version: '0.1.0' }),
      sendMessage,
      onMessage,
      connect,
      onConnect,
      openOptionsPage: () => t.invoke('settings_open', { hash: null }),
    },
    windows: {
      getCurrent: async () => ({ id: WINDOW_ID, focused: true }),
    },
    tabs: {
      create: openTab,
    },
    commands: {
      /** The shortcut the app registered, reported as the extension's toolbar shortcut. */
      getAll: async () => {
        shortcut ??= t
          .invoke<{ shortcut: { shortcut: string; error: string | null } }>('app_info')
          .then((info) => (info.shortcut.error ? '' : info.shortcut.shortcut))
          .catch(() => '');
        return [{ name: '_execute_action', description: 'Start a selection', shortcut: await shortcut }];
      },
    },
  };
  return browser;
}

export type DesktopBrowser = ReturnType<typeof createBrowser>;
