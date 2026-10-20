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

/**
 * WXT_GOOGLE_CLIENT_ID: the app's own Google client (a desktop one, public by
 * design; supabase/README.md, step 3), so Google's sign-in page names the app.
 * Without it, there is no Google sign-in, only email codes.
 */
export const GOOGLE_CLIENT_ID = ((import.meta.env.WXT_GOOGLE_CLIENT_ID as string | undefined) ?? '').trim();

/** The private bucket screenshots go to, as <user id>/<chat id>/<image id>. */
export const SCREENSHOT_BUCKET = 'screenshots';

/**
 * WXT_UNLOCK_KEY: the public half of the key unlock licenses are signed
 * with (worker/scripts/unlock-key.mjs; public by design). Without it, the
 * unlock isn't offered: nothing here could check a license.
 */
export const UNLOCK_KEY = ((import.meta.env.WXT_UNLOCK_KEY as string | undefined) ?? '').trim();
