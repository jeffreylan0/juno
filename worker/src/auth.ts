/**
 * Who is asking: the Supabase access token the extension sends as a bearer
 * token, checked on every request.
 *
 * Projects on asymmetric signing keys (the default for new ones) publish
 * their public keys at /auth/v1/.well-known/jwks.json, so the token is
 * verified here with no call to Supabase beyond fetching those keys now and
 * then. A project still on the legacy shared secret publishes none; then
 * Supabase Auth is asked about the token itself. Anything else (no key id
 * the project knows, another algorithm, a claim out of place) is refused
 * without a call.
 */
import type { Env } from './index';

export interface Session {
  userId: string;
  email: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
}

const KEYS_TTL_MS = 10 * 60_000;
/** An unknown key id refetches the keys at most this often, so junk tokens can't make every request a fetch. */
const REFRESH_MIN_MS = 60_000;
const TIMEOUT_MS = 5000;
let cached: { url: string; at: number; keys: Jwk[] } | null = null;

async function signingKeys(env: Env, fresh = false): Promise<Jwk[]> {
  const now = Date.now();
  const mine = cached?.url === env.SUPABASE_URL ? cached : null;
  if (mine && now - mine.at < (fresh ? REFRESH_MIN_MS : KEYS_TTL_MS)) return mine.keys;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) {
      const keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
      cached = { url: env.SUPABASE_URL, at: now, keys };
      return keys;
    }
  } catch {
    // Unreachable: keep the keys already known.
  }
  if (mine) mine.at = now;
  return mine?.keys ?? [];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bearer = (request: Request) => request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];

const decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const json = <T>(s: string) => JSON.parse(new TextDecoder().decode(decode(s))) as T;

const ALGS: Record<string, { import: EcKeyImportParams | RsaHashedImportParams; verify: EcdsaParams | AlgorithmIdentifier }> = {
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
};

interface Claims {
  sub?: string;
  email?: string;
  exp?: number;
  nbf?: number;
  iss?: string;
  aud?: string | string[];
  role?: string;
}

export async function verifySession(request: Request, env: Env): Promise<Session | null> {
  const token = bearer(request);
  if (!token || !env.SUPABASE_URL) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  try {
    header = json(h);
  } catch {
    return null;
  }

  // The legacy shared secret: only a project that publishes no keys still
  // signs with it, and only then is Supabase Auth asked about the token.
  if (header.alg === 'HS256') return (await signingKeys(env)).length ? null : await askSupabase(token, env);
  const alg = header.alg ? ALGS[header.alg] : undefined;
  if (!alg) return null;

  let jwk = (await signingKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await signingKeys(env, true)).find((k) => k.kid === header.kid); // keys rotated
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, alg.import, false, ['verify']);
    const ok = await crypto.subtle.verify(alg.verify, key, decode(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const claims = json<Claims>(p);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!claims.sub || !UUID.test(claims.sub) || !claims.exp || claims.exp * 1000 < Date.now()) return null;
    if (claims.nbf && claims.nbf * 1000 > Date.now() + 60_000) return null;
    if (claims.iss !== `${env.SUPABASE_URL}/auth/v1` || !aud.includes('authenticated') || claims.role !== 'authenticated') return null;
    return { userId: claims.sub, email: claims.email ?? '' };
  } catch {
    return null;
  }
}

/**
 * For billing, which can't be undone: the session must still be live at
 * Supabase (not signed out, the account not deleted), not merely unexpired.
 */
export async function stillSignedIn(request: Request, session: Session, env: Env): Promise<boolean> {
  const token = bearer(request);
  return !!token && (await askSupabase(token, env))?.userId === session.userId;
}

async function askSupabase(token: string, env: Env): Promise<Session | null> {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_SECRET_KEY, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const user = (await res.json()) as { id?: string; email?: string };
    return user.id && UUID.test(user.id) ? { userId: user.id, email: user.email ?? '' } : null;
  } catch {
    return null;
  }
}
