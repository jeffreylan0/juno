/**
 * Cloud copies of saved chats, for accounts with cloud storage that turned it
 * on (Settings.cloudSync). Runs in the background, which is the only writer.
 *
 * This computer comes first: chats are read and written here as always, and
 * copied up and down behind the scenes.
 *
 *  - Up: every change to a saved chat marks it; marked chats are pushed a few
 *    seconds later with their screenshots (an answer still streaming waits).
 *    A chat the student deletes is pushed as a tombstone, so every computer
 *    deletes it. A chat the limit drops is only gone from this computer: the
 *    cloud keeps it.
 *  - Down: rows the server took since the last pull, oldest first. The newer
 *    version wins (versionOf: when the chat last changed), and a chat older
 *    than what the limit keeps is not downloaded at all.
 *  - Temporary chats are never copied anywhere.
 *
 * Who owns the chats on this computer: the first account to sign in here
 * gets them uploaded. Another account signing in later gets its own chats
 * downloaded, and never gets the chats already here uploaded: not when it
 * opens one, adds to it or deletes it (they stay "foreign" until the cloud
 * shows one is this account's own).
 */
import { storage } from '@wxt-dev/storage';
import {
  getSavedChat,
  listChats,
  onChatsDeleted,
  putSyncedChat,
  removeSyncedChat,
  versionOf,
  wouldKeep,
  type Chat,
  type ChatSummary,
} from '../chats';
import { IMAGE_REF, images } from '../images';
import { getSettings, type Settings } from '../storage';
import { ACCOUNTS } from './config';
import {
  deleteAllCloudChats,
  downloadImage,
  imagePath,
  pullChats,
  pushChats,
  removeAllImages,
  removeChatImages,
  removeImages,
  uploadImage,
  type CloudChatRow,
} from './cloud';
import { AccountError, currentSession, entitlementItem, refreshEntitlement, syncStatusItem, type SyncStatus } from './session';

interface SyncState {
  /** The account this is for. */
  owner: string;
  /** The last row pulled. */
  cursor: { at: string; id: string } | null;
  /** Saved chats changed here and not yet pushed. */
  dirty: string[];
  /** Chats deleted here, and when, not yet pushed as tombstones. */
  deleted: Record<string, number>;
  /** "Delete all chats" was pressed; the cloud copies go next time. */
  wipe?: boolean;
  /** Screenshot ids in the cloud, by chat. */
  uploaded: Record<string, string[]>;
  /** Chats that were here when this account took over from another: never pushed to this one. */
  foreign?: string[];
}

const stateItem = storage.defineItem<SyncState | null>('local:sync', { fallback: null });

/** Pulls start this far before the last row seen, for writes still committing then. */
const OVERLAP_MS = 60_000;
const PUSH_DELAY_MS = 3_000;
const RETRY_MS = 60_000;
/** The entitlement is read again when older than this. */
const ENTITLEMENT_TTL_MS = 10 * 60_000;

export interface SyncHooks {
  /** The background's queue for chat writes, so a download never lands mid-answer. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** Chats removed here by the sync (deleted elsewhere, or past the limit): windows showing them move on. */
  gone(ids: string[]): Promise<void>;
}

export class ChatSync {
  private loaded: Promise<SyncState | null> | null = null;
  /** The version of each chat known to match the cloud, so our own downloads are not pushed back. */
  private known = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private unlisten: (() => void)[] = [];

  constructor(private hooks: SyncHooks) {}

  /** Starts listening, and syncs shortly. */
  start(): this {
    if (!ACCOUNTS) return this;
    browser.storage.onChanged.addListener(this.onChanged);
    this.unlisten.push(() => browser.storage.onChanged.removeListener(this.onChanged));
    this.unlisten.push(onChatsDeleted((ids) => void this.noteDeleted(ids)));
    this.soon(1_000);
    return this;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.unlisten.forEach((fn) => fn());
  }

  /** Syncs after `ms` (sooner wins over later). */
  soon(ms = 0): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.now(), ms);
  }

  /** Syncs now (or right after the run in progress), resolving when done. */
  async now(): Promise<void> {
    if (this.running) {
      this.again = true;
      return await this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.run();
      } while (this.again && !this.stopped);
    })().finally(() => (this.running = null));
    return await this.running;
  }

  /**
   * Holds every sync until the returned function is called, once the run in
   * progress is done: deleting the account must not race an upload.
   */
  async pause(): Promise<() => void> {
    const was = this.stopped;
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running?.catch(() => {});
    return () => {
      this.stopped = was;
    };
  }

  /** The account was deleted: this computer's chats belong to nobody again. */
  async reset(): Promise<void> {
    this.known.clear();
    this.loaded = Promise.resolve(null);
    await stateItem.removeValue();
    await this.status({ state: 'off' });
  }

  /** "Delete all chats": the cloud copies go too, including any this computer no longer keeps. */
  async deleteAll(): Promise<void> {
    const s = await this.state();
    if (!s) return;
    s.wipe = true;
    s.deleted = {};
    s.dirty = [];
    await this.save(s);
    this.soon(0);
  }

  // ── Listening ──────────────────────────────────────────────────────────

  private onChanged = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string): void => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith('chat:')) {
        const chat = change.newValue as Chat | undefined;
        if (chat && !chat.temporary && this.known.get(chat.id) !== versionOf(chat)) void this.markDirty(chat.id);
      } else if (key === 'account' || key === 'entitlement') {
        this.soon(0);
      } else if (key === 'settings') {
        const before = change.oldValue as Partial<Settings> | undefined;
        const after = change.newValue as Partial<Settings> | undefined;
        if (before?.cloudSync !== after?.cloudSync) this.soon(0);
        // Keeping more: pull everything again, so older chats come back from the cloud.
        if ((after?.chatLimit ?? 0) > (before?.chatLimit ?? 0)) void this.rewind();
      }
    }
  };

  private async markDirty(id: string): Promise<void> {
    const s = await this.state();
    if (!s || s.dirty.includes(id) || s.foreign?.includes(id)) return;
    s.dirty.push(id);
    delete s.deleted[id];
    await this.save(s);
    this.soon(PUSH_DELAY_MS);
  }

  private async noteDeleted(ids: string[]): Promise<void> {
    const s = await this.state();
    if (!s) return;
    const at = Date.now();
    for (const id of ids) {
      if (s.wipe) break;
      if (s.foreign?.includes(id)) {
        s.foreign = s.foreign.filter((f) => f !== id);
        continue;
      }
      s.deleted[id] = at;
      s.dirty = s.dirty.filter((d) => d !== id);
      this.known.delete(id);
    }
    await this.save(s);
    this.soon(1_000);
  }

  private async rewind(): Promise<void> {
    const s = await this.state();
    if (!s) return;
    s.cursor = null;
    await this.save(s);
    this.soon(0);
  }

  // ── State ──────────────────────────────────────────────────────────────

  private state(): Promise<SyncState | null> {
    this.loaded ??= stateItem.getValue();
    return this.loaded;
  }

  private async save(s: SyncState): Promise<void> {
    this.loaded = Promise.resolve(s);
    await stateItem.setValue(s);
  }

  /** This account's state; a new one when another account signed in. */
  private async stateFor(userId: string): Promise<SyncState> {
    const s = await this.state();
    if (s?.owner === userId) return s;
    // The first account here takes this computer's chats; a later one does not.
    const here = (await listChats()).map((c) => c.id);
    const next: SyncState = s
      ? { owner: userId, cursor: null, dirty: [], deleted: {}, uploaded: {}, foreign: here }
      : { owner: userId, cursor: null, dirty: here, deleted: {}, uploaded: {} };
    this.known.clear();
    await this.save(next);
    return next;
  }

  private lastStatus = '';
  private async status(status: SyncStatus): Promise<void> {
    // Every wake of the worker runs once; an unchanged "off" is not worth a write.
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await syncStatusItem.setValue(status);
  }

  // ── A run ──────────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    const session = await currentSession();
    if (!session) return await this.status({ state: 'off' });
    const s = await this.stateFor(session.user.id);
    if (!(await getSettings()).cloudSync) return await this.status({ state: 'off' });

    try {
      let ent = await entitlementItem.getValue();
      if (!ent || Date.now() - ent.checkedAt > ENTITLEMENT_TTL_MS) ent = (await refreshEntitlement()) ?? ent;
      if (!ent?.cloud) return await this.status({ state: 'not-allowed' });

      await this.status({ state: 'syncing' });
      await this.push(s, session.user.id);
      await this.pull(s, session.user.id);
      await this.status({ state: 'ok', at: Date.now() });
    } catch (err) {
      const e = err as AccountError;
      if (e.code === 'signed-out') return await this.status({ state: 'off' });
      // A 401/403 on writes can mean cloud storage was taken away: read it again next time.
      if (e.status === 401 || e.status === 403) await entitlementItem.setValue(null);
      await this.status({ state: 'error', message: e.message || String(err), at: Date.now() });
      this.soon(RETRY_MS);
    }
  }

  private async push(s: SyncState, uid: string): Promise<void> {
    if (s.wipe) {
      await deleteAllCloudChats();
      await removeAllImages(uid);
      s.wipe = false;
      s.uploaded = {};
      await this.save(s);
    }

    const tombs = Object.entries(s.deleted);
    for (let i = 0; i < tombs.length; i += 50) {
      const batch = tombs.slice(i, i + 50);
      await pushChats(batch.map(([id, at]) => ({ id, updated_ms: at, deleted: true })));
      for (const [id] of batch) {
        await removeChatImages(uid, id);
        delete s.uploaded[id];
        if (s.deleted[id] !== undefined) delete s.deleted[id];
      }
      await this.save(s);
    }

    // One pass over what is marked now; changes made meanwhile mark again.
    const ids = [...s.dirty];
    for (let i = 0; i < ids.length; i += 20) {
      const take = ids.slice(i, i + 20);
      s.dirty = s.dirty.filter((d) => !take.includes(d));
      await this.save(s);
      const rows: { id: string; updated_ms: number; data: Chat }[] = [];
      const later: string[] = [];
      try {
        for (const id of take) {
          const chat = await getSavedChat(id);
          if (!chat) continue; // gone from this computer (the limit): the cloud keeps it
          if (chat.items.some((it) => it.kind === 'assistant' && it.streaming)) {
            later.push(id); // its answer is still coming; it marks itself again when done
            continue;
          }
          await this.uploadImages(chat, s, uid);
          rows.push({ id, updated_ms: versionOf(chat), data: chat });
        }
        await pushChats(rows);
        for (const r of rows) this.known.set(r.id, r.updated_ms);
      } catch (err) {
        s.dirty = [...new Set([...take, ...s.dirty])];
        await this.save(s);
        throw err;
      }
      if (later.length) {
        s.dirty = [...new Set([...s.dirty, ...later])];
        await this.save(s);
      }
    }
  }

  private async uploadImages(chat: Chat, s: SyncState, uid: string): Promise<void> {
    const refs = imageIdsOf(chat);
    const have = new Set(s.uploaded[chat.id] ?? []);
    for (const id of refs) {
      if (have.has(id)) continue;
      const img = await images().get(id);
      if (!img) continue;
      await uploadImage(imagePath(uid, chat.id, id), img.dataUrl);
      have.add(id);
    }
    // Selections taken back: their screenshots go from the cloud too.
    const stale = [...have].filter((id) => !refs.includes(id));
    if (stale.length) {
      await removeImages(stale.map((id) => imagePath(uid, chat.id, id)));
      stale.forEach((id) => have.delete(id));
    }
    s.uploaded[chat.id] = [...have];
  }

  private async pull(s: SyncState, uid: string): Promise<void> {
    let after = s.cursor ? { at: new Date(parseTime(s.cursor.at) - OVERLAP_MS).toISOString(), id: '' } : null;
    const gone: string[] = [];
    for (;;) {
      const rows = await pullChats(after);
      for (const row of rows) {
        const dropped = await this.apply(row, s, uid);
        gone.push(...dropped);
      }
      if (rows.length) {
        const last = rows[rows.length - 1]!;
        after = { at: last.synced_at, id: last.id };
        if (!s.cursor || parseTime(last.synced_at) >= parseTime(s.cursor.at)) s.cursor = after;
        await this.save(s);
      }
      if (rows.length < 50) break;
    }
    if (gone.length) await this.hooks.gone([...new Set(gone)]);
  }

  /** Takes one row from the cloud; returns the chats it removed here. */
  private async apply(row: CloudChatRow, s: SyncState, uid: string): Promise<string[]> {
    // In this account's cloud: its own chat after all (it signed in here before).
    if (s.foreign?.includes(row.id)) s.foreign = s.foreign.filter((f) => f !== row.id);
    const local = await getSavedChat(row.id);
    const mine = local ? versionOf(local) : 0;

    if (row.deleted) {
      delete s.uploaded[row.id];
      if (!local || mine > row.updated_ms) return []; // changed here since: ours wins, and goes up
      const removed = await this.hooks.serial(async () => {
        const now = await getSavedChat(row.id);
        if (now && versionOf(now) > row.updated_ms) return false;
        return await removeSyncedChat(row.id);
      });
      s.dirty = s.dirty.filter((d) => d !== row.id);
      this.known.delete(row.id);
      return removed ? [row.id] : [];
    }

    if (row.updated_ms <= mine || s.deleted[row.id] !== undefined) return [];
    const chat = asChat(row.data, row.id);
    if (!chat) return [];
    if (!local && !(await wouldKeep(chat.id, chat.updatedAt))) return [];

    await this.downloadImages(chat, s, uid);
    const dropped = await this.hooks.serial(async (): Promise<ChatSummary[] | null> => {
      const now = await getSavedChat(row.id);
      if (now && versionOf(now) >= row.updated_ms) return null;
      this.known.set(row.id, row.updated_ms);
      return await putSyncedChat({ ...chat, editedAt: row.updated_ms });
    });
    if (dropped === null) return [];
    s.dirty = s.dirty.filter((d) => d !== row.id);
    return dropped.map((d) => d.id);
  }

  private async downloadImages(chat: Chat, s: SyncState, uid: string): Promise<void> {
    const have = new Set(s.uploaded[chat.id] ?? []);
    for (const id of imageIdsOf(chat)) {
      have.add(id);
      if (await images().get(id)) continue;
      const dataUrl = await downloadImage(imagePath(uid, chat.id, id));
      if (dataUrl) await images().put({ id, chatId: chat.id, dataUrl, createdAt: Date.now() });
    }
    s.uploaded[chat.id] = [...have];
  }
}

/** The screenshot ids a chat points at. */
export function imageIdsOf(chat: Chat): string[] {
  const ids: string[] = [];
  for (const item of chat.items) {
    if (item.kind !== 'selection') continue;
    for (const part of item.plan.parts) {
      if (part.kind === 'image' && part.dataUrl.startsWith(IMAGE_REF)) ids.push(part.dataUrl.slice(IMAGE_REF.length));
    }
  }
  return ids;
}

/** A row's chat, if it looks like one; never temporary. */
function asChat(data: unknown, id: string): Chat | null {
  if (!data || typeof data !== 'object') return null;
  const c = data as Partial<Chat>;
  if (c.id !== id || !Array.isArray(c.items) || typeof c.updatedAt !== 'number' || typeof c.createdAt !== 'number') return null;
  const { temporary: _temporary, ...chat } = c as Chat;
  return { ...chat, title: typeof chat.title === 'string' ? chat.title : '' };
}

/** A Postgres timestamp (microseconds, any offset) in ms. */
function parseTime(at: string): number {
  return Date.parse(at.replace(/(\.\d{3})\d+/, '$1').replace(/\+00:?00$/, 'Z'));
}
