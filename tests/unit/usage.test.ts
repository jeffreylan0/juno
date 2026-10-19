import { describe, expect, it } from 'vitest';
import { countAnswer, monthOf, thisMonth, usageItem } from '@/lib/usage';

describe('this month’s answers', () => {
  it('count answers and what they cost on a key, and start again each month', async () => {
    const oct = new Date(2026, 9, 18);
    expect(thisMonth(null, oct)).toEqual({ month: '2026-10', answers: 0, costUsd: 0 });
    await countAnswer(0.004, oct);
    await countAnswer(0, oct);
    await countAnswer(undefined, oct);
    const stored = await usageItem.getValue();
    expect(stored).toMatchObject({ month: '2026-10', answers: 3 });
    expect(stored!.costUsd).toBeCloseTo(0.004);
    // November: a new month, from zero.
    const nov = new Date(2026, 10, 1);
    expect(thisMonth(stored, nov)).toEqual({ month: monthOf(nov), answers: 0, costUsd: 0 });
    await countAnswer(0.01, nov);
    expect(await usageItem.getValue()).toEqual({ month: '2026-11', answers: 1, costUsd: 0.01 });
  });
});
