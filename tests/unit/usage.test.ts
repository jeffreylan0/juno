import { describe, expect, it } from 'vitest';
import { countAnswer, monthOf, thisMonth, usageItem } from '@/lib/usage';

describe('this month’s answers', () => {
  it('count answers, and start again each month', async () => {
    const oct = new Date(2026, 9, 18);
    expect(thisMonth(null, oct)).toEqual({ month: '2026-10', answers: 0 });
    await countAnswer(oct);
    await countAnswer(oct);
    const stored = await usageItem.getValue();
    expect(stored).toEqual({ month: '2026-10', answers: 2 });
    // November: a new month, from zero.
    const nov = new Date(2026, 10, 1);
    expect(thisMonth(stored, nov)).toEqual({ month: monthOf(nov), answers: 0 });
    await countAnswer(nov);
    expect(await usageItem.getValue()).toEqual({ month: '2026-11', answers: 1 });
    // A stored month from a build that also kept spend reads as the answers alone.
    expect(thisMonth({ month: '2026-11', answers: 4, costUsd: 0.3 } as never, nov)).toEqual({ month: '2026-11', answers: 4 });
  });
});
