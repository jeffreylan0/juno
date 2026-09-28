/**
 * Builds a Plan from a selection. Week-2 scope: a box selection becomes an
 * image part plus any DOM text the content script recovered; text selections
 * become a text part. Weeks 5–6 replace `partsFor` with the extractors
 * (visible text, KaTeX/MathJax, tables, code) and add crops only for visual or
 * layout-sensitive content.
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
  const parts: Part[] = [];
  const text = input.selection.text?.trim();
  if (text) parts.push({ kind: 'text', text, source: input.selection.kind === 'text' ? 'selection' : 'element' });
  if (input.capture) {
    parts.push({
      kind: 'image',
      dataUrl: input.capture.dataUrl,
      width: input.capture.width,
      height: input.capture.height,
      // Week 2: every box is user-requested; the extractors later downgrade this to
      // 'visual' | 'layout' | 'fallback' or drop the crop entirely.
      reason: input.selection.kind === 'box' ? 'user' : 'fallback',
    });
  }
  return parts;
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
      label: input.selection.label,
    },
    page: input.selection.page,
    route: chooseRoute(base),
    estimatedTokens: estimateTokens(parts, input.question),
  };
}
