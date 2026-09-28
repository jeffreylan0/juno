import { describe, expect, it } from 'vitest';
import { extractAnswer, isCorrect, numbersIn } from '../../eval/score';
import type { Problem } from '../../eval/lib';

const problem: Problem = {
  id: 'p',
  subject: 'calculus',
  page: '',
  selector: '',
  question: '',
  answer: { numeric: 1 / 3, tolerance: 0.001, accept: ['1/3', '\\frac{1}{3}'] },
};

describe('scorer', () => {
  it('extracts the Answer: line, else the last line', () => {
    expect(extractAnswer('Read: x\n\nwork...\n\n**Answer:** $\\frac{1}{3}$')).toBe('$\\frac{1}{3}$');
    expect(extractAnswer('so it is 0.333\n')).toBe('so it is 0.333');
  });

  it('parses decimals, fractions and \\frac', () => {
    expect(numbersIn('1/3 and 0.5 and \\frac{2}{4} and -7e-2')).toEqual([1 / 3, 0.5, 0.5, -0.07]);
  });

  it('grades by accept strings or numeric tolerance on the answer line only', () => {
    expect(isCorrect(problem, 'Answer: $\\tfrac{1}{3}$').correct).toBe(true);
    expect(isCorrect(problem, 'Answer: 0.3333').correct).toBe(true);
    expect(isCorrect(problem, 'Answer: 0.5').correct).toBe(false);
    // An example elsewhere in the text must not count.
    expect(isCorrect(problem, 'Note $\\frac{1}{3}$ is a fraction.\n\nAnswer: 42').correct).toBe(false);
  });
});
