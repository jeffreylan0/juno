/**
 * Grades eval/out/<route>/*.json against each problem's answer key and reports
 * accuracy and cost per route. Exit code 1 when Gate A fails (planner more than
 * 2 points below image-only) so CI can enforce it.
 *
 *   pnpm eval:score            # all routes present in eval/out
 *   pnpm eval:score --gate     # also enforce Gate A
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_ROUTES, OUT_DIR, loadProblems, parseArgs, type EvalOutput, type EvalRoute, type Problem } from './lib';

export interface Grade {
  id: string;
  route: EvalRoute;
  correct: boolean;
  extracted: string | null;
  costUsd: number;
  error?: string;
}

/** Pulls the model's final answer: the "Answer:" line if present, else the last line. */
export function extractAnswer(text: string): string | null {
  const m = /^\s*\**answer\**\s*[:=]\s*(.+?)\s*$/im.exec(text);
  if (m?.[1]) return m[1].replace(/\*+/g, '').trim();
  const lines = text.trim().split('\n').filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1]!.trim() : null;
}

// Fraction forms first so "1/3" is not read as 1 and 3.
const NUMBER_RE = /\\(?:d|t)?frac\{(-?\d+)\}\{(\d+)\}|-?\d+\s*\/\s*\d+|-?\d+(?:\.\d+)?(?:e-?\d+)?/gi;

export function numbersIn(s: string): number[] {
  const out: number[] = [];
  for (const m of s.replace(/,/g, '').matchAll(NUMBER_RE)) {
    const tok = m[0];
    if (m[1] && m[2]) out.push(Number(m[1]) / Number(m[2]));
    else if (tok.includes('/')) {
      const [a, b] = tok.split('/').map((x) => Number(x.trim()));
      if (b) out.push(a! / b);
    } else out.push(Number(tok));
  }
  return out.filter((n) => Number.isFinite(n));
}

export function isCorrect(problem: Problem, text: string): { correct: boolean; extracted: string | null } {
  const extracted = extractAnswer(text);
  const { numeric, tolerance = 0, accept = [] } = problem.answer;
  if (!extracted) return { correct: false, extracted };
  // Only the extracted answer line is graded, so a rendering example or an
  // intermediate value elsewhere in the reply cannot produce a false positive.
  const hay = extracted.toLowerCase();
  const hit = accept.some((a) => {
    const needle = a.toLowerCase();
    if (/^[\d.]+$/.test(needle)) return false; // bare numbers go through the numeric check
    return hay.includes(needle);
  });
  if (hit) return { correct: true, extracted };
  if (numeric !== undefined) {
    const nums = numbersIn(extracted);
    if (nums.some((n) => Math.abs(n - numeric) <= tolerance + 1e-9)) return { correct: true, extracted };
  }
  return { correct: false, extracted };
}

function loadOutputs(route: EvalRoute): EvalOutput[] {
  const dir = join(OUT_DIR, route);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalOutput);
}

export function scoreAll(): Record<EvalRoute, { n: number; correct: number; accuracy: number; costUsd: number; grades: Grade[] }> {
  const problems = new Map(loadProblems().map((p) => [p.id, p]));
  const report = {} as ReturnType<typeof scoreAll>;
  for (const route of EVAL_ROUTES) {
    const outs = loadOutputs(route);
    if (!outs.length) continue;
    const grades: Grade[] = outs.map((o) => {
      const p = problems.get(o.id);
      if (!p || o.error) return { id: o.id, route, correct: false, extracted: null, costUsd: 0, error: o.error ?? 'unknown problem' };
      const g = isCorrect(p, o.text);
      return { id: o.id, route, ...g, costUsd: o.usage?.costUsd ?? 0 };
    });
    const correct = grades.filter((g) => g.correct).length;
    report[route] = {
      n: grades.length,
      correct,
      accuracy: grades.length ? (100 * correct) / grades.length : 0,
      costUsd: grades.reduce((s, g) => s + g.costUsd, 0),
      grades,
    };
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const report = scoreAll();
  const rows = Object.entries(report);
  if (!rows.length) {
    console.log('No outputs in eval/out. Run `pnpm eval:run` first.');
    process.exit(0);
  }
  console.log('route        n   correct  accuracy   cost');
  for (const [route, r] of rows) {
    console.log(`${route.padEnd(12)} ${String(r.n).padStart(2)}   ${String(r.correct).padStart(2)}      ${r.accuracy.toFixed(1).padStart(5)}%   $${r.costUsd.toFixed(4)}`);
  }
  for (const [route, r] of rows) {
    for (const g of r.grades.filter((g) => !g.correct)) {
      console.log(`  ✗ [${route}] ${g.id}: ${g.error ?? `got "${g.extracted}"`}`);
    }
  }
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  // CI runs the free mock route, where the placeholder answer is deliberately
  // wrong; what matters there is that every problem ran without an error.
  if (args['no-errors']) {
    const failed = rows.flatMap(([, r]) => r.grades.filter((g) => g.error));
    if (failed.length) {
      console.log(`${failed.length} problem(s) errored; the pipeline is broken.`);
      process.exit(1);
    }
    console.log('No pipeline errors.');
  }

  if (args.gate) {
    const planner = report.planner?.accuracy;
    const image = report['image-only']?.accuracy;
    if (planner === undefined || image === undefined) {
      console.log('Gate A: need both planner and image-only outputs');
      process.exit(1);
    }
    const ok = planner >= image - 2;
    console.log(`Gate A: planner ${planner.toFixed(1)}% vs image-only ${image.toFixed(1)}% → ${ok ? 'PASS' : 'FAIL'}`);
    process.exit(ok ? 0 : 1);
  }
}
