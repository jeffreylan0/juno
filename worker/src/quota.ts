/**
 * Hosted answers a month, counted in Supabase (public.usage). The count and
 * the check are one statement (public.use_answer), so two answers at once
 * cannot both take the last one; a failed answer is given back
 * (public.refund_answer).
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

/** Takes one answer from this month's allowance, if any is left. */
export async function useAnswer(session: Session, env: Env): Promise<Use> {
  return await rpc<Use>(env, 'use_answer', { p_user: session.userId });
}

export async function refundAnswer(session: Session, period: string, env: Env): Promise<void> {
  await rpc(env, 'refund_answer', { p_user: session.userId, p_period: period }).catch(() => {});
}
