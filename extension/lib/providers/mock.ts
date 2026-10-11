/**
 * Mock provider: streams a deterministic placeholder so the UI can be
 * developed with zero API spend (the development default). Given a cache
 * (the eval), it replays what was recorded for the same payload hash instead.
 */
import type { AskRequest, ModelRef } from '@shared/payload';
import { partToText } from '@shared/prompts';
import { hashRequest } from '../cache';
import type { ProviderContext, ProviderDriver, StreamResult } from './types';

export const MOCK_MODEL: ModelRef = { vendor: 'mock', model: 'mock-1' };

function placeholder(req: AskRequest, hash: string): string {
  const { plan, history = [] } = req;
  // The selections this message brings: its attachments in a multi-selection
  // chat, or the plan's parts in the single-selection form.
  const fresh = req.attachments ? req.attachments.flatMap((a) => a.parts) : history.length ? [] : plan.parts;
  const earlier = history.reduce((n, t) => n + (t.attachments?.length ?? 0), 0);
  // Follow-ups get a reply that visibly follows on, so the back-and-forth can
  // be exercised without a real model.
  if (history.length > 0 && fresh.length === 0) {
    const turn = Math.floor(history.length / 2) + 1;
    return [
      `**Mock follow-up** (turn ${turn}, mode: ${plan.mode}) to: "${(plan.question ?? '').slice(0, 80)}"`,
      '',
      `This reply has ${history.length} earlier message(s) as context${earlier ? `, carrying ${earlier} earlier selection(s)` : ''}.`,
      '',
      `No recording exists for hash \`${hash.slice(0, 12)}\`.`,
    ].join('\n');
  }
  const summary = fresh
    .map((p, i) => (p.kind === 'image' ? `image ${p.width}×${p.height}` : partToText(p, i).split('\n').slice(1).join(' ').slice(0, 60)))
    .join('; ');
  const lines = [
    `Read: ${fresh.length} part(s) — ${summary || 'nothing'}${earlier ? ` (plus ${earlier} earlier selection(s) in this chat)` : ''}`,
    '',
    `**Placeholder answer** (mode: ${plan.mode}, route: ${plan.route}): no AI was asked. Pick one in Settings → Answers.`,
    '',
    'Rendering check: $E = mc^2$, $$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$ and $\\ce{2H2 + O2 -> 2H2O}$.',
  ];
  if (plan.mode === 'check') lines.push('', 'Verdict: incorrect');
  if (plan.mode === 'explain') lines.push('', 'Answer: 42');
  return lines.join('\n');
}

async function* streamText(text: string, chunk = 24): AsyncGenerator<string, void, void> {
  for (let i = 0; i < text.length; i += chunk) {
    yield text.slice(i, i + chunk);
    // Small delay keeps streaming UI honest during development.
    await new Promise((r) => setTimeout(r, 8));
  }
}

export const mockDriver: ProviderDriver = {
  name: 'mock',
  async *stream(req: AskRequest, _model: ModelRef, ctx: ProviderContext): AsyncGenerator<string, StreamResult, void> {
    const hash = await hashRequest(req);
    const hit = await ctx.cache?.get(hash);
    const text = hit?.text ?? placeholder(req, hash);
    for await (const d of streamText(text)) {
      if (ctx.signal?.aborted) return {};
      yield d;
    }
    return { usage: hit?.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  },
};
