/**
 * Sends every problem through every requested route and saves outputs.
 *
 *   pnpm eval:run --route mock                 # free, replays the cache
 *   pnpm eval:run --route planner,image-only --provider byok --vendor anthropic
 *   pnpm eval:run --route local --limit 5
 *
 * PROVIDER in .env.local picks mock | local | byok; --provider overrides it.
 * Every paid answer is written to eval/cache so reruns cost nothing.
 */
import { callModel, type ProviderContext } from '@/lib/providers';
import { keyVault } from '@/lib/providers/byok';
import type { Provider } from '@shared/payload';
import { EVAL_ROUTES, FileCacheStore, buildRequest, loadProblems, parseArgs, writeOutput, type EvalOutput, type EvalRoute } from './lib';

const args = parseArgs(process.argv.slice(2));
const routes = String(args.route ?? 'mock')
  .split(',')
  .map((r) => r.trim())
  .filter((r): r is EvalRoute => (EVAL_ROUTES as string[]).includes(r));
const limit = args.limit ? Number(args.limit) : undefined;
const only = args.only ? String(args.only).split(',') : undefined;
const vendor = String(args.vendor ?? 'anthropic') as 'anthropic' | 'openai';
const modelArg = args.model ? String(args.model) : undefined;

const ctx: ProviderContext = {
  fetch: globalThis.fetch.bind(globalThis),
  vault: keyVault({ anthropic: process.env.ANTHROPIC_API_KEY ?? '', openai: process.env.OPENAI_API_KEY ?? '' }, globalThis.fetch.bind(globalThis)),
  session: '',
  settings: {
    localBaseUrl: process.env.LOCAL_BASE_URL ?? 'http://localhost:11434/v1',
    localModel: process.env.LOCAL_MODEL ?? 'qwen2.5vl:7b',
    gatewayUrl: process.env.WXT_GATEWAY_URL ?? 'http://localhost:8787',
  },
  cache: new FileCacheStore(),
};

function providerFor(route: EvalRoute): Provider {
  if (route === 'mock') return 'mock';
  if (route === 'local') return 'local';
  const p = (args.provider as string | undefined) ?? process.env.PROVIDER ?? 'mock';
  return p as Provider;
}

const problems = loadProblems(limit, only);
console.log(`${problems.length} problem(s) × ${routes.join(', ')}`);

let totalCost = 0;
for (const route of routes) {
  for (const problem of problems) {
    const started = Date.now();
    let out: EvalOutput;
    try {
      const req = buildRequest(problem, route);
      let text = '';
      let usage: EvalOutput['usage'];
      let model = '';
      let cached = false;
      let error: string | undefined;
      for await (const chunk of callModel(req, req.plan.route, ctx, {
        provider: providerFor(route),
        vendor,
        model: modelArg ? { vendor, model: modelArg } : null,
      })) {
        if (chunk.type === 'delta') text += chunk.text;
        else if (chunk.type === 'done') {
          usage = chunk.usage;
          model = `${chunk.model.vendor}/${chunk.model.model}`;
          cached = chunk.cached;
        } else error = chunk.message;
      }
      out = {
        id: problem.id,
        route,
        model,
        text,
        usage,
        cached,
        error,
        ms: Date.now() - started,
        parts: req.plan.parts.map((p) => ({ kind: p.kind, size: p.kind === 'image' ? p.width * p.height : JSON.stringify(p).length })),
      };
    } catch (err) {
      out = { id: problem.id, route, model: '', text: '', cached: false, error: (err as Error).message, ms: Date.now() - started, parts: [] };
    }
    totalCost += out.usage?.costUsd ?? 0;
    writeOutput(out);
    const status = out.error ? `ERROR ${out.error}` : `${out.cached ? 'replay' : 'live'} ${out.model} ${out.ms}ms`;
    console.log(`  [${route}] ${problem.id}: ${status}`);
  }
}
console.log(`done · est. spend $${totalCost.toFixed(4)} · outputs in eval/out/`);
