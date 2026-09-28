import { describe, expect, it } from 'vitest';
import { MODEL_TABLE, chooseRoute, estimateCostUsd, modelFor } from '@/lib/router';
import type { Part } from '@shared/payload';

const text = (t: string): Part => ({ kind: 'text', text: t });
const image: Part = { kind: 'image', dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 100, reason: 'user' };

describe('router', () => {
  it('sends short text-only explain asks to the small model', () => {
    expect(chooseRoute({ parts: [text('Solve 2x = 4')], mode: 'explain' })).toBe('small');
    expect(chooseRoute({ parts: [{ kind: 'latex', latex: 'x^2', display: false }], mode: 'hint' })).toBe('small');
  });

  it('sends images to the large model', () => {
    expect(chooseRoute({ parts: [image], mode: 'explain' })).toBe('large');
  });

  it('sends check mode and long or multi-step asks to the large model', () => {
    expect(chooseRoute({ parts: [text('x')], mode: 'check' })).toBe('large');
    expect(chooseRoute({ parts: [text('a'.repeat(2000))], mode: 'explain' })).toBe('large');
    expect(chooseRoute({ parts: [text('x')], mode: 'explain', question: 'Prove that this converges' })).toBe('large');
  });

  it('maps routes to vendor models', () => {
    expect(modelFor('anthropic', 'small').model).toBe(MODEL_TABLE.anthropic.small);
    expect(modelFor('openai', 'large')).toEqual({ vendor: 'openai', model: 'gpt-6-sol' });
  });

  it('estimates cost from list prices', () => {
    expect(estimateCostUsd('gpt-6-luna', 1_000_000, 0)).toBeCloseTo(0.1);
    expect(estimateCostUsd('unknown-model', 1, 1)).toBeUndefined();
  });
});
