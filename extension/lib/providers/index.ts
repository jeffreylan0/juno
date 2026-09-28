/**
 * callModel(request, route, ctx): one streaming entry point for every provider.
 * Picks the driver from the PROVIDER setting, resolves the model from the
 * route, replays cached answers, and records every paid answer so reruns are free.
 */
import type { AskChunk, AskRequest, ModelRef, Provider, Route } from '@shared/payload';
import { hashRequest } from '../cache';
import { modelFor } from '../router';
import { byokDriver } from './byok';
import { gatewayDriver } from './gateway';
import { localDriver } from './local';
import { MOCK_MODEL, mockDriver } from './mock';
import { ProviderError, type ProviderContext, type ProviderDriver } from './types';

export type { ProviderContext, ProviderDriver } from './types';
export { ProviderError } from './types';

const DRIVERS: Record<Provider, ProviderDriver> = {
  mock: mockDriver,
  local: localDriver,
  byok: byokDriver,
  gateway: gatewayDriver,
};

export interface CallOptions {
  provider: Provider;
  vendor: 'anthropic' | 'openai';
  /** Explicit model wins over the route table. */
  model?: ModelRef | null;
  /** Skip cache lookup (still records). */
  noCache?: boolean;
}

export function resolveModel(opts: CallOptions, route: Route, ctx: ProviderContext): ModelRef {
  if (opts.provider === 'mock') return MOCK_MODEL;
  if (opts.provider === 'local') return { vendor: 'local', model: ctx.settings.localModel };
  if (opts.model && opts.model.vendor !== 'mock' && opts.model.vendor !== 'local') return opts.model;
  return modelFor(opts.vendor, route);
}

export async function* callModel(
  req: AskRequest,
  route: Route,
  ctx: ProviderContext,
  opts: CallOptions,
): AsyncGenerator<AskChunk, void, void> {
  const driver = DRIVERS[opts.provider];
  const model = resolveModel(opts, route, ctx);
  const request: AskRequest = { ...req, model };
  const hash = await hashRequest(request);

  try {
    if (opts.provider !== 'mock' && !opts.noCache) {
      const hit = await ctx.cache.get(hash);
      if (hit) {
        yield { type: 'delta', text: hit.text };
        yield { type: 'done', usage: { ...hit.usage, inputTokens: 0, outputTokens: 0, costUsd: 0 }, model: hit.model, cached: true };
        return;
      }
    }

    const gen = driver.stream(request, model, ctx);
    let full = '';
    let result = await gen.next();
    while (!result.done) {
      full += result.value;
      yield { type: 'delta', text: result.value };
      result = await gen.next();
    }
    const usage = result.value.usage;
    if (opts.provider !== 'mock' && full.trim()) {
      await ctx.cache.set(hash, { text: full, model, usage, recordedAt: Date.now() });
    }
    yield { type: 'done', usage, model, cached: false };
  } catch (err) {
    if (ctx.signal?.aborted) {
      yield { type: 'error', message: 'Cancelled', code: 'aborted' };
      return;
    }
    const e = err as Partial<ProviderError> & { message?: string };
    yield { type: 'error', message: e.message ?? String(err), code: e.code };
  }
}
