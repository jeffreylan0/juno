/**
 * Mock provider: replays recorded responses by payload hash. When nothing is
 * recorded it streams a deterministic placeholder so the UI can be developed
 * with zero API spend. The development default.
 */
import type { AskRequest, ModelRef } from '@shared/payload';
import { partToText } from '@shared/prompts';
import { hashRequest } from '../cache';
import type { ProviderContext, ProviderDriver, StreamResult } from './types';

export const MOCK_MODEL: ModelRef = { vendor: 'mock', model: 'mock-1' };

function placeholder(req: AskRequest, hash: string): string {
  const { plan, history = [] } = req;
  // Follow-ups get a reply that visibly follows on, so the back-and-forth can
  // be exercised without a real model.
  if (history.length > 0) {
    const turn = Math.floor(history.length / 2) + 1;
    return [
      `**Mock follow-up** (turn ${turn}, mode: ${plan.mode}) to: "${(plan.question ?? '').slice(0, 80)}"`,
      '',
      `This reply has ${history.length} earlier message(s) as context and the same selection, attached once to the opening turn.`,
      '',
      `No recording exists for hash \`${hash.slice(0, 12)}\`.`,
    ].join('\n');
  }
  const summary = plan.parts
    .map((p, i) => (p.kind === 'image' ? `image ${p.width}×${p.height}` : partToText(p, i).split('\n').slice(1).join(' ').slice(0, 60)))
    .join('; ');
  const lines = [
    `Read: ${plan.parts.length} part(s) — ${summary || 'nothing'}`,
    '',
    `**Mock answer** (mode: ${plan.mode}, route: ${plan.route}). No recording exists for hash \`${hash.slice(0, 12)}\`.`,
    '',
    'Run `pnpm eval:run --route mock --record` with a real provider to record a response for this payload.',
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
    const hit = await ctx.cache.get(hash);
    const text = hit?.text ?? placeholder(req, hash);
    for await (const d of streamText(text)) {
      if (ctx.signal?.aborted) return {};
      yield d;
    }
    return { usage: hit?.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  },
};
