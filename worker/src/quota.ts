/**
 * Hosted answers a month, counted in Supabase (public.usage), in answers from
 * the fast models: a bigger model's answer takes more (ANSWER_COST). The
 * count and the check are one statement (public.use_answer), so two answers
 * at once cannot both take the last of it; a failed answer is given back
 * (public.refund_answer). Web searches are taken with their answer, and those
 * not made given back (index.ts).
 */
import type { Env } from './index';
import type { Session } from './auth';
import { rpc } from './supabase';

export interface Use {
  ok: boolean;
  used: number;
  quota: number;
  /** The month counted against, to refund into the same one. */
  period: string;
}

/** Takes `cost` from this month's allowance, if that much is left. */
export async function useAnswer(session: Session, cost: number, env: Env): Promise<Use> {
  return await rpc<Use>(env, 'use_answer', { p_user: session.userId, p_cost: cost });
}

export async function refundAnswer(session: Session, period: string, cost: number, env: Env): Promise<void> {
  await rpc(env, 'refund_answer', { p_user: session.userId, p_period: period, p_cost: cost }).catch(() => {});
}
