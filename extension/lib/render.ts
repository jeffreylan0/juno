/**
 * Markdown → sanitized HTML with KaTeX (and mhchem) for $...$ / $$...$$.
 * Math is rendered before Markdown so underscores inside formulas survive,
 * then everything passes through DOMPurify.
 */
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/contrib/mhchem';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

const PLACEHOLDER = (i: number) => `\u0000MATH${i}\u0000`;

export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore' });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

/** Replaces math with placeholders, renders Markdown, then restores KaTeX HTML. */
export function renderMarkdown(src: string): string {
  const math: string[] = [];
  let text = src;
  // Display math first: $$...$$ and \[...\]
  text = text.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_m, a: string | undefined, b: string | undefined) => {
    math.push(renderMath((a ?? b ?? '').trim(), true));
    return PLACEHOLDER(math.length - 1);
  });
  // Inline math: $...$ (not $$) and \(...\)
  text = text.replace(/(?<!\$)\$(?!\$)((?:\\\$|[^$\n])+?)\$(?!\$)|\\\(([\s\S]+?)\\\)/g, (_m, a: string | undefined, b: string | undefined) => {
    math.push(renderMath((a ?? b ?? '').trim(), false));
    return PLACEHOLDER(math.length - 1);
  });
  let html = marked.parse(text, { async: false }) as string;
  html = html.replace(/\u0000MATH(\d+)\u0000/g, (_m, i: string) => math[Number(i)] ?? '');
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true, svg: true } });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
