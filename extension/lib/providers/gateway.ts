/**
 * Hosted answers: the signed-in student asks through the Worker (worker/),
 * which uses the service's own AI keys and counts answers against the plan.
 * The Worker speaks the same OpenAI-compatible SSE, so this driver is thin;
 * what it adds is saying the Worker's refusals in the student's terms.
 */
import type { AskRequest, ModelRef } from '@shared/payload';
import { streamOpenAIChat, toChatMessages } from './openai-compat';
import { ProviderError, type ProviderContext, type ProviderDriver } from './types';

export const gatewayDriver: ProviderDriver = {
  name: 'gateway',
  async *stream(req: AskRequest, model: ModelRef, ctx: ProviderContext) {
    if (!ctx.keys.session) throw new ProviderError('Sign in to use hosted answers.', 'no-key');
    try {
      const usage = yield* streamOpenAIChat(
        ctx.fetch,
        `${ctx.settings.gatewayUrl.replace(/\/$/, '')}/ask`,
        'the hosted service',
        { authorization: `Bearer ${ctx.keys.session}` },
        {
          model: `${model.vendor}/${model.model}`,
          messages: toChatMessages(req),
          route: req.plan.route,
          // A temporary chat: nothing cached anywhere it can be avoided (worker/src/models.ts).
          ...(ctx.ephemeral ? { ephemeral: true } : {}),
        },
        ctx.signal,
      );
      return { usage };
    } catch (err) {
      throw hostedError(err);
    }
  },
};

/** The Worker's own sentences (worker/src/index.ts) are already the student's; keep them. */
function hostedError(err: unknown): unknown {
  if (!(err instanceof ProviderError) || !err.status) return err;
  const said = err.detail;
  switch (err.status) {
    case 401:
      return new ProviderError('Your sign-in ran out. Sign in again in Settings.', 'bad-key', 401);
    case 402:
      return new ProviderError(said ?? "You've used all your hosted answers this month.", 'no-credit', 402);
    case 403:
      return new ProviderError(said ?? "Your account doesn't include hosted answers.", 'permission', 403);
    case 503:
      return new ProviderError(said ?? 'The hosted service is busy right now. Try again in a minute.', 'overloaded', 503);
    default:
      return said ? new ProviderError(said, err.code, err.status) : err;
  }
}
