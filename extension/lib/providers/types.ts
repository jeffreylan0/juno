import type { AskRequest, ModelRef, Provider, Usage } from '@shared/payload';
import type { CacheStore } from '../cache';

export interface ProviderContext {
  fetch: typeof fetch;
  keys: { anthropic: string; openai: string; session: string };
  settings: { localBaseUrl: string; localModel: string; gatewayUrl: string };
  cache: CacheStore;
  signal?: AbortSignal;
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

export class ProviderError extends Error {
  constructor(
    message: string,
    public code: 'no-key' | 'http' | 'network' | 'aborted' | 'unsupported' | 'empty',
    public status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
