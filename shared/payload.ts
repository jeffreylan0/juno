/**
 * One payload schema shared by the extension, the Worker and the eval scripts.
 *
 * A Plan is what the local planner produces from a selection: an ordered list of
 * Parts, each in its cheapest exact form (text, LaTeX, table, code) with an image
 * only where the content is visual or layout-sensitive.
 */

/**
 * How the model is briefed. The extension uses `ask`: one general tutor brief,
 * with the student's macro (Explain, Hint, Check or their own) carrying what
 * they want in the question itself. The fixed modes stay for the eval, which
 * measures each behaviour on its own.
 */
export type Mode = 'ask' | 'explain' | 'hint' | 'check';

export type Route = 'small' | 'large';

export type Provider = 'mock' | 'local' | 'byok' | 'gateway';
export type Vendor = 'anthropic' | 'openai' | 'local' | 'mock';

export interface ModelRef {
  vendor: Vendor;
  /** Vendor model id, e.g. "claude-haiku-4-5-20251001" or "gpt-6-luna". */
  model: string;
}

/** Why an image part was included instead of an exact form. */
export type ImageReason = 'visual' | 'layout' | 'fallback' | 'user';

export interface TextPart {
  kind: 'text';
  text: string;
  /** Where the text came from: DOM selection, alt text, OCR, ... */
  source?: 'selection' | 'element' | 'alt' | 'ocr';
}

export interface LatexPart {
  kind: 'latex';
  latex: string;
  display: boolean;
  /** Original renderer the LaTeX was recovered from, for eval bookkeeping. */
  origin?: 'katex' | 'mathjax2' | 'mathjax3' | 'alt' | 'mathml';
}

export interface TablePart {
  kind: 'table';
  /** GitHub-flavoured Markdown table. */
  markdown: string;
  rows: number;
  cols: number;
}

export interface CodePart {
  kind: 'code';
  code: string;
  language?: string;
}

export interface ImagePart {
  kind: 'image';
  /** data:image/png;base64,... */
  dataUrl: string;
  width: number;
  height: number;
  reason: ImageReason;
}

export type Part = TextPart | LatexPart | TablePart | CodePart | ImagePart;

/** A CSS-pixel rectangle relative to the viewport. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * box: a dragged rectangle. text: a text selection. element: one page element,
 * picked by hovering. freeform: any closed shape drawn around something; the
 * crop is its bounding box with everything outside the outline blanked.
 */
export type SelectionKind = 'text' | 'box' | 'element' | 'freeform';

/** A point in viewport CSS pixels. */
export interface Point {
  x: number;
  y: number;
}

export interface SelectionMeta {
  kind: SelectionKind;
  /** Viewport rect of the selection in CSS pixels. */
  rect: Rect;
  devicePixelRatio: number;
  /** For element selections: what was picked, in words ("Table", "Equation"). */
  label?: string;
  /** The element ran past the edge of the screen, so only the visible part was captured. */
  clipped?: boolean;
  /**
   * Freeform selections: the outline, normalised to the selection's rect
   * (0..1 on each axis), so the panel can show exactly what was inside it.
   */
  outline?: Point[];
}

export interface PageMeta {
  url: string;
  title: string;
}

export interface Plan {
  /** Stable id (uuid) used for cache keys and eval bookkeeping. */
  id: string;
  createdAt: number;
  mode: Mode;
  /** The student's optional typed question. */
  question?: string;
  parts: Part[];
  selection: SelectionMeta;
  page: PageMeta;
  /** Planner's route decision. Providers may override with an explicit ModelRef. */
  route: Route;
  /** Approximate prompt tokens, for cost estimates in the tray. */
  estimatedTokens: number;
}

/** One selection as sent to the model: what was selected, and from which page. */
export interface Attachment {
  kind: SelectionKind;
  page: PageMeta;
  parts: Part[];
  /** Element selections: what was picked ("Table"). */
  label?: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  /** Selections that went with this question. A chat can hold many, from many pages. */
  attachments?: Attachment[];
}

export interface AskRequest {
  plan: Plan;
  /**
   * Selections attached to the question being asked now. When this is set
   * (even to []), every turn carries its own selections and plan.parts is not
   * used; the extension always sets it. When it is absent, plan.parts is the
   * one selection of a single-selection conversation (the eval, older callers).
   */
  attachments?: Attachment[];
  /** Prior turns in this conversation. */
  history?: ChatTurn[];
  model?: ModelRef;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** USD, estimated from public list prices. */
  costUsd?: number;
}

export type AskChunk =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage?: Usage; model: ModelRef; cached: boolean }
  | { type: 'error'; message: string; code?: string };

/**
 * Returns the cache-relevant subset of a request in a stable key order.
 * Attachments only appear when a request has them, so single-selection
 * requests (the eval's recordings) hash exactly as they always did.
 */
export function canonicalizeRequest(req: AskRequest): unknown {
  const { plan, history = [], model } = req;
  const attachment = (a: Attachment) => ({ kind: a.kind, page: a.page.title, parts: a.parts.map(canonicalizePart) });
  return {
    mode: plan.mode,
    question: plan.question ?? '',
    parts: plan.parts.map(canonicalizePart),
    history: history.map((h) =>
      h.attachments?.length ? { role: h.role, text: h.text, attachments: h.attachments.map(attachment) } : { role: h.role, text: h.text },
    ),
    model: model ? `${model.vendor}/${model.model}` : null,
    route: plan.route,
    ...(req.attachments ? { attachments: req.attachments.map(attachment) } : {}),
  };
}

function canonicalizePart(p: Part): unknown {
  switch (p.kind) {
    case 'text':
      return { kind: p.kind, text: p.text };
    case 'latex':
      return { kind: p.kind, latex: p.latex, display: p.display };
    case 'table':
      return { kind: p.kind, markdown: p.markdown };
    case 'code':
      return { kind: p.kind, code: p.code, language: p.language ?? '' };
    case 'image':
      return { kind: p.kind, dataUrl: p.dataUrl };
  }
}

/** Deterministic JSON (sorted keys) so identical payloads hash identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Rough token estimate: 4 chars per token for text, fixed cost per image tile. */
export function estimateTokens(parts: Part[], question = ''): number {
  let n = Math.ceil(question.length / 4) + 40;
  for (const p of parts) {
    switch (p.kind) {
      case 'text':
        n += Math.ceil(p.text.length / 4);
        break;
      case 'latex':
        n += Math.ceil(p.latex.length / 3);
        break;
      case 'table':
        n += Math.ceil(p.markdown.length / 3);
        break;
      case 'code':
        n += Math.ceil(p.code.length / 3);
        break;
      case 'image':
        // Anthropic: (w*h)/750; OpenAI is similar order of magnitude.
        n += Math.ceil((p.width * p.height) / 750);
        break;
    }
  }
  return n;
}
