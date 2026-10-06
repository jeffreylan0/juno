/**
 * Where accounts live: a Supabase project, set at build time.
 *
 *   WXT_SUPABASE_URL  https://<project>.supabase.co
 *   WXT_SUPABASE_KEY  the project's publishable key (sb_publishable_…, or the
 *                     legacy anon key). Public by design: row level security
 *                     (supabase/migrations) is what protects the data.
 *
 * Without both, the build has no accounts at all: no Account section, no
 * sign-in, nothing sent anywhere but the AI the student picked.
 */
export const SUPABASE_URL = ((import.meta.env.WXT_SUPABASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
export const SUPABASE_KEY = ((import.meta.env.WXT_SUPABASE_KEY as string | undefined) ?? '').trim();
export const ACCOUNTS = !!(SUPABASE_URL && SUPABASE_KEY);

/** The private bucket screenshots go to, as <user id>/<chat id>/<image id>. */
export const SCREENSHOT_BUCKET = 'screenshots';

/** Questions a month on hosted answers, by plan; mirrors public.monthly_quota(). */
export function monthlyQuota(plan: string | null, override: number | null): number {
  if (typeof override === 'number') return override;
  return plan === 'student' ? 600 : plan === 'unlimited' ? 100_000 : 0;
}

/** The first day of this month (UTC), as the usage table keys it. */
export function usagePeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
