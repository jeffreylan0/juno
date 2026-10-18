/**
 * A WebExtension-shaped `browser` for the app's windows (the code began as a
 * browser extension). Installed as `globalThis.browser`, it is what lib/
 * (chats, the current chat, images, settings, accounts, sync), ui/ (the
 * panel) and the settings page talk to, as do WXT's `storage` helpers, which
 * read `globalThis.browser`.
 *
 *  - storage.local / storage.session: kept by the native core (store.rs),
 *    shared by every window; every change reaches every window's
 *    `onChanged`.
 *  - runtime.sendMessage: from any other window to the core window, which
 *    answers; the core tells a window something with `tell`.
 *  - runtime.connect: a port to the core. It disconnects when either window
 *    goes, which is how the core hears that the panel was closed.
 */
import type { Transport } from './transport';

/** The one window of chats (lib/current.ts keys everything by window). */
export const WINDOW_ID = 1;
export const RUNTIME_ID = 'selection-ai-desktop';
/** How long a message waits for the core's answer before giving up. */
const REPLY_TIMEOUT_MS = 120_000;
/** How long a port's messages wait for a connect that was overtaken. */
const EARLY_PORT_MS = 10_000;

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

/** Where Google sign-in comes back to: the app's own link (lib.rs hands it to settings as `app:deep-link`). */
export const AUTH_REDIRECT = 'com.humanbn.juno://auth/callback';
/** How long a sign-in in the browser is waited for. */
const AUTH_WAIT_MS = 10 * 60_000;

export interface BrowserOptions {
  /** The label of the core window, which answers messages. */
  core?: string;
  /** Opens a link in the student's browser. */
  openUrl?: (url: string) => void;
  /** The page's origin, which names the sender of its messages. */
  origin?: string;
}

export function createBrowser(t: Transport, opts: BrowserOptions = {}) {
  const core = opts.core ?? 'core';
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
        // Stored as JSON: plain data only, undefined values left out.
        await t.invoke('storage_set', { area: name, items: JSON.parse(JSON.stringify(items ?? {})) });
      },
      async remove(keys: string | string[]): Promise<void> {
        await t.invoke('storage_remove', { area: name, keys: typeof keys === 'string' ? [keys] : keys });
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
  /**
   * Each event is its own async command in the native core, so a port's
   * first message (the panel's hello, posted right after connect) can arrive
   * before the connect itself. It waits here for its port, briefly.
   */
  const early = new Map<string, { messages: unknown[]; closed: boolean }>();
  const earlyFor = (portId: string) => {
    let e = early.get(portId);
    if (!e) {
      e = { messages: [], closed: false };
      early.set(portId, e);
      setTimeout(() => early.delete(portId), EARLY_PORT_MS);
    }
    return e;
  };

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
        // Only the other end hears about it.
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
  /** Each secret's value as this window last heard of it: the oldValue of its next change. */
  const secretsSeen = new Map<string, unknown>();
  const ready = Promise.all([
    t.listen<{ area: AreaName; changes: Changes }>('storage:changed', async ({ area, changes }) => {
      // A secret's change (the account session) comes without its values,
      // since any page could hear the event: read it back, through the checks.
      const blind = Object.keys(changes).filter((k) => !('oldValue' in changes[k]!) && !('newValue' in changes[k]!));
      if (blind.length) {
        const now = await t.invoke<Record<string, unknown>>('storage_get', { area, keys: blind });
        for (const k of blind) {
          changes[k] = { oldValue: secretsSeen.get(k), newValue: now[k] };
          secretsSeen.set(k, now[k]);
        }
      }
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
    t.listen<Wire['connect']>('rt:connect', ({ portId, name, from }) => {
      const port = makePort(portId, name, from);
      onConnect.fire(port);
      const waiting = early.get(portId);
      early.delete(portId);
      for (const msg of waiting?.messages ?? []) port.onMessage.fire(msg, port);
      if (waiting?.closed) ports.get(portId)?.close();
    }),
    t.listen<Wire['port']>('rt:port', ({ portId, msg }) => {
      const p = ports.get(portId)?.port;
      if (p) p.onMessage.fire(msg, p);
      else earlyFor(portId).messages.push(msg);
    }),
    t.listen<Wire['disconnect']>('rt:disconnect', ({ portId }) => {
      const p = ports.get(portId);
      if (p) p.close();
      else earlyFor(portId).closed = true;
    }),
    // A window was closed (the native core says): its ports are gone.
    t.listen<string>('rt:gone', (label) => {
      for (const p of [...ports.values()]) if (p.other === label) p.close();
    }),
  ]);

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
      sendMessage,
      onMessage,
      connect,
      onConnect,
      /** The settings window, at `section` if one is named ("account"). */
      openOptionsPage: (section?: string) => t.invoke('settings_open', { hash: section ?? null }),
    },
    /**
     * Sign-in (lib/account/session.ts): the page opens in the student's
     * browser, and the answer comes back through the app's link.
     */
    identity: {
      getRedirectURL: () => AUTH_REDIRECT,
      launchWebAuthFlow: ({ url }: { url: string; interactive?: boolean }) =>
        new Promise<string>((resolve, reject) => {
          let off = () => {};
          const timer = setTimeout(() => {
            off();
            reject(new Error('Sign-in timed out'));
          }, AUTH_WAIT_MS);
          void t
            .listen<string>('app:deep-link', (back) => {
              if (!back.startsWith(AUTH_REDIRECT)) return;
              clearTimeout(timer);
              off();
              resolve(back);
            })
            .then((unlisten) => (off = unlisten));
          opts.openUrl?.(url);
        }),
    },
    commands: {
      /** The shortcut the app registered (ui/useShortcut.ts). */
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
