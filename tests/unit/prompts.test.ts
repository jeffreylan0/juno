import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPTS, attachmentsPrompt, splitWhatIRead, systemPrompt, userPromptText } from '@shared/prompts';
import { kindIcon, kindLabel, KIND_ICON } from '@/lib/kinds';
import { canonicalizeRequest, estimateTokens, stableStringify, type Plan } from '@shared/payload';

describe('prompts', () => {
  it('every mode carries the format and What-I-read instructions', () => {
    for (const mode of ['explain', 'hint', 'check'] as const) {
      const p = systemPrompt(mode);
      expect(p).toContain('KaTeX');
      expect(p).toContain('"Read:"');
    }
    expect(systemPrompt('hint')).toContain('Do NOT give the final answer');
  });

  it('splits the Read: line from the body', () => {
    expect(splitWhatIRead('Read: an integral\n\nThe answer is 1/3')).toEqual({ read: 'an integral', body: 'The answer is 1/3' });
    expect(splitWhatIRead('No preamble')).toEqual({ read: null, body: 'No preamble' });
  });

  it('renders parts and falls back to a default question', () => {
    const plan: Plan = {
      id: 'x',
      createdAt: 0,
      mode: 'check',
      parts: [
        { kind: 'latex', latex: 'x^2', display: true },
        { kind: 'code', code: 'print(1)', language: 'python' },
      ],
      selection: { kind: 'text', rect: { x: 0, y: 0, width: 0, height: 0 }, devicePixelRatio: 1 },
      page: { url: '', title: 'Quiz' },
      route: 'large',
      estimatedTokens: 0,
    };
    const text = userPromptText(plan);
    expect(text).toContain('$$x^2$$');
    expect(text).toContain('```python');
    expect(text).toContain(`Question: ${DEFAULT_PROMPTS.check}`);
  });
});

describe('chats saved by earlier versions', () => {
  it('still read well: a text or element selection is "a selection", with the box icon', () => {
    const page = { url: '', title: 'Notes' };
    const text = attachmentsPrompt(
      [
        { kind: 'box', page, parts: [{ kind: 'image', dataUrl: '', width: 1, height: 1, reason: 'user' }] },
        // As stored by an earlier version.
        { kind: 'text' as never, page, parts: [{ kind: 'text', text: 'F = ma' }] },
      ],
      'Why?',
      'ask',
    );
    expect(text).toContain('Selection 1 (box) from "Notes"');
    expect(text).toContain('Selection 2 (selection) from "Notes":\n[Part 2: text]\nF = ma');
    expect([kindLabel('element'), kindLabel('freeform')]).toEqual(['Selection', 'Freeform']);
    expect(kindIcon('text')).toBe(KIND_ICON.box);
  });
});

describe('payload helpers', () => {
  it('stableStringify sorts keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
  });

  it('canonicalizeRequest drops non-content fields', () => {
    const c = canonicalizeRequest({
      plan: {
        id: 'x',
        createdAt: 5,
        mode: 'explain',
        parts: [{ kind: 'text', text: 'hi', source: 'selection' }],
        selection: { kind: 'box', rect: { x: 1, y: 1, width: 1, height: 1 }, devicePixelRatio: 3 },
        page: { url: 'u', title: 't' },
        route: 'small',
        estimatedTokens: 9,
      },
    }) as Record<string, unknown>;
    expect(Object.keys(c).sort()).toEqual(['history', 'mode', 'model', 'parts', 'question', 'route']);
    expect(c.parts).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  it('estimates image tokens by area', () => {
    expect(estimateTokens([{ kind: 'image', dataUrl: '', width: 750, height: 1000, reason: 'user' }])).toBe(1040);
  });
});
