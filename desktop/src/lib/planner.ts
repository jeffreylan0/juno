/**
 * Builds a Plan from a selection: exactly what the student selected, nothing
 * the extension read off the page on its own.
 *
 *   box      → the screenshot crop, and only the crop. Reading it (text,
 *              maths, tables) is the model's job: every model we use reads
 *              images well, and page text scraped from under a box came out
 *              garbled on real layouts.
 *   freeform → the crop of the shape's bounding box, with everything outside
 *              the outline blanked before it leaves the browser (capture.ts).
 *
 * This departs from the plan's "cheapest exact form" planner, by the product
 * owner's call. The eval keeps a `planner` route (eval/lib.ts) so the
 * text-extraction idea can still be measured for Gate A.
 */
import { estimateTokens, type Mode, type Part, type Plan, type Point, type Rect } from '@shared/payload';
import type { SelectionDoneMsg } from './messages';
import { chooseRoute } from './router';

/** A screenshot of the selection, cropped. */
export interface CaptureResult {
  dataUrl: string;
  width: number;
  height: number;
}

export interface PlanInput {
  selection: SelectionDoneMsg;
  mode: Mode;
  question?: string;
  /** Crop of the selection, when the background captured one. */
  capture?: CaptureResult;
}

export function partsFor({ capture }: PlanInput): Part[] {
  return capture ? [{ kind: 'image', dataUrl: capture.dataUrl, width: capture.width, height: capture.height, reason: 'user' }] : [];
}

/** A freeform outline relative to its bounding rect, 0..1, to four decimals. */
export function normaliseOutline(path: Point[], rect: Rect): Point[] {
  const w = rect.width || 1;
  const h = rect.height || 1;
  const r = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1e4) / 1e4;
  return path.map((p) => ({ x: r((p.x - rect.x) / w), y: r((p.y - rect.y) / h) }));
}

export function buildPlan(input: PlanInput, id = crypto.randomUUID()): Plan {
  const parts = partsFor(input);
  const base = { parts, mode: input.mode, question: input.question };
  return {
    id,
    createdAt: Date.now(),
    mode: input.mode,
    question: input.question,
    parts,
    selection: {
      kind: input.selection.kind,
      rect: input.selection.rect,
      devicePixelRatio: input.selection.devicePixelRatio,
      ...(input.selection.kind === 'freeform' && input.selection.path?.length
        ? { outline: normaliseOutline(input.selection.path, input.selection.rect) }
        : {}),
    },
    page: input.selection.page,
    route: chooseRoute(base),
    estimatedTokens: estimateTokens(parts, input.question),
  };
}
