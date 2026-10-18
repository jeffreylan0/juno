import { useCallback, useEffect, useRef } from 'react';

/**
 * Calls `fn` once typing pauses. A change still waiting when the field goes
 * away (another choice picked) or the page is left is saved right then, not
 * dropped.
 */
export function useDebounced<T>(fn: (value: T) => void, ms = 450): (value: T) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<{ value: T } | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const flush = () => {
      clearTimeout(timer.current);
      if (!pending.current) return;
      const { value } = pending.current;
      pending.current = null;
      latest.current(value);
    };
    addEventListener('pagehide', flush);
    return () => {
      removeEventListener('pagehide', flush);
      flush();
    };
  }, []);
  return useCallback(
    (value: T) => {
      clearTimeout(timer.current);
      pending.current = { value };
      timer.current = setTimeout(() => {
        pending.current = null;
        latest.current(value);
      }, ms);
    },
    [ms],
  );
}

