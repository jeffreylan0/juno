/**
 * SHA-256 payload hash → stored response. Used by the mock provider for
 * record/replay and by every paid provider to write answers so reruns are free.
 * The store is pluggable: extension storage in the browser, a JSON file in eval.
 */
import { canonicalizeRequest, stableStringify, type AskRequest, type ModelRef, type Usage } from '@shared/payload';

export interface CachedResponse {
  text: string;
  model: ModelRef;
  usage?: Usage;
  recordedAt: number;
}

export interface CacheStore {
  get(hash: string): Promise<CachedResponse | undefined>;
  set(hash: string, value: CachedResponse): Promise<void>;
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hash of the cache-relevant parts of a request. Same payload ⇒ same hash. */
export async function hashRequest(req: AskRequest): Promise<string> {
  return sha256Hex(stableStringify(canonicalizeRequest(req)));
}

export class MemoryCacheStore implements CacheStore {
  private map = new Map<string, CachedResponse>();
  async get(hash: string) {
    return this.map.get(hash);
  }
  async set(hash: string, value: CachedResponse) {
    this.map.set(hash, value);
  }
  get size() {
    return this.map.size;
  }
}

/** Backed by a `chrome.storage`-like area; keys are prefixed to avoid clashes. */
export class AreaCacheStore implements CacheStore {
  constructor(
    private area: {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    },
    private prefix = 'cache:',
  ) {}
  async get(hash: string) {
    const key = this.prefix + hash;
    const out = await this.area.get(key);
    return out[key] as CachedResponse | undefined;
  }
  async set(hash: string, value: CachedResponse) {
    await this.area.set({ [this.prefix + hash]: value });
  }
}
