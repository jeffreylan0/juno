/**
 * Builds a Plan from a selection: exactly what the student selected, nothing
 * the extension read off the page on its own.
 *
 *   box      → the screenshot crop, and only the crop. Reading it (OCR,
 *              maths, tables) is the model's job; page text scraped from under
 *              the box came out garbled on real layouts and duplicated what
 *              the image already shows.
 *   element  → the same: a crop snapped to the element's edges.
 *   freeform → the crop of the shape's bounding box, with everything outside
 *              the outline blanked before it leaves the browser (capture.ts).
 *   text     → the selected text, and only the text.
 *
 * This departs from the plan's "cheapest exact form" planner for box
 * selections, by the product owner's call. The eval keeps a `planner` route
 * (eval/lib.ts) so the text-extraction idea can still be measured for Gate A.
 */
import { estimateTokens, type Mode, type Part, type Plan } from '@shared/payload';
import type { SelectionDoneMsg } from './messages';
import { chooseRoute } from './router';
import type { CaptureResult } from './capture';

export interface PlanInput {
  selection: SelectionDoneMsg;
  mode: Mode;
  question?: string;
  /** Crop of the selection, when the background captured one. */
  capture?: CaptureResult;
}

export function partsFor(input: PlanInput): Part[] {
  const { selection, capture } = input;
  const image = (reason: 'user' | 'fallback'): Part[] =>
    capture ? [{ kind: 'image', dataUrl: capture.dataUrl, width: capture.width, height: capture.height, reason }] : [];
  const text = selection.text?.trim();

  switch (selection.kind) {
    case 'box':
    case 'element':
    case 'freeform':
      return image('user');
    case 'text':
      return text ? [{ kind: 'text', text, source: 'selection' }] : [];
  }
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
      ...(input.selection.label ? { label: input.selection.label } : {}),
      ...(input.selection.clipped ? { clipped: true } : {}),
    },
    page: input.selection.page,
    route: chooseRoute(base),
    estimatedTokens: estimateTokens(parts, input.question),
  };
}
