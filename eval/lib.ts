/**
 * Shared eval plumbing: problem loading, a file-backed cache, and request
 * builders for each route. Runs in Node with tsx.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { estimateTokens, type AskRequest, type Mode, type Part, type Plan } from '@shared/payload';
import type { CacheStore, CachedResponse } from '@/lib/cache';
import { chooseRoute } from '@/lib/router';

// The eval's keys, from .env when there is one (Node reads it itself).
try {
  process.loadEnvFile();
} catch {
  // No .env: the environment as it is.
}

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROBLEMS_DIR = join(ROOT, 'eval', 'problems');
export const OUT_DIR = join(ROOT, 'eval', 'out');
export const CACHE_DIR = join(ROOT, 'eval', 'cache');

export type EvalRoute = 'mock' | 'local' | 'image-only' | 'planner';
export const EVAL_ROUTES: EvalRoute[] = ['mock', 'local', 'image-only', 'planner'];

export interface Problem {
  id: string;
  subject: string;
  page: string;
  selector: string;
  crop?: string;
  question: string;
  answer: { numeric?: number; tolerance?: number; accept?: string[] };
}

export interface EvalOutput {
  id: string;
  route: EvalRoute;
  model: string;
  text: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  cached: boolean;
  error?: string;
  ms: number;
  parts: { kind: Part['kind']; size: number }[];
}

export function loadProblems(limit?: number, only?: string[]): Problem[] {
  const files = readdirSync(PROBLEMS_DIR).filter((f) => f.endsWith('.json')).sort();
  const all = files.map((f) => JSON.parse(readFileSync(join(PROBLEMS_DIR, f), 'utf8')) as Problem);
  const picked = only?.length ? all.filter((p) => only.includes(p.id)) : all;
  return limit ? picked.slice(0, limit) : picked;
}

/** One JSON file per hash under eval/cache. Committed answers replay for free. */
export class FileCacheStore implements CacheStore {
  constructor(private dir = CACHE_DIR) {
    mkdirSync(dir, { recursive: true });
  }
  async get(hash: string): Promise<CachedResponse | undefined> {
    const p = join(this.dir, `${hash}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as CachedResponse) : undefined;
  }
  async set(hash: string, value: CachedResponse): Promise<void> {
    writeFileSync(join(this.dir, `${hash}.json`), JSON.stringify(value, null, 2));
  }
}

export function loadPage(problem: Problem): JSDOM {
  const html = readFileSync(join(ROOT, problem.page), 'utf8');
  return new JSDOM(html, { url: `file://${join(ROOT, problem.page)}` });
}

/**
 * The `planner` route's stand-in for the "cheapest exact form" idea (Gate A):
 * the problem's text, LaTeX, table or code read from its page, instead of the
 * screenshot the app sends.
 */
export function plannerParts(problem: Problem): Part[] {
  const dom = loadPage(problem);
  const el = dom.window.document.querySelector(problem.selector);
  if (!el) throw new Error(`${problem.id}: selector ${problem.selector} not found`);
  const parts: Part[] = [];
  // Prefer exact LaTeX when the page carries it (KaTeX annotation, MathJax script tags).
  const latex: string[] = [];
  el.querySelectorAll('annotation[encoding="application/x-tex"], script[type^="math/tex"]').forEach((n) => {
    const t = n.textContent?.trim();
    if (t) latex.push(t);
  });
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('.katex-html, .MathJax_Preview, .MathJax, script').forEach((n) => n.remove());
  const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (el.tagName === 'TABLE') {
    parts.push(tableToMarkdown(el as HTMLTableElement));
  } else if (el.tagName === 'PRE' || el.querySelector('code')) {
    const code = el.querySelector('code') ?? el;
    const lang = /language-(\w+)/.exec(code.className)?.[1];
    parts.push({ kind: 'code', code: code.textContent ?? '', language: lang });
  } else if (text) {
    parts.push({ kind: 'text', text, source: 'selection' });
  }
  for (const l of latex) parts.push({ kind: 'latex', latex: l, display: false, origin: 'katex' });
  return parts;
}

function tableToMarkdown(table: HTMLTableElement): Part {
  const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent ?? '').trim().replace(/\|/g, '\\|')),
  );
  const cols = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? '').join(' | ')} |`;
  const md = [line(rows[0] ?? []), `| ${Array(cols).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
  return { kind: 'table', markdown: md, rows: rows.length, cols };
}

export function imagePart(problem: Problem): Part | null {
  if (!problem.crop) return null;
  const p = join(ROOT, problem.crop);
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  const { width, height } = pngSize(buf);
  return { kind: 'image', dataUrl: `data:image/png;base64,${buf.toString('base64')}`, width, height, reason: 'user' };
}

function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function partsFor(problem: Problem, route: EvalRoute): Part[] {
  switch (route) {
    case 'image-only': {
      const img = imagePart(problem);
      if (!img) throw new Error(`${problem.id}: no crop; run \`pnpm eval:crops\` first`);
      return [img];
    }
    case 'planner':
    case 'local':
    case 'mock':
      return plannerParts(problem);
  }
}

export function buildRequest(problem: Problem, route: EvalRoute, mode: Mode = 'explain'): AskRequest {
  const parts = partsFor(problem, route);
  const plan: Plan = {
    id: `${problem.id}:${route}`,
    createdAt: 0,
    mode,
    question: problem.question,
    parts,
    selection: { kind: 'box', rect: { x: 0, y: 0, width: 0, height: 0 }, devicePixelRatio: 1 },
    page: { url: problem.page, title: '' },
    route: chooseRoute({ parts, mode, question: problem.question }),
    estimatedTokens: estimateTokens(parts, problem.question),
  };
  return { plan };
}

export function writeOutput(out: EvalOutput): void {
  const dir = join(OUT_DIR, out.route);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${out.id}.json`), JSON.stringify(out, null, 2));
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}
