/**
 * Who is asking: the Supabase access token the extension sends as a bearer
 * token, checked on every request.
 *
 * Projects on asymmetric signing keys (the default for new ones) publish
 * their public keys at /auth/v1/.well-known/jwks.json, so the token is
 * verified here with no call to Supabase beyond fetching those keys now and
 * then. A project still on the legacy shared secret publishes none; then
 * Supabase Auth is asked about the token itself.
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
let cached: { url: string; at: number; keys: Jwk[] } | null = null;

async function signingKeys(env: Env, fresh = false): Promise<Jwk[]> {
  if (!fresh && cached && cached.url === env.SUPABASE_URL && Date.now() - cached.at < KEYS_TTL_MS) return cached.keys;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
  const keys = res.ok ? (((await res.json()) as { keys?: Jwk[] }).keys ?? []) : [];
  cached = { url: env.SUPABASE_URL, at: Date.now(), keys };
  return keys;
}

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
  iss?: string;
  aud?: string | string[];
  role?: string;
}

export async function verifySession(request: Request, env: Env): Promise<Session | null> {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
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

  const alg = header.alg ? ALGS[header.alg] : undefined;
  if (!alg) return await askSupabase(token, env); // the legacy shared secret (HS256)

  let jwk = (await signingKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await signingKeys(env, true)).find((k) => k.kid === header.kid); // keys rotated
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, alg.import, false, ['verify']);
    const ok = await crypto.subtle.verify(alg.verify, key, decode(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const claims = json<Claims>(p);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!claims.sub || !claims.exp || claims.exp * 1000 < Date.now()) return null;
    if (claims.iss !== `${env.SUPABASE_URL}/auth/v1` || !aud.includes('authenticated') || claims.role !== 'authenticated') return null;
    return { userId: claims.sub, email: claims.email ?? '' };
  } catch {
    return null;
  }
}

async function askSupabase(token: string, env: Env): Promise<Session | null> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_SECRET_KEY, authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = (await res.json()) as { id?: string; email?: string };
  return user.id ? { userId: user.id, email: user.email ?? '' } : null;
}
