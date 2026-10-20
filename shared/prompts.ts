import type { Attachment, Mode, Part, Plan } from './payload';

/**
 * Mode system prompts plus the "What I read" instruction.
 * Kept short so the prompt prefix caches well across requests.
 */

export const WHAT_I_READ_INSTRUCTION =
  'Whenever a message brings a new selection, start your reply with exactly one line beginning "Read:" that restates, in at most 25 words, ' +
  'what you received (the problem, expression, table or figure; with several selections, all of them briefly). Then a blank line, then your answer. ' +
  'If part of the input is unreadable, say so in that line instead of guessing. ' +
  'When a message brings no new selection, answer directly without the "Read:" line. ' +
  'A conversation can collect selections from several pages; refer to them as "the first selection", "the table" and so on.';

export const FORMAT_INSTRUCTION =
  'Write Markdown. Use $...$ for inline math and $$...$$ for display math (KaTeX). ' +
  'Write chemistry with \\ce{...} (mhchem). Keep units explicit. Do not use HTML.';

const BASE =
  'You are a patient tutor for a college or high-school student. The student selected part of a web page ' +
  'and is asking about exactly that content, nothing else on the page. Be accurate; prefer showing work to asserting results.';

export const MODE_PROMPTS: Record<Mode, string> = {
  ask:
    `${BASE} Do what the student asks, the way they ask it. If they want a hint, give a hint that unblocks the next step ` +
    'and do NOT give the final answer. If they want their work checked, check it, point to the first mistake precisely, ' +
    'and let them fix it. Otherwise explain the solution step by step and, for a problem, state the final answer on its own line ' +
    'as "Answer: ...". Keep the reply as short as the request allows. A screenshot may contain equations, tables, diagrams or ' +
    'handwriting: read it carefully, and say so if something is illegible rather than guessing.',
  explain:
    `${BASE} Explain the selected content fully: define the terms, work through the solution step by step, ` +
    'and end with a one-sentence takeaway. If it is a problem, solve it completely and state the final answer clearly on its own line as "Answer: ...".',
  hint:
    `${BASE} Do NOT give the final answer or complete the solution. Give one or two hints that unblock the next step, ` +
    'name the concept or formula involved, and ask a guiding question. If the student asks again, give a slightly stronger hint.',
  check:
    `${BASE} The student is showing you their own work or answer. Check it carefully. Say whether it is correct, ` +
    'locate the first error precisely if any, explain why it is an error, and let the student fix it themselves unless they ask for the full solution. ' +
    'End with a verdict line: "Verdict: correct" or "Verdict: incorrect".',
};

export function systemPrompt(mode: Mode): string {
  return `${MODE_PROMPTS[mode]}\n\n${FORMAT_INSTRUCTION}\n\n${WHAT_I_READ_INSTRUCTION}`;
}

/** Text-form rendering of a non-image part for the user turn. */
export function partToText(p: Part, index: number): string {
  const label = `[Part ${index + 1}: ${p.kind}]`;
  switch (p.kind) {
    case 'text':
      return `${label}\n${p.text}`;
    case 'latex':
      return `${label}\n${p.display ? `$$${p.latex}$$` : `$${p.latex}$`}`;
    case 'table':
      return `${label}\n${p.markdown}`;
    case 'code':
      return `${label}\n\`\`\`${p.language ?? ''}\n${p.code}\n\`\`\``;
    case 'image':
      return p.reason === 'user'
        ? `${label} (attached screenshot of the area the student selected, ${p.width}x${p.height})`
        : `${label} (attached image, ${p.width}x${p.height}, reason: ${p.reason})`;
  }
}

/**
 * The question asked per mode when none is typed: the eval's fixed modes, and
 * what settings saved before macros existed are migrated from (storage.ts).
 */
export const DEFAULT_PROMPTS: Record<Mode, string> = {
  ask: 'Explain this step by step.',
  explain: 'Explain this step by step, then give the final answer.',
  hint: 'Give me one hint for the next step. Do not give away the answer.',
  check: 'Here is my work. Check it and tell me where the first mistake is.',
};

/**
 * An answer macro: a button above the question box. Clicking one fills the
 * box with its prompt and sends it. The student names and writes their own in
 * settings; these are the shipped starting set.
 */
export interface Macro {
  id: string;
  name: string;
  prompt: string;
}

/**
 * What sits in the question box when a selection lands: nothing. The macros
 * do the asking; a student who wants a standing prompt can set one.
 */
export const DEFAULT_PROMPT = '';

export const DEFAULT_MACROS: Macro[] = [
  { id: 'explain', name: 'Explain', prompt: 'Explain this step by step.' },
  { id: 'hint', name: 'Hint', prompt: 'Give me a hint for the next step, not the answer.' },
  { id: 'check', name: 'Check', prompt: 'Check my work and point to the first mistake.' },
  { id: 'answer', name: 'Answer', prompt: 'Provide the answer first and the explanation after.' },
];

/** Default question when the student just selects and asks with an empty box. */
export function defaultQuestion(mode: Mode): string {
  return DEFAULT_PROMPTS[mode];
}

/**
 * The opening user turn of a conversation: the selection plus the student's
 * first question. Images are attached separately by the provider. The
 * selection is sent once, here, and never repeated on follow-ups.
 */
export function selectionPrompt(plan: Plan, question: string | undefined): string {
  return attachmentsPrompt([{ kind: plan.selection.kind, page: plan.page, parts: plan.parts }], question, plan.mode);
}

const KIND_WORD: Record<Attachment['kind'], string> = { box: 'box', freeform: 'freeform shape' };
/** A chat saved by an earlier version may hold other kinds ('text', 'element'). */
const kindWord = (kind: string) => KIND_WORD[kind as Attachment['kind']] ?? 'selection';

/**
 * The text of a user turn that brings selections. One selection reads as it
 * always has; several are numbered, each with the page it came from. Parts
 * are numbered across the whole message, in the order the images follow.
 */
export function attachmentsPrompt(attachments: Attachment[], question: string | undefined, mode: Mode): string {
  const q = question?.trim() || defaultQuestion(mode);
  if (attachments.length === 1) {
    const [a] = attachments as [Attachment];
    const parts = a.parts.map(partToText).join('\n\n');
    const page = a.page.title ? `Page: ${a.page.title}\n` : '';
    return `${page}Selected content:\n\n${parts}\n\nQuestion: ${q}`;
  }
  let n = 0;
  const blocks = attachments.map((a, i) => {
    const from = a.page.title ? ` from "${a.page.title}"` : '';
    const parts = a.parts.map((p) => partToText(p, n++)).join('\n\n');
    return `Selection ${i + 1} (${kindWord(a.kind)})${from}:\n${parts}`;
  });
  return `The student selected ${attachments.length} things:\n\n${blocks.join('\n\n')}\n\nQuestion: ${q}`;
}

/** The opening turn when there is no history yet: the plan carries the question. */
export function userPromptText(plan: Plan): string {
  return selectionPrompt(plan, plan.question);
}

/** Splits the "Read:" line from an answer. Returns null for read if absent. */
export function splitWhatIRead(answer: string): { read: string | null; body: string } {
  const m = /^\s*Read:\s*(.*)\n?/i.exec(answer);
  if (!m) return { read: null, body: answer };
  return { read: (m[1] ?? '').trim(), body: answer.slice(m[0].length).replace(/^\s*\n/, '') };
}
