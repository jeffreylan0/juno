import type { AskRequest, ModelRef, Provider, Usage } from '@shared/payload';
import type { CacheStore } from '../cache';

/** The companies a student's own API key can be for. */
export type KeyVendor = 'anthropic' | 'openai';

/** Which keys there are, each by its last four characters ("…WXYZ"); never the keys. */
export interface KeyStatus {
  anthropic: string | null;
  openai: string | null;
}

/**
 * Sends requests with the student's API keys. In the app no page ever holds
 * one: the native core adds it (platform/vault.ts, src-tauri/src/vault.rs).
 * The eval holds its own (byok.ts keyVault).
 */
export interface Vault {
  status(): Promise<KeyStatus>;
  /** fetch, to that company's API, with its key. */
  fetch(vendor: KeyVendor, url: string, init: RequestInit): Promise<Response>;
}

export interface ProviderContext {
  fetch: typeof fetch;
  vault: Vault;
  /** The signed-in account's token, for hosted answers (empty otherwise). */
  session: string;
  settings: { localBaseUrl: string; localModel: string; gatewayUrl: string };
  /**
   * Answers recorded by request hash, so a rerun replays for free. The eval
   * uses one; the app does not, so no answer outlives its chat.
   */
  cache?: CacheStore;
  /**
   * A temporary chat: ask the vendor to keep as little as it allows (see
   * byok.ts and the Worker), and record nothing.
   */
  ephemeral?: boolean;
  signal?: AbortSignal;
  /** A web search began, for the panel to say so ("Searching the web…"). */
  onSearch?: () => void;
}

export interface StreamResult {
  usage?: Usage;
}

/**
 * A driver turns one request into a stream of text deltas and finally a
 * StreamResult (usage). All drivers speak the same OpenAI-compatible message
 * shape internally (see openai-compat.ts) so the payload format never forks.
 */
export interface ProviderDriver {
  name: Provider;
  stream(req: AskRequest, model: ModelRef, ctx: ProviderContext): AsyncGenerator<string, StreamResult, void>;
}

/**
 * What went wrong, as a category the panel can act on (see errors.ts):
 * Settings for key, credit and model problems; Try again for transient ones.
 */
export type ProviderErrorCode =
  | 'no-key'
  | 'bad-key'
  | 'no-credit'
  | 'permission'
  | 'model'
  | 'too-large'
  | 'rate-limit'
  | 'overloaded'
  | 'http'
  | 'network'
  | 'aborted'
  | 'unsupported'
  | 'empty'
  | 'declined'
  | 'cut-off';

export class ProviderError extends Error {
  /** The vendor's request id, for a support ticket. */
  requestId?: string;
  /** The vendor's own message, kept for diagnostics. */
  detail?: string;

  constructor(
    message: string,
    public code: ProviderErrorCode,
    public status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
