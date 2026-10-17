/**
 * SHA-256 payload hash → stored response, so an eval rerun replays for free
 * (eval/lib.ts keeps them as JSON files). The app keeps none: no answer
 * outlives its chat.
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
