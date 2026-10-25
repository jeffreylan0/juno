/**
 * Rich answers (desktop/src/lib/blocks): the blocks an answer can draw,
 * what they draw, that nothing in their JSON becomes markup or a link, and
 * a form's choices going back as the next question.
 */
import { describe, expect, it } from 'vitest';
import { ASK_EVENT, enhanceBlocks } from '@/lib/blocks';
import { compile } from '@/lib/blocks/expr';
import { renderMarkdownFragment } from '@/lib/render';

/** An answer, rendered and drawn as the panel shows it. */
function answer(markdown: string, done = true): HTMLElement {
  const box = document.createElement('div');
  const nodes = renderMarkdownFragment(markdown);
  enhanceBlocks(nodes, done);
  box.append(nodes);
  document.body.append(box);
  return box;
}

const block = (kind: string, spec: unknown) => `Here it is.\n\n\`\`\`${kind}\n${JSON.stringify(spec)}\n\`\`\`\n\nDone.`;

describe('functions of x', () => {
  it('reads what models write, without eval', () => {
    const cases: [string, number, number][] = [
      ['x^2 - 3x + 2', 2, 0],
      ['sin(x)^2 + cos(x)^2', 1.3, 1],
      ['sin x^2', 2, Math.sin(4)],
      ['-x^2', 3, -9],
      ['2e^(-x)', 0, 2],
      ['y = 3x + 1', 2, 7],
      ['xsin(x)', Math.PI / 2, Math.PI / 2],
      ['(x+1)(x-1)', 3, 8],
      ['2^-x', 1, 0.5],
      ['πx', 1, Math.PI],
      ['ln(e^x)', 2, 2],
    ];
    for (const [src, x, want] of cases) expect(compile(src)?.(x), src).toBeCloseTo(want);
  });

  it('refuses anything that isn’t one', () => {
    for (const bad of ['alert(1)', 'x +', '(x', 'constructor', 'x;1', 'fetch("a")', 'x)', 'window', '__proto__', 'x'.repeat(201)]) expect(compile(bad), bad).toBeNull();
  });
});

describe('drawn blocks', () => {
  it('plots curves, with a key for two and the asymptote left open', () => {
    const box = answer(block('plot', { title: 'Two curves', fns: [{ f: 'tan(x)', label: 'tan' }, 'x/2'], x: [-3, 3] }));
    const fig = box.querySelector('figure.jb-plot')!;
    expect(fig.querySelector('figcaption')!.textContent).toBe('Two curves');
    expect([...fig.querySelectorAll('.jb-key')].map((k) => k.textContent)).toEqual(['tan', 'y = x/2']);
    const tan = fig.querySelector('path.jb-line.jb-s0')!.getAttribute('d')!;
    // Lifted at ±π/2: three pieces.
    expect(tan.match(/M/g)).toHaveLength(3);
    expect(box.querySelector('pre')).toBeNull();
  });

  it('charts bars, folds a pie past six slices into Other, and scatters points', () => {
    const bars = answer(block('chart', { type: 'bar', labels: ['A', 'B', 'C'], series: [{ name: 'One', values: [3, -1, 5] }, { name: 'Two', values: [1, 2, 3] }] }));
    expect(bars.querySelectorAll('path.jb-bar')).toHaveLength(6);
    expect(bars.querySelector('path.jb-bar title')!.textContent).toBe('A · One: 3');
    const pie = answer(block('chart', { type: 'pie', labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], series: [{ values: [8, 7, 6, 5, 4, 3, 2, 1] }] }));
    const keys = [...pie.querySelectorAll('.jb-key')].map((k) => k.textContent);
    expect(keys).toHaveLength(6);
    expect(keys.at(-1)).toBe('Other 16.7%');
    const scatter = answer(block('chart', { type: 'scatter', series: [{ values: [[1, 2], [3, 4], ['x', 1]] }] }));
    expect(scatter.querySelectorAll('circle.jb-dot')).toHaveLength(2);
  });

  it('lays a diagram out in layers, a cycle included, nodes named by arrows alone too', () => {
    const box = answer(
      block('diagram', {
        nodes: [{ id: 'a', label: 'Light energy' }, { id: 'b', label: 'Chlorophyll' }],
        edges: [{ from: 'a', to: 'b', label: 'absorbed' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }],
      }),
    );
    const nodes = [...box.querySelectorAll('rect.jb-node')];
    expect(nodes).toHaveLength(3);
    const ys = nodes.map((n) => Number(n.getAttribute('y')));
    expect(ys[0]).toBeLessThan(ys[1]!);
    expect(ys[1]).toBeLessThan(ys[2]!);
    expect(box.querySelectorAll('path.jb-arrow')).toHaveLength(3);
    expect(box.querySelector('.jb-edge-label')!.textContent).toBe('absorbed');
  });

  it('sends a form’s choices as the next question, then keeps what was sent', () => {
    const box = answer(block('form', { title: 'Practice', questions: [{ q: 'What is $2+2$?', options: ['3', '4'] }, { q: 'Which apply?', options: ['a', 'b', 'c'], multi: true, other: true }] }));
    const send = box.querySelector<HTMLButtonElement>('.jb-send')!;
    expect(send.disabled).toBe(true);
    // Maths in a question is drawn.
    expect(box.querySelector('legend .katex')).not.toBeNull();
    const asked: string[] = [];
    box.addEventListener(ASK_EVENT, (e) => asked.push((e as CustomEvent<string>).detail));
    const inputs = [...box.querySelectorAll<HTMLInputElement>('.jb-option input')];
    inputs[1]!.click();
    inputs[2]!.click();
    inputs[4]!.click();
    inputs[1]!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(send.disabled).toBe(false);
    send.click();
    expect(asked).toEqual(['My answers to the form:\n\nWhat is $2+2$?\n4\n\nWhich apply?\na; c']);
    expect([...box.querySelectorAll('input')].every((i) => i.disabled)).toBe(true);
    expect(send.textContent).toBe('Sent');
  });

  it('keeps a form until its answer is all there, and as it was if the panel couldn’t ask', () => {
    const md = block('form', { questions: [{ q: 'Which?', options: ['A', 'B'] }] });
    expect(answer(md, false).querySelector('.jb-coming')!.textContent).toBe('Writing the questions…');
    const box = answer(md);
    box.addEventListener(ASK_EVENT, (e) => e.preventDefault());
    const input = box.querySelector<HTMLInputElement>('.jb-option input')!;
    input.click();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    box.querySelector<HTMLButtonElement>('.jb-send')!.click();
    expect(input.disabled).toBe(false);
    expect(box.querySelector('.jb-send')!.textContent).toBe('Send');
  });

  it('shows slides one at a time, by tab or arrow', () => {
    const box = answer(block('slides', { slides: [{ title: 'Mitosis', body: 'Two **identical** cells' }, { title: 'Meiosis', body: 'Four cells' }] }));
    const slide = () => box.querySelector('.jb-slide')!.textContent!.trim();
    expect(slide()).toBe('MitosisTwo identical cells');
    box.querySelectorAll<HTMLButtonElement>('.jb-tab')[1]!.click();
    expect(slide()).toBe('MeiosisFour cells');
    expect(box.querySelector('.jb-count')!.textContent).toBe('2 / 2');
    expect(box.querySelector<HTMLButtonElement>('.jb-step[aria-label=Next]')!.disabled).toBe(true);
  });

  it('says what is coming while a block streams in, and leaves one it can’t draw as code', () => {
    const half = 'Look:\n\n```plot\n{"fns":["x^2"],"x":[';
    expect(answer(half, false).querySelector('.jb-coming')!.textContent).toBe('Drawing the graph…');
    expect(answer(half, true).querySelector('pre code.language-plot')).not.toBeNull();
    expect(answer(block('plot', { fns: ['alert(1)'] })).querySelector('pre code.language-plot')).not.toBeNull();
    // Any other code is code.
    expect(answer('```js\nconst a = "$1 and $2";\n```').querySelector('code')!.textContent).toBe('const a = "$1 and $2";\n');
  });

  it('turns nothing in the JSON into markup, a fetch or a handler; a form’s or a slide’s Markdown is sanitized like the answer’s', () => {
    const evil = '<img src=x onerror=alert(1)><a href="https://evil.example">x</a>';
    const box = answer(
      [
        block('plot', { title: evil, fns: [{ f: 'x', label: evil }], points: [[0, 0, evil]] }),
        block('chart', { type: 'bar', title: evil, labels: [evil], series: [{ name: evil, values: [1] }, { name: 'b', values: [2] }] }),
        block('diagram', { title: evil, nodes: [{ id: 'a', label: evil }], edges: [{ from: 'a', to: evil, label: evil }] }),
        block('form', { title: evil, questions: [{ q: evil, options: [evil] }] }),
        block('slides', { slides: [{ title: evil, body: evil }] }),
      ].join('\n\n'),
    );
    expect(box.querySelectorAll('figure')).toHaveLength(5);
    expect(box.querySelector('img, script, iframe')).toBeNull();
    // The drawings hold text only.
    expect(box.querySelector('.jb-plot a, .jb-chart a, .jb-diagram a, svg a')).toBeNull();
    for (const el of box.querySelectorAll('*')) {
      for (const attr of el.attributes) expect(attr.name.startsWith('on'), `${el.tagName} ${attr.name}`).toBe(false);
    }
    // A link in Markdown opens in the browser, as anywhere in an answer (platform/links.ts).
    for (const a of box.querySelectorAll('a')) expect(a.getAttribute('target')).toBe('_blank');
  });

  it('lets a wide table scroll inside the answer', () => {
    const box = answer('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(box.querySelector('.jb-table > table')).not.toBeNull();
  });
});
