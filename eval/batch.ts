/**
 * Submits paid eval runs through the Anthropic Message Batches API or the
 * OpenAI Batch API (both ~50% of list price), polls until done, and writes
 * every answer into eval/cache and eval/out so `eval:score` can grade them.
 *
 *   pnpm eval:batch --model claude-haiku-5-5 --route planner,image-only
 *   pnpm eval:batch --model gpt-6-luna --route planner
 *
 * Needs ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.local.
 */
import { hashRequest } from '@/lib/cache';
import { toAnthropicBody } from '@/lib/providers/byok';
import { toChatMessages } from '@/lib/providers/openai-compat';
import { estimateCostUsd } from '@/lib/router';
import type { AskRequest, ModelRef } from '@shared/payload';
import { EVAL_ROUTES, FileCacheStore, buildRequest, loadProblems, parseArgs, writeOutput, type EvalRoute } from './lib';

const args = parseArgs(process.argv.slice(2));
const model = String(args.model ?? 'claude-haiku-5-5');
const vendor: 'anthropic' | 'openai' = model.startsWith('gpt') || model.startsWith('o') ? 'openai' : 'anthropic';
const routes = String(args.route ?? 'planner,image-only')
  .split(',')
  .filter((r): r is EvalRoute => (EVAL_ROUTES as string[]).includes(r) && r !== 'mock' && r !== 'local');
const pollMs = Number(args.poll ?? 15000);
const cache = new FileCacheStore();
const modelRef: ModelRef = { vendor, model };

interface Item {
  customId: string;
  route: EvalRoute;
  problemId: string;
  req: AskRequest;
  hash: string;
}

const items: Item[] = [];
for (const route of routes) {
  for (const problem of loadProblems()) {
    const req = { ...buildRequest(problem, route), model: modelRef };
    const hash = await hashRequest(req);
    if (await cache.get(hash)) {
      console.log(`skip ${route}/${problem.id} (cached)`);
      continue;
    }
    items.push({ customId: `${route}__${problem.id}`, route, problemId: problem.id, req, hash });
  }
}
if (!items.length) {
  console.log('Nothing to submit; every request is cached. Run `pnpm eval:run` to materialize outputs.');
  process.exit(0);
}
console.log(`submitting ${items.length} request(s) to ${vendor} as a batch (${model})`);

const results = vendor === 'anthropic' ? await runAnthropic(items) : await runOpenAI(items);

for (const item of items) {
  const r = results.get(item.customId);
  if (!r) continue;
  await cache.set(item.hash, { text: r.text, model: modelRef, usage: r.usage, recordedAt: Date.now() });
  writeOutput({
    id: item.problemId,
    route: item.route,
    model: `${vendor}/${model}`,
    text: r.text,
    usage: r.usage,
    cached: false,
    ms: 0,
    parts: item.req.plan.parts.map((p) => ({ kind: p.kind, size: p.kind === 'image' ? p.width * p.height : JSON.stringify(p).length })),
  });
}
console.log(`wrote ${results.size} answer(s) to eval/cache and eval/out; run \`pnpm eval:score\``);

type Result = { text: string; usage: { inputTokens: number; outputTokens: number; costUsd?: number } };

async function runAnthropic(items: Item[]): Promise<Map<string, Result>> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY missing');
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const requests = items.map((it) => {
    const { stream: _s, ...params } = toAnthropicBody(toChatMessages(it.req), model);
    return { custom_id: it.customId, params };
  });
  const created = await (await fetch('https://api.anthropic.com/v1/messages/batches', { method: 'POST', headers, body: JSON.stringify({ requests }) })).json() as { id: string; processing_status: string; error?: unknown };
  if (!created.id) throw new Error(`batch create failed: ${JSON.stringify(created)}`);
  console.log(`batch ${created.id}`);
  let status = created;
  while (status.processing_status !== 'ended') {
    await new Promise((r) => setTimeout(r, pollMs));
    status = await (await fetch(`https://api.anthropic.com/v1/messages/batches/${created.id}`, { headers })).json() as typeof created;
    process.stdout.write('.');
  }
  console.log();
  const text = await (await fetch(`https://api.anthropic.com/v1/messages/batches/${created.id}/results`, { headers })).text();
  const out = new Map<string, Result>();
  for (const line of text.split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as {
      custom_id: string;
      result: { type: string; message?: { content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number } } };
    };
    if (row.result.type !== 'succeeded' || !row.result.message) continue;
    const answer = row.result.message.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const u = row.result.message.usage;
    const cost = estimateCostUsd(model, u.input_tokens, u.output_tokens);
    out.set(row.custom_id, { text: answer, usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, costUsd: cost !== undefined ? cost / 2 : undefined } });
  }
  return out;
}

async function runOpenAI(items: Item[]): Promise<Map<string, Result>> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const auth = { authorization: `Bearer ${key}` };
  const jsonl = items
    .map((it) => JSON.stringify({ custom_id: it.customId, method: 'POST', url: '/v1/chat/completions', body: { model, messages: toChatMessages(it.req) } }))
    .join('\n');
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'eval.jsonl');
  const file = await (await fetch('https://api.openai.com/v1/files', { method: 'POST', headers: auth, body: form })).json() as { id: string };
  const created = await (await fetch('https://api.openai.com/v1/batches', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ input_file_id: file.id, endpoint: '/v1/chat/completions', completion_window: '24h' }),
  })).json() as { id: string; status: string; output_file_id?: string };
  console.log(`batch ${created.id}`);
  let status = created;
  while (!['completed', 'failed', 'expired', 'cancelled'].includes(status.status)) {
    await new Promise((r) => setTimeout(r, pollMs));
    status = await (await fetch(`https://api.openai.com/v1/batches/${created.id}`, { headers: auth })).json() as typeof created;
    process.stdout.write('.');
  }
  console.log();
  if (status.status !== 'completed' || !status.output_file_id) throw new Error(`batch ${status.status}`);
  const text = await (await fetch(`https://api.openai.com/v1/files/${status.output_file_id}/content`, { headers: auth })).text();
  const out = new Map<string, Result>();
  for (const line of text.split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as {
      custom_id: string;
      response: { status_code: number; body: { choices: { message: { content: string } }[]; usage: { prompt_tokens: number; completion_tokens: number } } };
    };
    if (row.response.status_code !== 200) continue;
    const u = row.response.body.usage;
    const cost = estimateCostUsd(model, u.prompt_tokens, u.completion_tokens);
    out.set(row.custom_id, {
      text: row.response.body.choices[0]?.message.content ?? '',
      usage: { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, costUsd: cost !== undefined ? cost / 2 : undefined },
    });
  }
  return out;
}
