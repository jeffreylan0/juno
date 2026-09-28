/**
 * Node shim for WXT's `#imports` so extension/lib modules that only need types
 * can be loaded by the eval scripts. Anything touching browser APIs must not be
 * imported here.
 */
export const storage = {
  defineItem<T>(_key: string, opts: { fallback: T }) {
    let value = opts.fallback;
    return {
      getValue: async () => value,
      setValue: async (v: T) => {
        value = v;
      },
      watch: (_cb: (v: T) => void) => () => {},
    };
  },
};
export type ContentScriptContext = unknown;
