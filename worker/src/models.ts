/**
 * Calls Anthropic, OpenAI or Workers AI through the AI Gateway and streams the
 * response back in the OpenAI-compatible shape the extension already speaks
 * (week 10). Provider keys stay here as Worker secrets.
 */
import type { Env } from './index';

export async function callVendor(
  body: { model: string; messages: unknown[]; route?: 'small' | 'large' },
  env: Env,
): Promise<Response> {
  const [vendor, model] = body.model.includes('/') ? body.model.split('/') : ['anthropic', body.model];
  const base = env.AI_GATEWAY_ID
    ? `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ID}/selection-ai/${vendor}`
    : vendor === 'openai'
      ? 'https://api.openai.com/v1'
      : 'https://api.anthropic.com/v1';

  if (vendor === 'openai') {
    return fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, messages: body.messages, stream: true, stream_options: { include_usage: true } }),
    });
  }

  // Anthropic: the Worker converts to the Messages API and re-emits OpenAI-shaped
  // SSE so the extension has one parser. Implemented alongside the gateway in week 10.
  throw new Error('Anthropic routing through the Worker lands in week 10');
}
