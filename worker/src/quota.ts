/** Per-user monthly question count in a Supabase table; refuses past the plan limit. */
import type { Env } from './index';
import type { Session } from './auth';

export const PLAN_LIMITS: Record<string, number> = { free: 20, student: 600, unlimited: Number.POSITIVE_INFINITY };

export interface QuotaState {
  plan: string;
  used: number;
  limit: number;
  periodStart: string;
}

function periodStart(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export async function quotaFor(session: Session, env: Env): Promise<QuotaState> {
  const row = await select(env, session.userId);
  const plan = row?.plan ?? 'free';
  return { plan, used: row?.used ?? 0, limit: PLAN_LIMITS[plan] ?? PLAN_LIMITS.free!, periodStart: periodStart() };
}

export async function checkAndCount(session: Session, env: Env): Promise<{ ok: true } | { ok: false; reason: string }> {
  const state = await quotaFor(session, env);
  if (state.used >= state.limit) {
    return { ok: false, reason: `You have used all ${state.limit} questions on the ${state.plan} plan this month.` };
  }
  await increment(env, session.userId, state.periodStart);
  return { ok: true };
}

interface UsageRow {
  plan: string;
  used: number;
}

async function select(env: Env, userId: string): Promise<UsageRow | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}&period_start=eq.${periodStart()}&select=plan,used`,
    { headers: headers(env) },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as UsageRow[];
  return rows[0] ?? null;
}

async function increment(env: Env, userId: string, period: string): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/increment_usage`, {
    method: 'POST',
    headers: { ...headers(env), 'content-type': 'application/json' },
    body: JSON.stringify({ p_user_id: userId, p_period_start: period }),
  });
}

function headers(env: Env): Record<string, string> {
  return { apikey: env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
}
