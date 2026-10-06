/**
 * Hosted answers a month, counted in Supabase (public.usage) with the secret
 * key. The count and the check are one statement (public.use_answer), so two
 * answers at once cannot both take the last one; a failed answer is given
 * back (public.refund_answer).
 */
import type { Env } from './index';
import type { Session } from './auth';

export interface Use {
  ok: boolean;
  used: number;
  quota: number;
  /** The month counted against, to refund into the same one. */
  period: string;
}

function service(env: Env): Record<string, string> {
  // A secret key (sb_secret_…) goes in apikey alone; a legacy service_role
  // JWT is also a bearer token.
  const key = env.SUPABASE_SECRET_KEY;
  return { apikey: key, 'content-type': 'application/json', ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}) };
}

async function rpc<T>(env: Env, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: service(env), body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`${fn} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** Takes one answer from this month's allowance, if any is left. */
export async function useAnswer(session: Session, env: Env): Promise<Use> {
  return await rpc<Use>(env, 'use_answer', { p_user: session.userId });
}

export async function refundAnswer(session: Session, period: string, env: Env): Promise<void> {
  await rpc(env, 'refund_answer', { p_user: session.userId, p_period: period }).catch(() => {});
}

export interface Me {
  plan: string | null;
  cloud: boolean;
  quota: number;
  used: number;
}

/** The plan and this month's count, for the extension's status check. */
export async function me(session: Session, env: Env): Promise<Me> {
  const period = new Date().toISOString().slice(0, 7) + '-01';
  const [ent, usage] = await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/entitlements?user_id=eq.${session.userId}&select=cloud,plan,monthly_questions`, { headers: service(env) }),
    fetch(`${env.SUPABASE_URL}/rest/v1/usage?user_id=eq.${session.userId}&period=eq.${period}&select=used`, { headers: service(env) }),
  ]);
  const row = ent.ok ? ((await ent.json()) as { cloud: boolean; plan: string | null; monthly_questions: number | null }[])[0] : undefined;
  const used = usage.ok ? (((await usage.json()) as { used: number }[])[0]?.used ?? 0) : 0;
  const quota = row?.monthly_questions ?? (row?.plan === 'student' ? 600 : row?.plan === 'unlimited' ? 100_000 : 0);
  return { plan: row?.plan ?? null, cloud: !!row?.cloud, quota, used };
}
