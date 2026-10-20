/**
 * The native core (src-tauri), played in memory, for the app's own `browser`
 * (desktop/src/platform/browser.ts): storage areas every window shares,
 * events by window, and the commands the shim sends.
 */
import type { Transport } from '../../desktop/src/platform/transport';

type Handler = (payload: unknown) => void;

/** Changes to these are announced without their values, as lib.rs does. */
const SECRET = new Set(['account']);

/** The native core, played in memory: storage areas, events by window, commands. */
export function fakeCore(opts: { delay?: (event: string) => number } = {}) {
  const listeners = new Map<string, Map<string, Set<Handler>>>();
  const areas: Record<string, Map<string, unknown>> = { local: new Map(), session: new Map() };
  const invoked: Array<[string, string, Record<string, unknown> | undefined]> = [];
  let port = 50000;
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
        changes[k] = SECRET.has(k) ? {} : { ...(a.has(k) ? { oldValue: a.get(k) } : {}), newValue: v };
        a.set(k, v);
      }
      if (Object.keys(changes).length) emitAll('storage:changed', { area, changes });
    },
    storage_remove: ({ area, keys }) => {
      const a = areas[area as string]!;
      const changes: Record<string, unknown> = {};
      for (const k of keys as string[]) if (a.has(k)) (changes[k] = SECRET.has(k) ? {} : { oldValue: a.get(k) }), a.delete(k);
      if (Object.keys(changes).length) emitAll('storage:changed', { area, changes });
    },
    app_info: () => ({ version: '0.1.0', shortcut: { shortcut: '⌥⇧S', error: null } }),
    auth_listen: () => ++port,
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
  });
  /** A window closing: the native core tells everyone. */
  const close = (label: string) => {
    listeners.delete(label);
    emitAll('rt:gone', label);
  };
  return { transport, areas, invoked, close };
}
