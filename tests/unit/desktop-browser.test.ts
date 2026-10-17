/**
 * The app's `browser` (desktop/src/platform/browser.ts): several windows
 * over one in-memory "native core". What the rest of the code relies on: storage that
 * every window sees change, messages the core answers, and a port that
 * closes when its window goes.
 */
import { describe, expect, it, vi } from 'vitest';
import { AUTH_REDIRECT, WINDOW_ID, createBrowser } from '../../desktop/src/platform/browser';
import type { Transport } from '../../desktop/src/platform/transport';
import { pageTitle } from '../../desktop/src/core/tips';
import { isExternal } from '../../desktop/src/platform/net';
import { readPointerState, trackPointer } from '../../desktop/src/overlay/pointer';

type Handler = (payload: unknown) => void;

/** The native core, played in memory: storage areas, events by window, commands. */
function fakeCore(opts: { delay?: (event: string) => number } = {}) {
  const listeners = new Map<string, Map<string, Set<Handler>>>();
  const areas: Record<string, Map<string, unknown>> = { local: new Map(), session: new Map() };
  const invoked: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const deliver = (label: string, event: string, payload: unknown) => {
    // Through JSON, as the real IPC does.
    const copy = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
    const wait = opts.delay?.(event) ?? 0;
    for (const h of listeners.get(label)?.get(event) ?? []) {
      if (wait) setTimeout(() => h(copy), wait);
      else queueMicrotask(() => h(copy));
    }
  };
  const emitAll = (event: string, payload: unknown) => {
    for (const label of listeners.keys()) deliver(label, event, payload);
  };
  const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
    storage_get: ({ area, keys }) => {
      const a = areas[area as string]!;
      const list = (keys as string[] | null) ?? [...a.keys()];
      return Object.fromEntries(list.filter((k) => a.has(k)).map((k) => [k, a.get(k)]));
    },
    storage_set: ({ area, items }) => {
      const a = areas[area as string]!;
      const changes: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(items as Record<string, unknown>)) {
        if (JSON.stringify(a.get(k)) === JSON.stringify(v)) continue;
        changes[k] = { ...(a.has(k) ? { oldValue: a.get(k) } : {}), newValue: v };
        a.set(k, v);
      }
      if (Object.keys(changes).length) emitAll('storage:changed', { area, changes });
    },
    storage_remove: ({ area, keys }) => {
      const a = areas[area as string]!;
      const changes: Record<string, unknown> = {};
      for (const k of keys as string[]) if (a.has(k)) (changes[k] = { oldValue: a.get(k) }), a.delete(k);
      if (Object.keys(changes).length) emitAll('storage:changed', { area, changes });
    },
    app_info: () => ({ version: '0.1.0', shortcut: { shortcut: '⌥⇧S', error: null } }),
  };
  const transport = (label: string): Transport => ({
    label,
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      invoked.push([label, command, args]);
      return (commands[command]?.(args ?? {}) ?? null) as T;
    },
    listen: async (event, handler) => {
      const byEvent = listeners.get(label) ?? new Map<string, Set<Handler>>();
      listeners.set(label, byEvent);
      const set = byEvent.get(event) ?? new Set<Handler>();
      byEvent.set(event, set);
      set.add(handler as Handler);
      return () => set.delete(handler as Handler);
    },
    emitTo: async (to, event, payload) => deliver(to, event, payload),
    emit: async (event, payload) => emitAll(event, payload),
  });
  /** A window closing: the native core tells everyone. */
  const close = (label: string) => {
    listeners.delete(label);
    emitAll('rt:gone', label);
  };
  return { transport, areas, invoked, close };
}

async function windows(...labels: string[]) {
  return await windowsOver(fakeCore(), ...labels);
}

async function windowsOver(hub: ReturnType<typeof fakeCore>, ...labels: string[]) {
  const opened = Object.fromEntries(labels.map((l) => [l, createBrowser(hub.transport(l), { origin: 'tauri://localhost' })]));
  await Promise.all(Object.values(opened).map((b) => b.ready));
  return { hub, ...opened } as { hub: ReturnType<typeof fakeCore> } & Record<string, ReturnType<typeof createBrowser>>;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('storage', () => {
  it('is shared by every window, and every window hears a change', async () => {
    const w = await windows('core', 'panel');
    const heard = vi.fn();
    const heardLocal = vi.fn();
    w.panel!.storage.onChanged.addListener(heard);
    w.panel!.storage.local.onChanged.addListener(heardLocal);
    await w.core!.storage.local.set({ 'chat:1': { id: '1', items: [] } });
    await settle();
    expect(await w.panel!.storage.local.get('chat:1')).toEqual({ 'chat:1': { id: '1', items: [] } });
    expect(heard).toHaveBeenCalledWith({ 'chat:1': { newValue: { id: '1', items: [] } } }, 'local');
    expect(heardLocal).toHaveBeenCalledWith({ 'chat:1': { newValue: { id: '1', items: [] } } });
  });

  it('keeps the areas apart, and reads defaults, lists, everything', async () => {
    const w = await windows('core');
    await w.core!.storage.session.set({ 'current:1': { chatId: 'a', temporary: true } });
    await w.core!.storage.local.set({ a: 1, b: 2 });
    expect(await w.core!.storage.local.get('current:1')).toEqual({});
    expect(await w.core!.storage.local.get({ a: 0, c: 3 })).toEqual({ a: 1, c: 3 });
    expect(await w.core!.storage.local.get(['a', 'b'])).toEqual({ a: 1, b: 2 });
    expect(Object.keys(await w.core!.storage.local.get(null))).toEqual(['a', 'b']);
    await w.core!.storage.local.remove('a');
    expect(await w.core!.storage.local.get(null)).toEqual({ b: 2 });
  });

  it('drops undefined values, as JSON does', async () => {
    const w = await windows('core');
    await w.core!.storage.local.set({ s: { a: 1, gone: undefined } });
    expect(w.hub.areas.local.get('s')).toEqual({ a: 1 });
  });
});

describe('messages', () => {
  it('go from any window to the core, which answers', async () => {
    const w = await windows('core', 'panel', 'overlay');
    w.core!.runtime.onMessage.addListener((msg: unknown, sender: { origin: string }, respond: (r: unknown) => void) => {
      if ((msg as { type: string }).type === 'sync') respond({ from: sender.origin });
    });
    w.core!.runtime.onMessage.addListener((msg: unknown, _s: unknown, respond: (r: unknown) => void) => {
      if ((msg as { type: string }).type !== 'later') return;
      setTimeout(() => respond('done later'), 5);
      return true;
    });
    w.core!.runtime.onMessage.addListener(async (msg: unknown) => ((msg as { type: string }).type === 'promise' ? 42 : undefined));
    // Other windows never hear another window's messages.
    const overlaySaw = vi.fn();
    w.overlay!.runtime.onMessage.addListener(overlaySaw);

    expect(await w.panel!.runtime.sendMessage({ type: 'sync' })).toEqual({ from: 'panel' });
    expect(await w.panel!.runtime.sendMessage({ type: 'later' })).toBe('done later');
    expect(await w.overlay!.runtime.sendMessage({ type: 'promise' })).toBe(42);
    expect(await w.panel!.runtime.sendMessage({ type: 'nobody' })).toBeUndefined();
    expect(overlaySaw).not.toHaveBeenCalled();
  });

  it('from the core reach every other window, unanswered', async () => {
    const w = await windows('core', 'panel', 'overlay');
    const panel = vi.fn();
    const overlay = vi.fn();
    const core = vi.fn();
    w.panel!.runtime.onMessage.addListener(panel);
    w.overlay!.runtime.onMessage.addListener(overlay);
    w.core!.runtime.onMessage.addListener(core);
    expect(await w.core!.runtime.sendMessage({ type: 'panel:close' })).toBeUndefined();
    await settle();
    expect(panel).toHaveBeenCalledWith({ type: 'panel:close' }, expect.objectContaining({ origin: 'core' }), expect.any(Function));
    expect(overlay).toHaveBeenCalled();
    expect(core).not.toHaveBeenCalled();
  });

  it('can be told to one window only', async () => {
    const w = await windows('core', 'panel', 'overlay');
    const panel = vi.fn();
    const overlay = vi.fn();
    w.panel!.runtime.onMessage.addListener(panel);
    w.overlay!.runtime.onMessage.addListener(overlay);
    await w.core!.tell('overlay', { type: 'bar:show', mode: 'box', ghost: false });
    await settle();
    expect(overlay).toHaveBeenCalledWith({ type: 'bar:show', mode: 'box', ghost: false }, expect.anything(), expect.any(Function));
    expect(panel).not.toHaveBeenCalled();
  });
});

describe('ports', () => {
  it('connect the panel to the core both ways, and close when the panel goes', async () => {
    const w = await windows('core', 'panel');
    const fromPanel = vi.fn();
    const closed = vi.fn();
    w.core!.runtime.onConnect.addListener((port) => {
      expect(port.name).toBe('panel');
      expect(port.sender.origin).toBe('panel');
      port.onMessage.addListener((msg) => {
        fromPanel(msg);
        port.postMessage({ type: 'ready' });
      });
      port.onDisconnect.addListener(closed);
    });
    const port = w.panel!.runtime.connect({ name: 'panel' });
    const fromCore = vi.fn();
    port.onMessage.addListener(fromCore);
    port.postMessage({ type: 'hello', windowId: WINDOW_ID });
    await vi.waitFor(() => expect(fromCore).toHaveBeenCalledWith({ type: 'ready' }, port));
    expect(fromPanel).toHaveBeenCalledWith({ type: 'hello', windowId: 1 });

    // The panel window is closed: the core hears the port go.
    w.hub.close('panel');
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });

  it('keep a first message that overtook the connect (each event is its own command in the native core)', async () => {
    const w = await windowsOver(fakeCore({ delay: (e) => (e === 'rt:connect' ? 15 : 0) }), 'core', 'panel');
    const fromPanel = vi.fn();
    const closed = vi.fn();
    w.core!.runtime.onConnect.addListener((port) => {
      port.onMessage.addListener(fromPanel);
      port.onDisconnect.addListener(closed);
    });
    const port = w.panel!.runtime.connect({ name: 'panel' });
    port.postMessage({ type: 'hello', windowId: WINDOW_ID });
    await vi.waitFor(() => expect(fromPanel).toHaveBeenCalledWith({ type: 'hello', windowId: 1 }, expect.anything()));

    // And a disconnect that overtook its connect still closes it.
    const second = w.panel!.runtime.connect({ name: 'panel' });
    second.disconnect();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });

  it('disconnect tells only the other end, once', async () => {
    const w = await windows('core', 'panel');
    const coreSide = vi.fn();
    w.core!.runtime.onConnect.addListener((port) => port.onDisconnect.addListener(coreSide));
    const port = w.panel!.runtime.connect({ name: 'panel' });
    const panelSide = vi.fn();
    port.onDisconnect.addListener(panelSide);
    await settle();
    port.disconnect();
    port.disconnect();
    await vi.waitFor(() => expect(coreSide).toHaveBeenCalledTimes(1));
    expect(panelSide).not.toHaveBeenCalled();
    expect(() => port.postMessage({})).toThrow(/disconnected/);
  });
});

describe('the rest of the browser', () => {
  it('has one window, the settings page for options, and the app shortcut as the toolbar one', async () => {
    const w = await windows('panel');
    expect(await w.panel!.windows.getCurrent()).toMatchObject({ id: WINDOW_ID });
    expect(await w.panel!.commands.getAll()).toEqual([expect.objectContaining({ name: '_execute_action', shortcut: '⌥⇧S' })]);

    await w.panel!.runtime.openOptionsPage('account');
    expect(w.hub.invoked).toContainEqual(['panel', 'settings_open', { hash: 'account' }]);
    await w.panel!.runtime.openOptionsPage();
    expect(w.hub.invoked).toContainEqual(['panel', 'settings_open', { hash: null }]);
  });
});

describe('Google sign-in in the app', () => {
  it('opens Google in the browser and resolves with the link the app hears back, ignoring any other', async () => {
    const hub = fakeCore();
    const opened: string[] = [];
    const settings = createBrowser(hub.transport('settings'), { origin: 'tauri://localhost', openUrl: (u) => opened.push(u) });
    await settings.ready;
    expect(settings.identity.getRedirectURL()).toBe(AUTH_REDIRECT);
    const flow = settings.identity.launchWebAuthFlow({ url: 'https://proj.supabase.co/auth/v1/authorize?provider=google', interactive: true });
    await settle();
    expect(opened).toEqual(['https://proj.supabase.co/auth/v1/authorize?provider=google']);
    // What lib.rs emits when the system opens the app's link.
    const send = (url: string) => hub.transport('core').emitTo('settings', 'app:deep-link', url);
    await send('com.humanbn.juno://something-else');
    await send(`${AUTH_REDIRECT}?code=abc`);
    expect(await flow).toBe(`${AUTH_REDIRECT}?code=abc`);
  });
});

describe('which requests go out through the native core', () => {
  it('sites and local models do; the app’s own page, commands and files never do', () => {
    // Windows: the page is http://tauri.localhost and Tauri's commands are fetches to http://ipc.localhost.
    const windows = 'http://tauri.localhost';
    expect(isExternal('http://ipc.localhost/app_info', windows)).toBe(false);
    expect(isExternal('http://ipc.localhost/plugin%3Ahttp%7Cfetch', windows)).toBe(false);
    expect(isExternal('http://asset.localhost/x.png', windows)).toBe(false);
    expect(isExternal('/assets/core.js', windows)).toBe(false);
    // macOS and Linux: their own schemes.
    expect(isExternal('ipc://localhost/app_info', 'tauri://localhost')).toBe(false);
    // Everything else leaves the app.
    expect(isExternal('https://api.anthropic.com/v1/messages', windows)).toBe(true);
    expect(isExternal('http://localhost:11434/v1/models', windows)).toBe(true);
    expect(isExternal('http://127.0.0.1:1234/v1/models', 'tauri://localhost')).toBe(true);
  });
});

describe('a selection’s title in the app', () => {
  it('is the name of what the window shows, without the app’s name', () => {
    expect(pageTitle({ app: 'Preview', title: 'Chapter 3.pdf' })).toBe('Chapter 3.pdf');
    expect(pageTitle({ app: 'WINWORD', title: 'Lab report - Word' })).toBe('Lab report');
    expect(pageTitle({ app: 'Safari', title: 'Kinematics — Safari' })).toBe('Kinematics');
    expect(pageTitle({ app: 'firefox', title: 'Quiz 2.1 - Assignments | Stemble — Mozilla Firefox' })).toBe('Quiz 2.1 - Assignments | Stemble');
    expect(pageTitle({ app: 'msedge', title: 'Kinematics and 3 more pages - Microsoft\u200b Edge' })).toBe('Kinematics');
    expect(pageTitle({ app: 'Notability', title: '' })).toBe('Notability');
    expect(pageTitle({ app: '', title: '  Notes   1 ' })).toBe('Notes 1');
    // A last part that is not the app stays.
    expect(pageTitle({ app: 'Firefox', title: 'Lecture 4 - Physics 7C' })).toBe('Lecture 4 - Physics 7C');
    expect(pageTitle({ app: 'Google Chrome', title: 'Essay - Google Docs' })).toBe('Essay - Google Docs');
  });

  it('leaves out counters that change from one step to the next', () => {
    const quiz = 'Quiz 2.1 - Assignments - Chem 1LD F26 | Stemble';
    expect(pageTitle({ app: 'Firefox', title: `Task 10 of 13 - ${quiz}` })).toBe(quiz);
    expect(pageTitle({ app: 'Firefox', title: `Task 1 of 13 - ${quiz}` })).toBe(quiz);
    expect(pageTitle({ app: 'chrome', title: 'Question 3/20 | Practice exam - Google Chrome' })).toBe('Practice exam');
    expect(pageTitle({ app: 'Firefox', title: '(4) Inbox' })).toBe('Inbox');
    expect(pageTitle({ app: 'Firefox', title: 'Inbox (12) - me@school.edu - Mail' })).toBe('Inbox - me@school.edu - Mail');
    // Nothing left but the counter: the app's name.
    expect(pageTitle({ app: 'Keynote', title: 'Slide 4 of 30' })).toBe('Keynote');
  });
});

describe('which parts of the overlay take the pointer', () => {
  function overlay(state: string | null, opts: { leaving?: boolean } = {}) {
    document.body.replaceChildren();
    document.querySelectorAll('selection-ai-overlay').forEach((e) => e.remove());
    if (state !== null) {
      const host = document.createElement('selection-ai-overlay');
      host.setAttribute('data-state', state);
      if (opts.leaving) host.setAttribute('data-leaving', '');
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.getBoundingClientRect = () => ({ left: 365.4, top: 731, width: 549.2, height: 45, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} });
      host.attachShadow({ mode: 'open' }).append(bar);
      document.documentElement.append(host);
    }
  }

  it('all of it while selecting; the bar while waiting; nothing when nothing shows', () => {
    overlay('armed');
    expect(readPointerState()).toEqual({ interactive: true, regions: [{ x: 365, y: 731, width: 550, height: 45 }], idle: false });
    overlay('drawing');
    expect(readPointerState().interactive).toBe(true);
    overlay('ready');
    expect(readPointerState()).toEqual({ interactive: false, regions: [{ x: 365, y: 731, width: 550, height: 45 }], idle: false });
    overlay('sending');
    expect(readPointerState().interactive).toBe(false);
    overlay('ready', { leaving: true });
    expect(readPointerState().regions).toEqual([]);
    overlay(null);
    expect(readPointerState()).toEqual({ interactive: false, regions: [], idle: true });
  });

  it('hides the window only once an empty frame has been drawn, and not if the bar came back', async () => {
    const calls: string[] = [];
    const t = { invoke: async (cmd: string) => void calls.push(cmd), listen: async () => () => {} } as unknown as Transport;
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))));
    overlay('ready');
    const stop = trackPointer(t);
    overlay(null);
    await Promise.resolve();
    expect(calls).not.toContain('overlay_hide');
    await frames();
    expect(calls.filter((c) => c === 'overlay_hide')).toHaveLength(1);

    // Gone and straight back (the shortcut again): the window stays.
    calls.length = 0;
    overlay('armed');
    await Promise.resolve();
    overlay(null);
    await Promise.resolve();
    overlay('armed');
    await frames();
    expect(calls).not.toContain('overlay_hide');
    stop();
  });
});
