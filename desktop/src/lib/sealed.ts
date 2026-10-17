/**
 * API keys and the account's session, at rest. storage.local is readable by
 * content scripts, which share a process with the pages they run on, so a
 * page that broke out of its sandbox would be one step from the keys. In the
 * extension they are sealed (AES-GCM) with a key that never leaves the
 * extension's own origin: a non-extractable CryptoKey in its IndexedDB, which
 * content scripts can't open. What a content script could read is ciphertext.
 *
 * The app keeps them in its own private file instead (store.rs), so there
 * this is a pass-through. A value stored before sealing (or by a test) is read
 * as is and sealed on the next write; the background seals it at start.
 */
import { storage } from '@wxt-dev/storage';

const SEAL = import.meta.env.SAI_IN_PAGE === true;

export interface Sealed {
  sealed: 1;
  iv: string;
  data: string;
}

const isSealed = (v: unknown): v is Sealed => !!v && typeof v === 'object' && (v as Sealed).sealed === 1;
const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sealWith(key: CryptoKey, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { sealed: 1, iv: toB64(iv), data: toB64(new Uint8Array(data)) };
}

export async function openWith<T>(key: CryptoKey, box: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

// ── The sealing key, in the extension origin's IndexedDB ──────────────────

const DB = 'selection-ai-seal';
const STORE = 'keys';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

let sealingKey: Promise<CryptoKey> | null = null;

function keyForSealing(): Promise<CryptoKey> {
  sealingKey ??= (async () => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    const db = await request(open);
    const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    // One read-write transaction: two pages starting at once agree on one key.
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const found = (await request(store.get('seal'))) as CryptoKey | undefined;
    if (!found) store.put(fresh, 'seal');
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return found ?? fresh;
  })();
  sealingKey.catch(() => (sealingKey = null));
  return sealingKey;
}

// ── An item like storage.defineItem's, sealed ─────────────────────────────

export interface SealedItem<T> {
  getValue(): Promise<T>;
  setValue(value: T): Promise<void>;
  removeValue(): Promise<void>;
  watch(cb: (value: T, old: T) => void): () => void;
  /** Seals a value stored before sealing (a no-op otherwise). */
  reseal(): Promise<void>;
}

export function sealedItem<T>(key: `local:${string}`, fallback: T): SealedItem<T> {
  const item = storage.defineItem<unknown>(key, { fallback });
  const open = async (stored: unknown): Promise<T> => {
    if (!isSealed(stored)) return (stored ?? fallback) as T;
    try {
      return await openWith<T>(await keyForSealing(), stored);
    } catch {
      // The sealing key is gone (the extension's data was cleared): as if never set.
      console.warn(`[selection-ai] ${key} could not be unsealed; it has to be entered again`);
      return fallback;
    }
  };
  return {
    getValue: async () => await open(await item.getValue()),
    setValue: async (value) => await item.setValue(SEAL ? await sealWith(await keyForSealing(), value) : value),
    removeValue: async () => await item.removeValue(),
    watch: (cb) => item.watch((now, before) => void Promise.all([open(now), open(before)]).then(([a, b]) => cb(a, b))),
    reseal: async () => {
      const stored = await item.getValue();
      if (!SEAL || isSealed(stored) || JSON.stringify(stored ?? fallback) === JSON.stringify(fallback)) return;
      await item.setValue(await sealWith(await keyForSealing(), stored));
    },
  };
}
