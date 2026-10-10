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

/** Whether a request leaves the app (another origin over http or https). */
export function isExternal(url: string, origin = location.origin): boolean {
  try {
    const u = new URL(url, origin);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin !== origin;
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
