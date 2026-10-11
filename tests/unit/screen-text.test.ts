import { describe, expect, it } from 'vitest';
import {
  highlightRects,
  layoutOf,
  needsPicture,
  outlinesOf,
  readingOrder,
  targetsAt,
  textOf,
  windowTitle,
  wordNear,
  wordsBetween,
  type ScreenLine,
  type ScreenRead,
} from '@/lib/screen-text';

/** A line of text at (x, y), 20px tall, words 10px per character with a 10px space. */
function line(text: string, x: number, y: number, confidence = 0.95): ScreenLine {
  let at = x;
  const words = text.split(' ').map((w) => {
    const rect = { x: at, y, width: w.length * 10, height: 20 };
    at += w.length * 10 + 10;
    return { text: w, rect };
  });
  return { text, rect: { x, y, width: at - 10 - x, height: 20 }, words, confidence };
}

const VIEW = { width: 1200, height: 800 };

/** Two columns: a two-line paragraph and a one-line one on the left, one paragraph on the right. */
const page: ScreenRead = {
  lines: [
    line('Find the area of', 40, 100),
    line('Each side is 200', 600, 100),
    line('the red square.', 40, 128),
    line('pixels long.', 600, 128),
    line('Show your work.', 40, 200),
  ],
  windows: [{ app: 'Preview', title: 'quiz.pdf', rect: { x: 20, y: 60, width: 1100, height: 600 } }],
};

describe('reading the screen', () => {
  const layout = layoutOf(page, VIEW);

  it('orders lines by rows, left to right', () => {
    expect(readingOrder(page.lines).map((l) => l.text)).toEqual(['Find the area of', 'Each side is 200', 'the red square.', 'pixels long.', 'Show your work.']);
  });

  it('groups close lines of one column into paragraphs, not across columns or gaps', () => {
    const para = (text: string) => layout.lines.find((l) => l.text === text)!.para;
    expect(para('Find the area of')).toBe(para('the red square.'));
    expect(para('Each side is 200')).toBe(para('pixels long.'));
    expect(para('Find the area of')).not.toBe(para('Each side is 200'));
    expect(para('Show your work.')).not.toBe(para('the red square.'));
    expect(layout.paragraphs).toHaveLength(3);
  });

  it('finds the word under the pointer, and the nearest one within reach', () => {
    const at = wordNear(layout, 100, 110)!;
    expect(layout.lines[at.line]!.words[at.word]!.text).toBe('the');
    expect(wordNear(layout, 300, 400)).toBeNull();
    expect(wordNear(layout, 300, 400, Infinity)).not.toBeNull();
  });

  it('selects across lines of one column, leaving the other column out', () => {
    const from = wordNear(layout, 100, 110)!; // "the"
    const to = wordNear(layout, 95, 138)!; // "red"
    const words = wordsBetween(layout, to, from); // dragged backwards: same result
    expect(textOf(layout, words)).toBe('the area of the red');
  });

  it('separates paragraphs with a blank line', () => {
    const from = wordNear(layout, 45, 135)!; // "the" of "the red square."
    const to = wordNear(layout, 175, 210)!; // "work."
    expect(textOf(layout, wordsBetween(layout, from, to))).toBe('the red square.\n\nShow your work.');
  });

  it('highlights each line, meeting halfway, and outlines them as one shape', () => {
    const words = wordsBetween(layout, wordNear(layout, 100, 110)!, wordNear(layout, 95, 138)!);
    const rects = highlightRects(layout, words);
    expect(rects).toHaveLength(2);
    expect(rects[0]!.y + rects[0]!.height).toBeCloseTo(rects[1]!.y);
    const outlines = outlinesOf(rects);
    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toHaveLength(8);
  });

  it('offers a line, its paragraph, the window and the screen to Element, smallest first', () => {
    const targets = targetsAt(layout, 100, 110);
    expect(targets.map((t) => t.label)).toEqual(['Line', 'Paragraph', 'Window · Preview', 'Screen']);
    expect(targets[1]!.rect.y).toBeLessThan(100);
    expect(targets[1]!.rect.y + targets[1]!.rect.height).toBeGreaterThan(148);
    // A one-line paragraph is offered once; off the text, the window and the screen.
    expect(targetsAt(layout, 60, 210).map((t) => t.kind)).toEqual(['paragraph', 'window', 'screen']);
    expect(targetsAt(layout, 1150, 700).map((t) => t.kind)).toEqual(['screen']);
  });
});

describe('when the picture goes along with text read off the screen', () => {
  it('not for plain prose read with confidence', () => {
    expect(needsPicture('Explain why the sky is blue.', 0.95)).toBe(false);
  });
  it('when the system was unsure', () => {
    expect(needsPicture('Explain why the sky is blue.', 0.5)).toBe(true);
  });
  it('for anything that looks like mathematics', () => {
    for (const t of ['Find dy/dx if y = x2', 'Solve 3x + 4 = 10', 'f(x) is defined', 'x2 sin x', 'the 1/2 power']) expect(needsPicture(t, 0.99), t).toBe(true);
  });
});

describe('a selection title in the app', () => {
  it('names the window and the app, once', () => {
    expect(windowTitle({ app: 'Preview', title: 'quiz.pdf' })).toBe('quiz.pdf · Preview');
    expect(windowTitle({ app: 'Word', title: 'Lab report - Word' })).toBe('Lab report - Word');
    expect(windowTitle({ app: 'Zoom', title: '' })).toBe('Zoom');
  });
});
