/**
 * Gateway provider (week 9): hosted plans call the Cloudflare Worker with a
 * Supabase session token. The Worker speaks the same OpenAI-compatible SSE
 * shape, so this driver is a thin wrapper.
 */
import type { AskRequest, ModelRef } from '@shared/payload';
import { streamOpenAIChat, toChatMessages } from './openai-compat';
import { ProviderError, type ProviderContext, type ProviderDriver, type StreamResult } from './types';

export const gatewayDriver: ProviderDriver = {
  name: 'gateway',
  async *stream(req: AskRequest, model: ModelRef, ctx: ProviderContext): AsyncGenerator<string, StreamResult, void> {
    if (!ctx.keys.session) throw new ProviderError('Sign in to use a hosted plan', 'no-key');
    const usage = yield* streamOpenAIChat(
      ctx.fetch,
      `${ctx.settings.gatewayUrl.replace(/\/$/, '')}/ask`,
      { authorization: `Bearer ${ctx.keys.session}`, 'x-vendor': 'Worker' },
      { model: `${model.vendor}/${model.model}`, messages: toChatMessages(req), route: req.plan.route },
      ctx.signal,
    );
    return { usage };
  },
};
