/**
 * The API keys, as the app's pages reach them (src-tauri/src/vault.rs):
 * settings put one in, any page can learn whether there is one, and the core
 * asks through the native core, which adds the key on the way out. No page
 * ever reads one back.
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { KeyStatus, KeyVendor, Vault } from '@/lib/providers/types';

export const keyStatus = (): Promise<KeyStatus> => invoke<KeyStatus>('key_status');

/** Keeps `key` for the company that issued it (the native core tells which from the key); says which, and what is kept now. */
export const setKey = (key: string): Promise<{ vendor: KeyVendor; status: KeyStatus }> => invoke('key_set', { key });

/** Forgets `vendor`'s key. */
export const removeKey = (vendor: KeyVendor): Promise<KeyStatus> => invoke<KeyStatus>('key_remove', { vendor });

/** Calls `fn` whenever a key is put in or taken out; returns the way to stop. */
export function watchKeys(fn: (status: KeyStatus) => void): () => void {
  const off = getCurrentWebviewWindow().listen<KeyStatus>('keys:changed', (e) => fn(e.payload));
  return () => void off.then((stop) => stop());
}

/** What the native core sends back over a request's channel, besides the body's bytes. */
type Said = { status: number; headers: [string, string][] } | { done: true } | { error: string };

/** Statuses whose response can have no body. */
const NO_BODY = new Set([101, 204, 205, 304]);

/** The vault, for the core: requests with a key go out from the native core. */
export const nativeVault: Vault = {
  status: keyStatus,
  fetch: (vendor, url, init) =>
    new Promise<Response>((resolve, reject) => {
      if (init.signal?.aborted) return reject(new DOMException('The request was stopped.', 'AbortError'));
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: (c) => void (body = c), cancel: () => stop() });
      const channel = new Channel<ArrayBuffer | Said>();
      const fail = (err: Error) => {
        reject(err);
        try {
          body.error(err);
        } catch {
          /* already closed */
        }
      };
      const stop = () => void invoke('vendor_fetch_cancel', { id: channel.id }).catch(() => {});
      init.signal?.addEventListener(
        'abort',
        () => {
          stop();
          fail(new DOMException('The request was stopped.', 'AbortError'));
        },
        { once: true },
      );
      channel.onmessage = (said) => {
        if ('status' in said) resolve(new Response(NO_BODY.has(said.status) ? null : stream, { status: said.status, headers: said.headers }));
        else if ('done' in said) body.close();
        else if ('error' in said) fail(new TypeError(said.error));
        else body.enqueue(new Uint8Array(said));
      };
      invoke('vendor_fetch', {
        vendor,
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? init.body : null,
        onBody: channel,
      }).catch((err: unknown) => fail(new TypeError(String(err))));
    }),
};
