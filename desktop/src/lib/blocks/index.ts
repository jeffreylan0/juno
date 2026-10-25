/**
 * Rich answers: fenced blocks an answer can hold (shared/prompts.ts says
 * how), each turned from the JSON in it into something to look at or use:
 *
 *   plot     curves of y = f(x)                          (graphs.ts)
 *   chart    bar, line, scatter or pie charts of data     (graphs.ts)
 *   diagram  boxes and arrows: processes, cycles, trees    (diagram.ts)
 *   form     questions to answer by choosing; the choices go back as the next question
 *   slides   one card at a time, with tabs: categories, steps, a gallery
 *
 * and every table scrolls sideways when it's wider than the panel.
 *
 * They run on what DOMPurify has already cleaned (lib/render.ts), and build
 * with DOM calls only. A drawing's strings become text, never markup, a
 * link or a fetch; a form's and a slide's are Markdown, rendered through the
 * same sanitizer as the answer around them. While an answer streams, a
 * block still arriving shows what it will be; one that can't be drawn stays
 * the code it was.
 */
import { renderMarkdownFragment } from '../render';
import { diagramBlock } from './diagram';
import { figure, h, list, obj, str } from './dom';
import { chartBlock, plotBlock } from './graphs';

/**
 * A form's answers, sent as the student's next question (the panel listens:
 * ui/Panel.tsx, and cancels the event if it can't ask now).
 */
export const ASK_EVENT = 'juno:ask';

const BLOCKS: Record<string, { make: (spec: unknown) => HTMLElement; coming: string }> = {
  plot: { make: plotBlock, coming: 'Drawing the graph…' },
  chart: { make: chartBlock, coming: 'Drawing the chart…' },
  diagram: { make: diagramBlock, coming: 'Drawing the diagram…' },
  form: { make: formBlock, coming: 'Writing the questions…' },
  slides: { make: slidesBlock, coming: 'Making the slides…' },
};

/** Turns the blocks in a rendered answer into what they draw; `done`: the answer has all arrived. */
export function enhanceBlocks(root: ParentNode, done: boolean): void {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    const kind = /(?:^|\s)language-(\w+)/.exec(code.className)?.[1]?.toLowerCase() ?? '';
    const block = Object.hasOwn(BLOCKS, kind) ? BLOCKS[kind]! : null;
    const pre = code.parentElement;
    if (!block || !pre) continue;
    let spec: unknown;
    try {
      spec = JSON.parse(code.textContent ?? '');
      // A form is for once the answer is all there: until then, nothing it sent could be asked.
      if (kind === 'form' && !done) throw new Error('not yet');
    } catch {
      if (!done) pre.replaceWith(h('div', 'jb-coming', block.coming));
      continue;
    }
    try {
      pre.replaceWith(block.make(spec));
    } catch {
      // Not something it can draw: it stays the code it is.
    }
  }
  for (const table of root.querySelectorAll('table')) {
    if (table.parentElement?.classList.contains('jb-table')) continue;
    const wrap = h('div', 'jb-table');
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

/** A short piece of Markdown (maths included) inline: its paragraph's contents. */
function inline(text: string): DocumentFragment {
  const frag = renderMarkdownFragment(text);
  const only = frag.children.length === 1 && frag.firstElementChild?.tagName === 'P' ? frag.firstElementChild : null;
  if (!only) return frag;
  const out = document.createDocumentFragment();
  out.append(...only.childNodes);
  return out;
}

let forms = 0;

/**
 * A ```form block: questions, each with choices (one, or several with
 * "multi"; "other" adds a box to write in). Send puts the choices to the
 * model as the student's next question; then the form keeps what was sent.
 *
 *   {"title":"…","questions":[{"q":"…","options":["…","…"],"multi":false,"other":false}],"submit":"Send"}
 */
function formBlock(spec: unknown): HTMLElement {
  const s = obj(spec);
  const questions = list(s.questions, 10)
    .map((raw) => {
      const o = obj(raw);
      return { q: str(o.q ?? o.question, 300), options: list(o.options, 8).map((x) => str(x, 200)).filter(Boolean), multi: o.multi === true, other: o.other === true };
    })
    .filter((q) => q.q && (q.options.length || q.other));
  if (!questions.length) throw new Error('no questions');

  const id = `jb-form-${++forms}`;
  const box = figure('form', str(s.title, 80));
  const send = h('button', 'jb-send', str(s.submit, 30) || 'Send');
  send.type = 'button';
  send.disabled = true;
  const fields = questions.map((q, qi) => {
    const set = h('fieldset', 'jb-question');
    const legendEl = h('legend');
    legendEl.append(inline(q.q));
    set.append(legendEl);
    const inputs = q.options.map((opt, oi) => {
      const row = h('label', 'jb-option');
      const input = h('input');
      input.type = q.multi ? 'checkbox' : 'radio';
      input.name = `${id}-${qi}`;
      input.value = String(oi);
      row.append(input, h('span'));
      row.lastElementChild!.append(inline(opt));
      set.append(row);
      return input;
    });
    let other: HTMLInputElement | null = null;
    if (q.other) {
      other = h('input', 'jb-other');
      other.type = 'text';
      other.placeholder = 'Other…';
      other.maxLength = 200;
      other.setAttribute('aria-label', `${q.q}: other`);
      set.append(other);
    }
    box.append(set);
    return { q, inputs, other };
  });
  const chosen = () =>
    fields.map(({ q, inputs, other }) => [...inputs.filter((i) => i.checked).map((i) => q.options[Number(i.value)]!), ...(other?.value.trim() ? [other.value.trim()] : [])]);
  box.addEventListener('input', () => (send.disabled = !chosen().some((c) => c.length)));
  send.addEventListener('click', () => {
    const picks = chosen();
    if (!picks.some((c) => c.length)) return;
    // Said as what it is: the choices made in the form the answer wrote.
    const text = `My answers to the form:\n\n${fields.map(({ q }, i) => `${q.q}\n${picks[i]!.length ? picks[i]!.join('; ') : '(no answer)'}`).join('\n\n')}`;
    if (!box.dispatchEvent(new CustomEvent(ASK_EVENT, { bubbles: true, cancelable: true, detail: text }))) return;
    for (const el of box.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) el.disabled = true;
    send.textContent = 'Sent';
  });
  box.append(send);
  return box;
}

/**
 * A ```slides block: one card at a time (its title and Markdown), with tabs
 * named after the cards and arrows to step through them.
 *
 *   {"title":"…","slides":[{"title":"…","body":"Markdown"}]}
 */
function slidesBlock(spec: unknown): HTMLElement {
  const s = obj(spec);
  const slides = list(s.slides, 12)
    .map((raw) => {
      const o = obj(typeof raw === 'string' ? { body: raw } : raw);
      return { title: str(o.title, 60), body: typeof o.body === 'string' ? o.body.slice(0, 4000) : '' };
    })
    .filter((x) => x.title || x.body);
  if (!slides.length) throw new Error('no slides');

  const box = figure('slides', str(s.title, 80));
  box.setAttribute('aria-roledescription', 'slides');
  const tabs = h('div', 'jb-tabs');
  tabs.setAttribute('role', 'tablist');
  const stage = h('div', 'jb-slide');
  stage.setAttribute('role', 'tabpanel');
  const nav = h('div', 'jb-slides-nav');
  const prev = h('button', 'jb-step', '‹');
  const count = h('span', 'jb-count');
  const next = h('button', 'jb-step', '›');
  prev.type = next.type = 'button';
  prev.setAttribute('aria-label', 'Previous');
  next.setAttribute('aria-label', 'Next');
  nav.append(prev, count, next);

  let at = 0;
  const buttons = slides.map((slide, k) => {
    const tab = h('button', 'jb-tab', slide.title || String(k + 1));
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => show(k));
    tabs.append(tab);
    return tab;
  });
  const show = (k: number) => {
    at = Math.max(0, Math.min(slides.length - 1, k));
    const slide = slides[at]!;
    stage.replaceChildren(...(slide.title ? [h('h4', 'jb-slide-title', slide.title)] : []), renderMarkdownFragment(slide.body));
    buttons.forEach((b, i) => b.setAttribute('aria-selected', String(i === at)));
    count.textContent = `${at + 1} / ${slides.length}`;
    prev.disabled = at === 0;
    next.disabled = at === slides.length - 1;
  };
  prev.addEventListener('click', () => show(at - 1));
  next.addEventListener('click', () => show(at + 1));
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      show(at + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  });
  if (slides.length > 1) box.append(tabs);
  box.append(stage);
  if (slides.length > 1) box.append(nav);
  show(0);
  return box;
}
