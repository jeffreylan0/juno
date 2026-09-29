import { describe, expect, it } from 'vitest';
import { buildPlan, normaliseOutline } from '@/lib/planner';
import type { SelectionDoneMsg } from '@/lib/messages';

const box: SelectionDoneMsg = {
  type: 'selection:done',
  kind: 'box',
  rect: { x: 10, y: 10, width: 200, height: 100 },
  devicePixelRatio: 2,
  page: { url: 'https://example.com/hw', title: 'Homework' },
};

describe('planner (week-2 scope)', () => {
  it('turns a box with a capture into an image part routed large', () => {
    const plan = buildPlan({ selection: box, mode: 'explain', capture: { dataUrl: 'data:image/png;base64,AA', width: 400, height: 200 } }, 'id1');
    expect(plan.id).toBe('id1');
    expect(plan.parts).toEqual([{ kind: 'image', dataUrl: 'data:image/png;base64,AA', width: 400, height: 200, reason: 'user' }]);
    expect(plan.route).toBe('large');
    expect(plan.estimatedTokens).toBeGreaterThan(100);
  });

  it('turns a text selection into a text part routed small', () => {
    const plan = buildPlan({ selection: { ...box, kind: 'text', text: 'Solve x+1=2' }, mode: 'hint' });
    expect(plan.parts).toEqual([{ kind: 'text', text: 'Solve x+1=2', source: 'selection' }]);
    expect(plan.route).toBe('small');
    expect(plan.selection.devicePixelRatio).toBe(2);
  });
});

describe('planner: only the selection', () => {
  it('sends a box as its screenshot alone, even when page text came along', () => {
    const plan = buildPlan({
      selection: { ...box, text: 'Claude Opus 4 $15/ MTok $75/ MTok' },
      mode: 'ask',
      capture: { dataUrl: 'data:image/png;base64,AA', width: 400, height: 200 },
    });
    expect(plan.parts.map((p) => p.kind)).toEqual(['image']);
  });

  it('sends nothing for a box whose screenshot failed, rather than guessing', () => {
    expect(buildPlan({ selection: { ...box, text: 'some text' }, mode: 'ask' }).parts).toEqual([]);
  });

  it('sends a text selection as its text alone', () => {
    const plan = buildPlan({
      selection: { ...box, kind: 'text', text: 'F = ma' },
      mode: 'ask',
      capture: { dataUrl: 'data:image/png;base64,AA', width: 1, height: 1 },
    });
    expect(plan.parts).toEqual([{ kind: 'text', text: 'F = ma', source: 'selection' }]);
  });
});

describe('planner: element and freeform', () => {
  const capture = { dataUrl: 'data:image/png;base64,AA', width: 300, height: 120 };

  it('sends an element as its screenshot, labelled, and flags a clipped one', () => {
    const plan = buildPlan({ selection: { ...box, kind: 'element', label: 'Table', clipped: true }, mode: 'ask', capture });
    expect(plan.parts.map((p) => p.kind)).toEqual(['image']);
    expect(plan.selection).toMatchObject({ kind: 'element', label: 'Table', clipped: true });
  });

  it('sends a freeform shape as its (masked) screenshot', () => {
    const plan = buildPlan({ selection: { ...box, kind: 'freeform', path: [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 5, y: 9 }] }, mode: 'ask', capture });
    expect(plan.parts.map((p) => p.kind)).toEqual(['image']);
    expect(plan.route).toBe('large');
  });
});

describe('freeform outline for the panel', () => {
  it('is stored relative to the selection, 0 to 1, clamped', () => {
    const rect = { x: 100, y: 50, width: 200, height: 100 };
    expect(normaliseOutline([{ x: 100, y: 50 }, { x: 300, y: 100 }, { x: 200, y: 160 }], rect)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0.5 },
      { x: 0.5, y: 1 },
    ]);
  });

  it('rides along with a freeform plan only', () => {
    const capture = { dataUrl: 'data:image/png;base64,AA', width: 10, height: 10 };
    const path = [{ x: 10, y: 10 }, { x: 210, y: 10 }, { x: 110, y: 110 }];
    const free = buildPlan({ selection: { ...box, kind: 'freeform', rect: { x: 10, y: 10, width: 200, height: 100 }, path }, mode: 'ask', capture });
    expect(free.selection.outline).toHaveLength(3);
    expect(buildPlan({ selection: { ...box, path }, mode: 'ask', capture }).selection.outline).toBeUndefined();
  });
});
