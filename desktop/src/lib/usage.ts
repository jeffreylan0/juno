/**
 * This month's answers, for the top of settings: how many, and about what
 * they cost on the student's own API keys (each answer's estimate, router.ts
 * prices). Only the two numbers, on this computer: no question, no answer,
 * no chat. A new month starts from zero.
 */
import { defineItem } from './storage';

export interface MonthUsage {
  /** "2026-10". */
  month: string;
  answers: number;
  /** Estimated spend on the student's own keys, in dollars. */
  costUsd: number;
}

export const usageItem = defineItem<MonthUsage | null>('usage', null);

export const monthOf = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;

/** This month's numbers (zero if none yet this month). */
export function thisMonth(stored: MonthUsage | null, now = new Date()): MonthUsage {
  const month = monthOf(now);
  return stored?.month === month ? stored : { month, answers: 0, costUsd: 0 };
}

/** One more answer; `costUsd` is what it cost on the student's key, if it was theirs. */
export async function countAnswer(costUsd = 0, now = new Date()): Promise<void> {
  const before = thisMonth(await usageItem.getValue(), now);
  await usageItem.setValue({ ...before, answers: before.answers + 1, costUsd: before.costUsd + Math.max(0, costUsd) });
}
