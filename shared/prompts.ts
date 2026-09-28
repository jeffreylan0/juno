import type { Mode, Part, Plan } from './payload';

/**
 * Mode system prompts plus the "What I read" instruction.
 * Kept short so the prompt prefix caches well across requests.
 */

export const WHAT_I_READ_INSTRUCTION =
  'Start your reply with exactly one line beginning "Read:" that restates, in at most 25 words, ' +
  'what you received (the problem, expression, table or figure). Then a blank line, then your answer. ' +
  'If part of the input is unreadable, say so in that line instead of guessing.';

export const FORMAT_INSTRUCTION =
  'Write Markdown. Use $...$ for inline math and $$...$$ for display math (KaTeX). ' +
  'Write chemistry with \\ce{...} (mhchem). Keep units explicit. Do not use HTML.';

const BASE =
  'You are a patient tutor for a college or high-school student. The student selected part of a web page ' +
  'and is asking about exactly that content, nothing else on the page. Be accurate; prefer showing work to asserting results.';

export const MODE_PROMPTS: Record<Mode, string> = {
  explain:
    `${BASE} Explain the selected content fully: define the terms, work through the reasoning step by step, ` +
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
      return `${label} (attached image, ${p.width}x${p.height}, reason: ${p.reason})`;
  }
}

/** Default question when the student just selects and hits Ask. */
export function defaultQuestion(mode: Mode): string {
  switch (mode) {
    case 'explain':
      return 'Explain this.';
    case 'hint':
      return 'Give me a hint for this.';
    case 'check':
      return 'Check my work.';
  }
}

/** Builds the user-turn text (images are attached separately by the provider). */
export function userPromptText(plan: Plan): string {
  const parts = plan.parts.map(partToText).join('\n\n');
  const q = plan.question?.trim() || defaultQuestion(plan.mode);
  const page = plan.page.title ? `Page: ${plan.page.title}\n` : '';
  return `${page}Selected content:\n\n${parts}\n\nQuestion: ${q}`;
}

/** Splits the "Read:" line from an answer. Returns null for read if absent. */
export function splitWhatIRead(answer: string): { read: string | null; body: string } {
  const m = /^\s*Read:\s*(.*)\n?/i.exec(answer);
  if (!m) return { read: null, body: answer };
  return { read: (m[1] ?? '').trim(), body: answer.slice(m[0].length).replace(/^\s*\n/, '') };
}
