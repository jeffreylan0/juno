/**
 * Google sign-in for the app, without Supabase's address on Google's page.
 * The app runs Google's sign-in itself (PKCE, back to a one-time listener on
 * the student's own computer: desktop/src-tauri/src/oauth.rs), so Google
 * shows the app's name. The code it gets back is turned into an ID token
 * here, where Google's client secret lives (a desktop app can't keep one);
 * the app then signs in to Supabase with that token (signInWithIdToken).
 *
 * POST /auth/google { code, verifier, redirect_uri } → { id_token }
 *
 * Only a code sent back to this computer is taken (`http://127.0.0.1:<port>`),
 * and nothing but the ID token goes back: no access or refresh token for the
 * student's Google account ever leaves Google. A code is useless without the
 * PKCE verifier the app made, so passing someone else's code gets nothing.
 */
import { readBody } from './body';
import type { Env } from './index';
import { BadRequest } from './models';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const CODE = /^[\w./-]{10,512}$/;
const VERIFIER = /^[\w.~-]{43,128}$/;

export async function googleToken(request: Request, env: Env): Promise<{ id_token: string }> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new BadRequest('Google sign-in is not set up.', 404, 'not-set-up');
  let body: { code?: unknown; verifier?: unknown; redirect_uri?: unknown } = {};
  try {
    body = JSON.parse(await readBody(request, 4096, 'Too large.'));
  } catch {
    // Checked below.
  }
  const { code, verifier, redirect_uri } = body;
  if (typeof code !== 'string' || !CODE.test(code) || typeof verifier !== 'string' || !VERIFIER.test(verifier) || typeof redirect_uri !== 'string' || !LOOPBACK.test(redirect_uri)) {
    throw new BadRequest("Google sign-in didn't finish. Try again.", 400, 'bad-request');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri,
      grant_type: 'authorization_code',
    }),
  });
  const got = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  if (!res.ok || typeof got?.id_token !== 'string') throw new BadRequest("Google sign-in didn't finish. Try again.", 400, 'google');
  return { id_token: got.id_token };
}
