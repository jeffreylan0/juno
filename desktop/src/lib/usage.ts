/**
 * This month's answers, for the top of settings when there is no plan to
 * count them: how many, on this computer. Only the number: no question, no
 * answer, no chat. A new month starts from zero.
 */
import { defineItem } from './storage';

export interface MonthUsage {
  /** "2026-10". */
  month: string;
  answers: number;
}

export const usageItem = defineItem<MonthUsage | null>('usage', null);

export const monthOf = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;

/** This month's numbers (zero if none yet this month). */
export function thisMonth(stored: MonthUsage | null, now = new Date()): MonthUsage {
  const month = monthOf(now);
  return stored?.month === month ? { month, answers: stored.answers } : { month, answers: 0 };
}

/** One more answer. */
export async function countAnswer(now = new Date()): Promise<void> {
  const before = thisMonth(await usageItem.getValue(), now);
  await usageItem.setValue({ ...before, answers: before.answers + 1 });
}
