/**
 * callModel(request, route, ctx): one streaming entry point for every provider.
 * Picks the driver from the PROVIDER setting and resolves the model from the
 * route. Given a cache (the eval), it replays recorded answers and records
 * every paid one, so reruns are free.
 */
import type { AskChunk, AskRequest, ModelRef, Provider, Route } from '@shared/payload';
import { hashRequest } from '../cache';
import { ANSWER_COST, HOSTED_MODEL } from '@shared/models';
import { modelFor } from '../router';
import { byokDriver } from './byok';
import { gatewayDriver } from './gateway';
import { localDriver } from './local';
import { MOCK_MODEL, mockDriver } from './mock';
import { ProviderError, type ProviderContext, type ProviderDriver } from './types';

export type { KeyStatus, KeyVendor, ProviderContext, ProviderDriver, Vault } from './types';
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
}

export function resolveModel(opts: CallOptions, route: Route, ctx: ProviderContext): ModelRef {
  if (opts.provider === 'mock') return MOCK_MODEL;
  if (opts.provider === 'local') return { vendor: 'local', model: ctx.settings.localModel };
  // Hosted answers: the plan's model picked, or the vendor's fast one.
  if (opts.provider === 'gateway') return opts.model && Object.hasOwn(ANSWER_COST, opts.model.model) ? opts.model : { vendor: opts.vendor, model: HOSTED_MODEL[opts.vendor] };
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
  const cache = opts.provider !== 'mock' && !ctx.ephemeral ? ctx.cache : undefined;
  const hash = cache ? await hashRequest(request) : '';

  try {
    if (cache) {
      const hit = await cache.get(hash);
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
    if (cache && full.trim()) await cache.set(hash, { text: full, model, usage, recordedAt: Date.now() });
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
