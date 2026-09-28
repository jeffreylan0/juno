import { describe, expect, it } from 'vitest';
import { buildPlan } from '@/lib/planner';
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
