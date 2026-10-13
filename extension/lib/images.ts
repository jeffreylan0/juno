/**
 * Screenshots, kept apart from the chats that show them.
 *
 * Chats are small JSON in extension storage; a screenshot can be a megabyte
 * of base64, and ten saved chats with a few each would blow through
 * storage.local's 10 MB. So images live in the extension's own IndexedDB
 * (no extra permission, not readable by web pages, not synced anywhere), and
 * a chat's image parts carry a reference, `idb:<id>`, instead of the pixels.
 * The background swaps references back for pixels just before a request;
 * the panel resolves them to show the picture.
 *
 * A temporary chat's screenshots never touch the disk: they go to
 * storage.session (memory only), referenced as `mem:<id>`, and go with the
 * chat. Only if that fills up (Chrome allows 10 MB) do they fall back to
 * IndexedDB, which the chat's deletion clears just the same.
 *
 * Everything stays on this computer; with cloud storage on, account/sync.ts
 * copies the screenshots to the account as well.
 *
 * jsdom has no IndexedDB, so unit tests get an in-memory store with the same
 * interface.
 */
import type { Part, Plan } from '@shared/payload';

export const IMAGE_REF = 'idb:';

export interface StoredImage {
  id: string;
  chatId: string;
  dataUrl: string;
  createdAt: number;
}

export interface ImageStore {
  put(image: StoredImage): Promise<void>;
  get(id: string): Promise<StoredImage | undefined>;
  delete(ids: string[]): Promise<void>;
  deleteForChat(chatId: string): Promise<void>;
  chatIds(): Promise<Set<string>>;
}

const DB_NAME = 'selection-ai';
const STORE = 'images';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class IdbImageStore implements ImageStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('chatId', 'chatId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async put(image: StoredImage): Promise<void> {
    await request((await this.store('readwrite')).put(image));
  }

  async get(id: string): Promise<StoredImage | undefined> {
    return (await request((await this.store('readonly')).get(id))) as StoredImage | undefined;
  }

  async delete(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const store = await this.store('readwrite');
    await Promise.all(ids.map((id) => request(store.delete(id))));
  }

  async deleteForChat(chatId: string): Promise<void> {
    const store = await this.store('readwrite');
    const keys = await request(store.index('chatId').getAllKeys(chatId));
    await Promise.all(keys.map((k) => request(store.delete(k))));
  }

  /** Every chat that owns at least one image, read from the index alone (no pixels loaded). */
  async chatIds(): Promise<Set<string>> {
    const index = (await this.store('readonly')).index('chatId');
    return await new Promise((resolve, reject) => {
      const ids = new Set<string>();
      const cursor = index.openKeyCursor(null, 'nextunique');
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve(ids);
        ids.add(String(c.key));
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
  }
}

export class MemoryImageStore implements ImageStore {
  readonly map = new Map<string, StoredImage>();
  async put(image: StoredImage) {
    this.map.set(image.id, image);
  }
  async get(id: string) {
    return this.map.get(id);
  }
  async delete(ids: string[]) {
    for (const id of ids) this.map.delete(id);
  }
  async deleteForChat(chatId: string) {
    for (const [id, img] of this.map) if (img.chatId === chatId) this.map.delete(id);
  }
  async chatIds() {
    return new Set([...this.map.values()].map((i) => i.chatId));
  }
}

let current: ImageStore | null = null;

export function images(): ImageStore {
  current ??= typeof indexedDB === 'undefined' ? new MemoryImageStore() : new IdbImageStore();
  return current;
}

/** Tests swap in a fresh store. */
export function setImageStore(store: ImageStore): void {
  current = store;
}

/** A temporary chat's screenshot, in memory (storage.session). */
export const MEMORY_REF = 'mem:';
const memKey = (id: string) => `img:${id}`;
const session = () => (browser.storage as unknown as { session: chrome.storage.StorageArea }).session;

export const isImageRef = (dataUrl: string) => dataUrl.startsWith(IMAGE_REF) || dataUrl.startsWith(MEMORY_REF);

/** Moves a plan's screenshots into the image store; the plan keeps references. */
export async function storePlanImages(plan: Plan, chatId: string, temporary = false): Promise<Plan> {
  const parts: Part[] = [];
  for (const part of plan.parts) {
    if (part.kind !== 'image' || isImageRef(part.dataUrl)) {
      parts.push(part);
      continue;
    }
    const id = crypto.randomUUID();
    if (temporary) {
      try {
        await session().set({ [memKey(id)]: { chatId, dataUrl: part.dataUrl } });
        parts.push({ ...part, dataUrl: `${MEMORY_REF}${id}` });
        continue;
      } catch {
        // Session storage is full; IndexedDB it is, deleted with the chat all the same.
      }
    }
    await images().put({ id, chatId, dataUrl: part.dataUrl, createdAt: Date.now() });
    parts.push({ ...part, dataUrl: `${IMAGE_REF}${id}` });
  }
  return { ...plan, parts };
}

/** Pixels inline. Anything else in a chat (a chat row from the cloud is data, not code) is never fetched or sent on. */
const INLINE_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,/;
export const isInlineImage = (dataUrl: string) => INLINE_IMAGE.test(dataUrl);

/** The pixels behind a reference, wherever they are kept; undefined if gone. */
export async function getImage(ref: string): Promise<string | undefined> {
  if (ref.startsWith(MEMORY_REF)) {
    const key = memKey(ref.slice(MEMORY_REF.length));
    return ((await session().get(key))[key] as { dataUrl: string } | undefined)?.dataUrl;
  }
  if (ref.startsWith(IMAGE_REF)) return (await images().get(ref.slice(IMAGE_REF.length)))?.dataUrl;
  return isInlineImage(ref) ? ref : undefined;
}

/** Deletes the screenshots behind these parts (a selection taken back). */
export async function deletePartImages(parts: Part[]): Promise<void> {
  const refs = parts.flatMap((p) => (p.kind === 'image' && isImageRef(p.dataUrl) ? [p.dataUrl] : []));
  await images().delete(refs.filter((r) => r.startsWith(IMAGE_REF)).map((r) => r.slice(IMAGE_REF.length)));
  const mem = refs.filter((r) => r.startsWith(MEMORY_REF)).map((r) => memKey(r.slice(MEMORY_REF.length)));
  if (mem.length) await session().remove(mem);
}

/** Deletes every screenshot a chat owns, in memory and on disk. */
export async function deleteChatImages(chatId: string): Promise<void> {
  await images().deleteForChat(chatId);
  const all = await session().get(null);
  const mine = Object.entries(all)
    .filter(([k, v]) => k.startsWith('img:') && (v as { chatId?: string })?.chatId === chatId)
    .map(([k]) => k);
  if (mine.length) await session().remove(mine);
}

/** Pixels back in place of references. A missing image is dropped, not sent broken. */
export async function hydrateParts(parts: Part[]): Promise<Part[]> {
  const out: Part[] = [];
  for (const part of parts) {
    if (part.kind !== 'image' || !isImageRef(part.dataUrl)) {
      out.push(part);
      continue;
    }
    const dataUrl = await getImage(part.dataUrl);
    if (dataUrl) out.push({ ...part, dataUrl });
  }
  return out;
}

export async function hydratePlan(plan: Plan): Promise<Plan> {
  return { ...plan, parts: await hydrateParts(plan.parts) };
}
