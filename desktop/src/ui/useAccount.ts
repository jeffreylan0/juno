/**
 * The signed-in account, as the settings page and the panel see it: who is
 * signed in, what the account may use, and how the cloud copy is doing. All
 * three live in storage.local and follow every change. Also the extras
 * (lib/extras.ts) and the unlock that opens them without an account.
 */
import { useEffect, useState } from 'react';
import { ACCOUNTS } from '@/lib/account/config';
import { entitlementItem, sessionItem, syncStatusItem, type AccountUser, type Entitlement, type SyncStatus } from '@/lib/account/session';
import { unlockItem, type Unlock } from '@/lib/account/unlock';
import { watchExtras } from '@/lib/extras';

export interface AccountState {
  /** False until storage has been read. */
  ready: boolean;
  user: AccountUser | null;
  entitlement: Entitlement | null;
  sync: SyncStatus;
}

export function useAccount(): AccountState {
  const [state, setState] = useState<AccountState>({ ready: !ACCOUNTS, user: null, entitlement: null, sync: { state: 'off' } });
  useEffect(() => {
    if (!ACCOUNTS) return;
    let live = true;
    const read = async () => {
      const [session, entitlement, sync] = await Promise.all([sessionItem.getValue(), entitlementItem.getValue(), syncStatusItem.getValue()]);
      if (live) setState({ ready: true, user: session?.user ?? null, entitlement: session ? entitlement : null, sync });
    };
    void read();
    const unwatch = [sessionItem.watch(() => void read()), entitlementItem.watch(() => void read()), syncStatusItem.watch(() => void read())];
    return () => {
      live = false;
      unwatch.forEach((fn) => fn());
    };
  }, []);
  return state;
}

/** Whether hosted answers can be offered: the account's plan includes some. */
export const hasHosted = (a: AccountState) => !!a.user && (a.entitlement?.quota ?? 0) > 0;

/** Whether the extras are open (lib/extras.ts): a plan, or the unlock. */
export function useExtrasOpen(): boolean {
  const [open, setOpen] = useState(!ACCOUNTS);
  useEffect(() => watchExtras(setOpen), []);
  return open;
}

/** The unlock bought on this computer (or entered from another), if any. */
export function useUnlock(): Unlock | null {
  const [unlock, setUnlock] = useState<Unlock | null>(null);
  useEffect(() => {
    void unlockItem.getValue().then(setUnlock, () => {});
    return unlockItem.watch(setUnlock);
  }, []);
  return unlock;
}
