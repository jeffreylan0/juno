/**
 * The cloud copies: chat rows (public.chats) and screenshots (the private
 * `screenshots` bucket), read and written as the signed-in student. Row level
 * security on the server keeps each account to its own; see
 * supabase/migrations for what is allowed.
 */
import { SCREENSHOT_BUCKET } from './config';
import { AccountError, api, apiJson, signOut } from './session';

export interface CloudChatRow {
  id: string;
  /** The chat's version: when it last changed, by the clock of the computer that changed it. */
  updated_ms: number;
  deleted: boolean;
  data: unknown;
  /** When the server took it; what pulls page by. */
  synced_at: string;
}

export interface PushRow {
  id: string;
  updated_ms: number;
  deleted?: boolean;
  data?: unknown;
}

/** Saves chats or tombstones (≤50); an older version than the server's changes nothing. */
export async function pushChats(rows: PushRow[]): Promise<number> {
  if (!rows.length) return 0;
  return await apiJson<number>('/rest/v1/rpc/push_chats', { method: 'POST', body: JSON.stringify({ p_rows: rows }) });
}

/** A page of rows the server took after `after` (exclusive), oldest first. */
export async function pullChats(after: { at: string; id: string } | null, limit = 50): Promise<CloudChatRow[]> {
  const q = new URLSearchParams({ select: 'id,updated_ms,deleted,data,synced_at', order: 'synced_at.asc,id.asc', limit: String(limit) });
  if (after) q.set('or', `(synced_at.gt."${after.at}",and(synced_at.eq."${after.at}",id.gt."${after.id}"))`);
  return await apiJson<CloudChatRow[]>(`/rest/v1/chats?${q}`);
}

/** Every chat of this account becomes a tombstone ("Delete all chats"). */
export async function deleteAllCloudChats(): Promise<void> {
  await apiJson('/rest/v1/rpc/delete_all_chats', { method: 'POST', body: '{}' });
}

// ── Screenshots ──────────────────────────────────────────────────────────

const objectPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
export const imagePath = (userId: string, chatId: string, imageId: string) => `${userId}/${chatId}/${imageId}`;

export async function uploadImage(path: string, dataUrl: string): Promise<void> {
  const { type, bytes } = fromDataUrl(dataUrl);
  const res = await api(`/storage/v1/object/${SCREENSHOT_BUCKET}/${objectPath(path)}`, {
    method: 'POST',
    headers: { 'content-type': type, 'x-upsert': 'true', 'cache-control': '3600' },
    body: bytes,
  });
  if (!res.ok) throw new AccountError(`Couldn't upload a screenshot (${res.status}).`, 'server', res.status);
}

/** The screenshot as a data URL, or undefined if it is not there. */
export async function downloadImage(path: string): Promise<string | undefined> {
  const res = await api(`/storage/v1/object/authenticated/${SCREENSHOT_BUCKET}/${objectPath(path)}`);
  // Storage answers a missing object with 400 or 404.
  if (res.status === 404 || res.status === 400) return undefined;
  if (!res.ok) throw new AccountError(`Couldn't download a screenshot (${res.status}).`, 'server', res.status);
  const type = (res.headers.get('content-type') ?? 'image/png').split(';')[0]!.trim();
  return toDataUrl(type, new Uint8Array(await res.arrayBuffer()));
}

function fromDataUrl(dataUrl: string): { type: string; bytes: Uint8Array<ArrayBuffer> } {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new AccountError('A screenshot could not be read.', 'server');
  const raw = m[2] ? atob(m[3]!) : decodeURIComponent(m[3]!);
  return { type: m[1]!, bytes: Uint8Array.from(raw, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer> };
}

function toDataUrl(type: string, bytes: Uint8Array): string {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(raw)}`;
}

/** Names directly under `prefix/` (files and folders), up to 1000 per call. */
async function list(prefix: string): Promise<{ name: string; folder: boolean }[]> {
  const out: { name: string; folder: boolean }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await apiJson<{ name: string; id: string | null }[]>(`/storage/v1/object/list/${SCREENSHOT_BUCKET}`, {
      method: 'POST',
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    out.push(...page.map((o) => ({ name: o.name, folder: o.id === null })));
    if (page.length < 1000) return out;
  }
}

export async function removeImages(paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 1000) {
    await apiJson(`/storage/v1/object/${SCREENSHOT_BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes: paths.slice(i, i + 1000) }) });
  }
}

/** Removes one chat's screenshots. */
export async function removeChatImages(userId: string, chatId: string): Promise<void> {
  const files = await list(`${userId}/${chatId}`);
  await removeImages(files.filter((f) => !f.folder).map((f) => `${userId}/${chatId}/${f.name}`));
}

/** Removes every screenshot of this account. */
export async function removeAllImages(userId: string): Promise<void> {
  for (const f of await list(userId)) {
    if (f.folder) await removeChatImages(userId, f.name);
    else await removeImages([`${userId}/${f.name}`]);
  }
}

/**
 * Deletes the account: its screenshots first (the database cannot), then the
 * account itself, which takes its chats, usage and entitlements with it.
 * Chats on this computer stay.
 */
export async function deleteAccount(userId: string): Promise<void> {
  await removeAllImages(userId);
  await apiJson('/rest/v1/rpc/delete_me', { method: 'POST', body: '{}' });
  await signOut();
}
