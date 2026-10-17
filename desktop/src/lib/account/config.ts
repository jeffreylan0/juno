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
