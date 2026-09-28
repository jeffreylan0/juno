/** Verifies the Supabase session token on every request (week 9). */
import type { Env } from './index';

export interface Session {
  userId: string;
  email: string;
}

export async function verifySession(request: Request, env: Env): Promise<Session | null> {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || !env.SUPABASE_URL) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: env.SUPABASE_SERVICE_KEY },
  });
  if (!res.ok) return null;
  const user = (await res.json()) as { id: string; email: string };
  return { userId: user.id, email: user.email };
}
