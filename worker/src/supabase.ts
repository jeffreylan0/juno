/**
 * The Supabase project, as the Worker sees it: with the secret key, which
 * bypasses row level security, so only ever for the account a verified
 * session (auth.ts) or a signed Stripe event (billing.ts) names.
 */
import type { Env } from './index';

function headers(env: Env): Record<string, string> {
  // A secret key (sb_secret_…) goes in apikey alone; a legacy service_role
  // JWT is also a bearer token.
  const key = env.SUPABASE_SECRET_KEY;
  return { apikey: key, 'content-type': 'application/json', ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}) };
}

/** A REST call (PostgREST: /rest/v1/…), throwing on an error status. */
export async function rest(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers(env), ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0]} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** A database function (public.<fn>). */
export async function rpc<T>(env: Env, fn: string, args: Record<string, unknown>): Promise<T> {
  return (await (await rest(env, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })).json()) as T;
}

/** Inserts or updates rows by their key (`on` names it). */
export async function upsert(env: Env, table: string, on: string, rows: Record<string, unknown> | Record<string, unknown>[]): Promise<void> {
  await rest(env, `${table}?on_conflict=${on}`, {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
}

/** What an account gets, all together (public.account_of): plan, cloud storage, hosted answers, billing. */
export interface Account {
  plan: string;
  plan_name: string;
  cloud: boolean;
  quota: number;
  used: number;
  period: string;
  billing: {
    kind: 'subscription' | 'pass';
    status: string;
    plan: string;
    active: boolean;
    period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
  customer: boolean;
}

export const accountOf = (env: Env, userId: string) => rpc<Account>(env, 'account_of', { p_user: userId });
