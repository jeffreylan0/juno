/**
 * Signing in, staying signed in, and signing out, against Supabase Auth's
 * REST API directly (no SDK: a few calls, and nothing to bundle).
 *
 *  - Google: the PKCE flow through browser.identity.launchWebAuthFlow. The
 *    browser opens Google in its own window and hands back the redirect, so
 *    the code never passes through a web page we do not own.
 *  - Email: a one-time code (6–10 digits) sent by Supabase, typed back here.
 *
 * The session (access and refresh tokens) is kept in storage.local, like the
 * API keys, sealed (lib/sealed.ts): content scripts can read storage.local,
 * but only the extension's own pages and background can unseal it. It is
 * never put on a web page or in the selection bar.
 *
 * Any extension context can call currentSession(); refreshes are one at a
 * time per context, and Supabase accepts a refresh token reused within ten
 * seconds, so the background and an open settings page refreshing together
 * do not sign the student out.
 */
import { storage } from '#imports';
import { ACCOUNTS, SUPABASE_KEY, SUPABASE_URL } from './config';
import { sealedItem } from '../sealed';

export interface AccountUser {
  id: string;
  email: string;
}

export interface AccountSession {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, in ms. */
  expiresAt: number;
  user: AccountUser;
}

/**
 * What the account gets, as last read from the server (public.account_of:
 * the free plan, what it was given by hand, and what it pays for, together).
 */
export interface Entitlement {
  /** The plan shown: 'free', 'plus', … */
  plan: string;
  planName: string;
  cloud: boolean;
  /** Hosted answers a month (0: none). */
  quota: number;
  /** Hosted answers used this month. */
  used: number;
  /** The paid plan running, or the latest one (to say a payment failed, or it ended). */
  billing: Billing | null;
  /** A Stripe customer: the billing portal (card, invoices) is open to it. */
  customer: boolean;
  /** When this was read, in ms. */
  checkedAt: number;
}

export interface Billing {
  kind: 'subscription' | 'pass';
  /** Stripe's subscription status (active, past_due, canceled, …), or paid / refunded for a pass. */
  status: string;
  /** It gives the plan now. */
  active: boolean;
  /** When the period ends: renews then, or stops if cancelled; a pass runs out then. In ms. */
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

/** Sealed at rest in the extension (lib/sealed.ts), like the API keys. */
export const sessionItem = sealedItem<AccountSession | null>('local:account', null);
export const entitlementItem = storage.defineItem<Entitlement | null>('local:entitlement', { fallback: null });

/** How the cloud copy of the chats is doing (account/sync.ts writes it). */
export type SyncStatus =
  | { state: 'off' }
  | { state: 'not-allowed' }
  | { state: 'syncing' }
  | { state: 'ok'; at: number }
  | { state: 'error'; message: string; at: number };
export const syncStatusItem = storage.defineItem<SyncStatus>('local:syncStatus', { fallback: { state: 'off' } });

export type AccountErrorCode = 'config' | 'network' | 'rate-limit' | 'bad-code' | 'bad-email' | 'cancelled' | 'signed-out' | 'server';

export class AccountError extends Error {
  constructor(
    message: string,
    public code: AccountErrorCode,
    public status?: number,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

function need(): void {
  if (!ACCOUNTS) throw new AccountError('Accounts are not set up in this build.', 'config');
}

/** POST to Supabase Auth with the publishable key; throws an AccountError a person can read. */
async function auth(path: string, body: unknown, bearer?: string): Promise<Record<string, unknown>> {
  need();
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AccountError("Couldn't reach the account service. Check your connection.", 'network');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw authError(path, res.status, data);
  return data;
}

/** Codes Supabase Auth gives for a session that is over. */
const ENDED = new Set(['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'user_not_found', 'user_banned', 'bad_jwt']);

function authError(path: string, status: number, data: Record<string, unknown>): AccountError {
  const code = String(data.error_code ?? data.error ?? '');
  const said = String(data.msg ?? data.error_description ?? data.message ?? '');
  if (status === 429 || code.startsWith('over_')) {
    return new AccountError('Too many tries. Wait a minute, then try again.', 'rate-limit', status);
  }
  if (status >= 500) return new AccountError('The account service had a problem. Try again in a bit.', 'server', status);
  if (path.startsWith('token?grant_type=refresh_token') || ENDED.has(code)) {
    return new AccountError('Signed out. Sign in again.', 'signed-out', status);
  }
  if (path === 'verify') return new AccountError("That code didn't work. Check it, or send a new one.", 'bad-code', status);
  if (code === 'email_address_invalid' || (path === 'otp' && code === 'validation_failed')) {
    return new AccountError("That email address doesn't look right.", 'bad-email', status);
  }
  return new AccountError(said || `Sign-in failed (${status}).`, 'server', status);
}

function toSession(data: Record<string, unknown>): AccountSession {
  const user = data.user as { id?: string; email?: string } | undefined;
  const access = String(data.access_token ?? '');
  const refresh = String(data.refresh_token ?? '');
  if (!access || !refresh || !user?.id) throw new AccountError('Sign-in failed: no session came back.', 'server');
  const expiresAt =
    typeof data.expires_at === 'number' ? data.expires_at * 1000 : Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return { accessToken: access, refreshToken: refresh, expiresAt, user: { id: user.id, email: user.email ?? '' } };
}

async function keep(session: AccountSession): Promise<AccountSession> {
  await sessionItem.setValue(session);
  return session;
}

// ── Google ───────────────────────────────────────────────────────────────

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Where Google sends the browser back to; must be in Supabase's redirect allow-list. */
export function redirectUrl(): string {
  return browser.identity.getRedirectURL();
}

/**
 * Firefox asks before an extension sends anything that identifies a person
 * (the email address, here). Call first thing in the click handler, before
 * any await: Firefox only asks from a user action. Elsewhere it is a yes.
 */
export function askAccountConsent(): Promise<boolean> {
  if (!import.meta.env.FIREFOX) return Promise.resolve(true);
  const perms = browser.permissions as unknown as { request(p: { data_collection: string[] }): Promise<boolean> };
  return perms.request({ data_collection: ['personallyIdentifyingInfo'] }).catch(() => true);
}

export async function signInWithGoogle(): Promise<AccountSession> {
  need();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = `${SUPABASE_URL}/auth/v1/authorize?${new URLSearchParams({
    provider: 'google',
    redirect_to: redirectUrl(),
    code_challenge: challenge,
    code_challenge_method: 's256',
  })}`;
  let back: string | undefined;
  try {
    back = await browser.identity.launchWebAuthFlow({ url, interactive: true });
  } catch {
    throw new AccountError('Google sign-in was closed before it finished.', 'cancelled');
  }
  const returned = new URL(back ?? 'about:blank');
  const params = new URLSearchParams(returned.search);
  for (const [k, v] of new URLSearchParams(returned.hash.slice(1))) if (!params.has(k)) params.set(k, v);
  const code = params.get('code');
  if (!code) {
    // The redirect's own words are not shown: in the app, any web page can
    // open selectionai://auth/callback?error_description=… while a sign-in
    // waits, and would get its text into Settings.
    if (params.get('error')) console.warn('[selection-ai] Google sign-in failed:', params.get('error'));
    throw new AccountError("Google sign-in didn't finish. Try again.", 'server');
  }
  return await keep(toSession(await auth('token?grant_type=pkce', { auth_code: code, code_verifier: verifier })));
}

// ── Email code ───────────────────────────────────────────────────────────

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/** Emails a sign-in code; makes the account if there is none. */
export async function sendEmailCode(email: string): Promise<void> {
  if (!isEmail(email)) throw new AccountError("That email address doesn't look right.", 'bad-email');
  await auth('otp', { email: email.trim(), create_user: true });
}

export async function verifyEmailCode(email: string, code: string): Promise<AccountSession> {
  const token = code.replace(/\D/g, '');
  if (token.length < 6 || token.length > 10) throw new AccountError("That code didn't work. Check it, or send a new one.", 'bad-code');
  return await keep(toSession(await auth('verify', { type: 'email', email: email.trim(), token })));
}

// ── The session ──────────────────────────────────────────────────────────

let refreshing: Promise<AccountSession | null> | null = null;

/**
 * The signed-in session with an access token good for at least a minute
 * (refreshed if not), or null when signed out. `force` refreshes regardless,
 * after the server turned the token down.
 */
export async function currentSession(force = false): Promise<AccountSession | null> {
  if (!ACCOUNTS) return null;
  const s = await sessionItem.getValue();
  if (!s) return null;
  if (!force && s.expiresAt - Date.now() > 60_000) return s;
  refreshing ??= refresh(s, force).finally(() => (refreshing = null));
  return await refreshing;
}

async function refresh(s: AccountSession, force: boolean): Promise<AccountSession | null> {
  // Another page (or the background) may have refreshed it meanwhile.
  const latest = await sessionItem.getValue();
  if (!latest) return null;
  if (latest.refreshToken !== s.refreshToken && (!force || latest.accessToken !== s.accessToken)) return latest;
  try {
    return await keep(toSession(await auth('token?grant_type=refresh_token', { refresh_token: latest.refreshToken })));
  } catch (err) {
    // Over on the server: signed out here too. Offline or a hiccup: keep
    // the session, and try again next time.
    if ((err as AccountError).code === 'signed-out') return await signedOutLocally();
    return latest;
  }
}

async function signedOutLocally(): Promise<null> {
  await sessionItem.setValue(null);
  await entitlementItem.setValue(null);
  return null;
}

/** Signs out here (chats on this computer stay) and ends the session on the server. */
export async function signOut(): Promise<void> {
  // A fresh token first: the server ends the session (and its refresh token)
  // only for a token it still accepts, and the stored one has usually run out.
  const s = await currentSession().catch(() => null);
  await signedOutLocally();
  if (s) await auth('logout?scope=local', {}, s.accessToken).catch(() => {});
}

/**
 * A request to the project (REST or Storage) as the signed-in student. A
 * token the server turns down is refreshed once and the request retried.
 */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  let s = await currentSession();
  if (!s) throw new AccountError('Signed out. Sign in again.', 'signed-out');
  const go = (token: string) =>
    fetch(`${SUPABASE_URL}${path}`, {
      ...init,
      headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
    }).catch(() => {
      throw new AccountError("Couldn't reach the account service. Check your connection.", 'network');
    });
  let res = await go(s.accessToken);
  if (res.status === 401) {
    s = await currentSession(true);
    if (!s) throw new AccountError('Signed out. Sign in again.', 'signed-out');
    res = await go(s.accessToken);
  }
  return res;
}

/** api(), for JSON, throwing on an error status. */
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await api(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
  const text = await res.text();
  if (!res.ok) {
    let said = '';
    try {
      const body = JSON.parse(text) as { message?: string; error?: string };
      said = body.message ?? body.error ?? '';
    } catch {
      said = text.slice(0, 200);
    }
    throw new AccountError(said || `The account service said ${res.status}.`, 'server', res.status);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** public.my_account(), as the database says it. */
interface AccountRow {
  plan: string;
  plan_name: string;
  cloud: boolean;
  quota: number;
  used: number;
  billing: { kind: 'subscription' | 'pass'; status: string; active: boolean; period_end: string | null; cancel_at_period_end: boolean } | null;
  customer: boolean;
}

/** Reads what the account gets (and has used this month), and keeps it. */
export async function refreshEntitlement(): Promise<Entitlement | null> {
  const s = await currentSession();
  if (!s) {
    await entitlementItem.setValue(null);
    return null;
  }
  const a = await apiJson<AccountRow>('/rest/v1/rpc/my_account', { method: 'POST', body: '{}' });
  const b = a.billing;
  const ent: Entitlement = {
    plan: a.plan,
    planName: a.plan_name,
    cloud: !!a.cloud,
    quota: a.quota ?? 0,
    used: a.used ?? 0,
    billing: b
      ? {
          kind: b.kind,
          status: b.status,
          active: !!b.active,
          periodEnd: b.period_end ? Date.parse(b.period_end) : null,
          cancelAtPeriodEnd: !!b.cancel_at_period_end,
        }
      : null,
    customer: !!a.customer,
    checkedAt: Date.now(),
  };
  // Signed out (or in as someone else) while this was in flight: not theirs.
  if ((await sessionItem.getValue())?.user.id !== s.user.id) return null;
  await entitlementItem.setValue(ent);
  return ent;
}
