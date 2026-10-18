import { useEffect, useState } from 'react';
import type { KeyStatus } from '@/lib/providers/types';
import { keyStatus, watchKeys } from '../platform/vault';

/** Which API keys there are (never the keys: platform/vault.ts), kept up to date; null until known. */
export function useKeyStatus(): KeyStatus | null {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  useEffect(() => {
    void keyStatus().then(setStatus, () => {});
    return watchKeys(setStatus);
  }, []);
  return status;
}
