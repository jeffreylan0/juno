/**
 * The network, for the app's windows: requests to other sites go out
 * through the native core (tauri-plugin-http), so no browser CORS rule
 * applies — the AI vendors, a local model on another port, Supabase and the
 * hosted-answers Worker are all reached the same way. The app's own pages
 * and assets still load through the webview.
 */
import { fetch as nativeCoreFetch } from '@tauri-apps/plugin-http';

const pageFetch = globalThis.fetch.bind(globalThis);

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/**
 * The app's own hosts on Windows, where the webview reaches the native core
 * over http: the page (`tauri.localhost`), Tauri's commands (`ipc.localhost`)
 * and files (`asset.localhost`). macOS and Linux use `tauri:`, `ipc:` and
 * `asset:` instead.
 */
const OWN_HOSTS = new Set(['tauri.localhost', 'ipc.localhost', 'asset.localhost']);

/**
 * Whether a request leaves the app (another origin over http or https).
 * Never one of the app's own hosts: Tauri sends every command with `fetch`,
 * so sending `http://ipc.localhost` on through the native core would ask
 * the core with a command, sent with `fetch`, and so on for ever (on
 * Windows no page could reach the app at all: no bar, nothing).
 */
export function isExternal(url: string, origin = location.origin): boolean {
  try {
    const u = new URL(url, origin);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin !== origin && !OWN_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export const appFetch: typeof fetch = async (input, init) => {
  if (!isExternal(urlOf(input))) return pageFetch(input, init);
  try {
    return await nativeCoreFetch(input, init);
  } catch (err) {
    // The plugin cancels with a plain Error; callers (and providers/errors.ts) expect an AbortError.
    if (init?.signal?.aborted) throw new DOMException('The request was stopped.', 'AbortError');
    throw err;
  }
};

export function installFetch(): void {
  globalThis.fetch = appFetch;
}
