/**
 * Local provider: Ollama (or any OpenAI-compatible server) on localhost:11434.
 * Free, private, and good enough to exercise the planner with a vision model.
 */
import type { AskRequest, ModelRef } from '@shared/payload';
import { streamOpenAIChat, toChatMessages } from './openai-compat';
import type { ProviderContext, ProviderDriver, StreamResult } from './types';

export const localDriver: ProviderDriver = {
  name: 'local',
  async *stream(req: AskRequest, model: ModelRef, ctx: ProviderContext): AsyncGenerator<string, StreamResult, void> {
    const base = ctx.settings.localBaseUrl.replace(/\/$/, '');
    const modelId = model.vendor === 'local' && model.model ? model.model : ctx.settings.localModel;
    const usage = yield* streamOpenAIChat(
      ctx.fetch,
      `${base}/chat/completions`,
      'the local server',
      {},
      { model: modelId, messages: toChatMessages(req), temperature: 0.2 },
      ctx.signal,
    );
    return { usage: { ...usage, costUsd: 0 } };
  },
};
