/**
 * An in-memory stand-in for the parts of Supabase the extension uses: email
 * codes, sessions and refreshes (Auth), the entitlements/usage/chats tables
 * and their functions (supabase/migrations, with the same rules: last write
 * wins, cloud storage needed to save, own rows only), and the screenshots
 * bucket (Storage). Unit tests put it behind fetch; E2E tests behind a
 * Playwright route. It speaks Request → Response, nothing else.
 */
export interface FakeUser {
  id: string;
  email: string;
}

interface Row {
  user_id: string;
  id: string;
  updated_ms: number;
  deleted: boolean;
  data: unknown;
  /** Microseconds since 1970, for ordering. */
  synced: number;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-upsert, cache-control, x-client-info, prefer',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

export class FakeSupabase {
  readonly url: string;
  readonly key: string;
  users = new Map<string, FakeUser>();
  codes = new Map<string, string>();
  access = new Map<string, { user: string; expires: number }>();
  refresh = new Map<string, string>();
  entitlements = new Map<string, { cloud: boolean; plan: string | null; monthly_questions: number | null }>();
  chats: Row[] = [];
  objects = new Map<string, { type: string; bytes: Uint8Array }>();
  /** Google sign-ins in flight: the code handed back, and the challenge it was asked with. */
  pkce = new Map<string, { challenge: string; email: string }>();
  /** Every request, for assertions: "METHOD path". */
  log: string[] = [];
  private n = 0;
  private clock = Date.UTC(2026, 9, 6, 12) * 1000;

  constructor(url = 'https://e2e-project.supabase.co', key = 'sb_publishable_e2e') {
    this.url = url;
    this.key = key;
  }

  // ── For tests ──────────────────────────────────────────────────────────

  userByEmail(email: string): FakeUser | undefined {
    return [...this.users.values()].find((u) => u.email === email.toLowerCase());
  }

  /** What set_entitlement() does. */
  entitle(email: string, e: { cloud?: boolean; plan?: string | null; monthly_questions?: number | null }): void {
    const user = this.userByEmail(email) ?? this.addUser(email);
    this.entitlements.set(user.id, { cloud: e.cloud ?? true, plan: e.plan ?? null, monthly_questions: e.monthly_questions ?? null });
  }

  addUser(email: string): FakeUser {
    const user = { id: `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`, email: email.toLowerCase() };
    this.users.set(user.id, user);
    return user;
  }

  /** Another computer saving a chat. */
  put(userId: string, id: string, updated_ms: number, data: unknown, deleted = false): void {
    this.chats = this.chats.filter((r) => !(r.user_id === userId && r.id === id));
    this.chats.push({ user_id: userId, id, updated_ms, deleted, data: deleted ? null : data, synced: this.tick() });
  }

  row(userId: string, id: string): Row | undefined {
    return this.chats.find((r) => r.user_id === userId && r.id === id);
  }

  /** Every access token stops working, as if an hour passed. */
  expireAccessTokens(): void {
    for (const t of this.access.values()) t.expires = 0;
  }

  private tick(): number {
    this.clock += 1000 + Math.floor(Math.random() * 999);
    return this.clock;
  }

  // ── The server ─────────────────────────────────────────────────────────

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    this.log.push(`${req.method} ${url.pathname}`);
    if (req.headers.get('apikey') !== this.key) return this.json(401, { message: 'Invalid API key' });
    const path = url.pathname;
    try {
      if (path.startsWith('/auth/v1/')) return await this.auth(req, url, path.slice(9));
      const user = this.bearer(req);
      if (!user) return this.json(401, { code: 'PGRST301', message: 'JWT expired' });
      if (path.startsWith('/rest/v1/')) return await this.rest(req, url, path.slice(9), user);
      if (path.startsWith('/storage/v1/object/')) return await this.storage(req, path.slice(19), user);
      return this.json(404, { message: 'no route' });
    } catch (err) {
      return this.json(500, { message: String(err) });
    }
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { ...CORS, 'content-type': 'application/json', ...headers },
    });
  }

  private bearer(req: Request): FakeUser | null {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const a = this.access.get(token);
    if (!a || a.expires < Date.now()) return null;
    return this.users.get(a.user) ?? null;
  }

  private session(user: FakeUser) {
    const n = ++this.n;
    const access = `at-${n}`;
    const refresh = `rt-${n}`;
    this.access.set(access, { user: user.id, expires: Date.now() + 3600_000 });
    this.refresh.set(refresh, user.id);
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refresh,
      user: { id: user.id, email: user.email },
    };
  }

  private async auth(req: Request, url: URL, path: string): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    if (path === 'otp') {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email ?? '')) return this.json(400, { error_code: 'email_address_invalid', msg: 'Invalid email' });
      const email = body.email!.toLowerCase();
      if (!this.userByEmail(email)) this.addUser(email);
      this.codes.set(email, String(100000 + Math.floor(Math.random() * 900000)));
      return this.json(200, {});
    }
    if (path === 'verify') {
      const email = (body.email ?? '').toLowerCase();
      if (!body.token || this.codes.get(email) !== body.token) {
        return this.json(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      }
      this.codes.delete(email);
      return this.json(200, this.session(this.userByEmail(email)!));
    }
    if (path === 'token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const user = this.refresh.get(body.refresh_token ?? '');
      if (!user || !this.users.has(user)) return this.json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      this.refresh.delete(body.refresh_token!);
      return this.json(200, this.session(this.users.get(user)!));
    }
    if (path === 'token' && url.searchParams.get('grant_type') === 'pkce') {
      const flow = this.pkce.get(body.auth_code ?? '');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier ?? '')));
      const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (!flow || flow.challenge !== challenge) return this.json(400, { code: 400, error_code: 'flow_state_not_found', msg: 'invalid flow state' });
      this.pkce.delete(body.auth_code!);
      return this.json(200, this.session(this.userByEmail(flow.email) ?? this.addUser(flow.email)));
    }
    if (path === 'logout') return new Response(null, { status: 204, headers: CORS });
    return this.json(404, { msg: 'no route' });
  }

  private async rest(req: Request, url: URL, path: string, user: FakeUser): Promise<Response> {
    const q = url.searchParams;
    if (path === 'entitlements' && req.method === 'GET') {
      const e = this.entitlements.get(user.id);
      return this.json(200, e ? [e] : []);
    }
    if (path === 'usage' && req.method === 'GET') return this.json(200, []);
    if (path === 'chats' && req.method === 'GET') {
      let rows = this.chats.filter((r) => r.user_id === user.id).sort((a, b) => a.synced - b.synced || (a.id < b.id ? -1 : 1));
      const or = q.get('or');
      if (or) {
        const m = /^\(synced_at\.gt\."([^"]+)",and\(synced_at\.eq\."([^"]+)",id\.gt\."([^"]*)"\)\)$/.exec(or);
        if (!m) return this.json(400, { message: `bad or: ${or}` });
        const at = micros(m[1]!);
        rows = rows.filter((r) => r.synced > at || (r.synced === at && r.id > m[3]!));
      }
      rows = rows.slice(0, Number(q.get('limit') ?? 1000));
      return this.json(
        200,
        rows.map((r) => ({ id: r.id, updated_ms: r.updated_ms, deleted: r.deleted, data: r.data, synced_at: iso(r.synced) })),
      );
    }
    if (path === 'rpc/push_chats') {
      const { p_rows } = (await req.json()) as { p_rows: { id: string; updated_ms: number; deleted?: boolean; data?: unknown }[] };
      if (!Array.isArray(p_rows) || p_rows.length > 50) return this.json(400, { code: '22023', message: 'push_chats takes an array of at most 50 chats' });
      const cloud = !!this.entitlements.get(user.id)?.cloud;
      if (p_rows.some((r) => !r.deleted) && !cloud) return this.json(403, { code: '42501', message: 'new row violates row-level security policy for table "chats"' });
      let n = 0;
      for (const r of p_rows) {
        const have = this.row(user.id, r.id);
        if (have && have.updated_ms >= r.updated_ms) continue;
        this.put(user.id, r.id, r.updated_ms, r.data ?? null, !!r.deleted);
        n++;
      }
      return this.json(200, n);
    }
    if (path === 'rpc/delete_all_chats') {
      let n = 0;
      for (const r of this.chats) {
        if (r.user_id !== user.id || r.deleted) continue;
        Object.assign(r, { deleted: true, data: null, updated_ms: Math.max(r.updated_ms + 1, Date.now()), synced: this.tick() });
        n++;
      }
      return this.json(200, n);
    }
    if (path === 'rpc/delete_me') {
      this.users.delete(user.id);
      this.entitlements.delete(user.id);
      this.chats = this.chats.filter((r) => r.user_id !== user.id);
      return this.json(200, null);
    }
    return this.json(404, { message: `no route ${path}` });
  }

  private async storage(req: Request, path: string, user: FakeUser): Promise<Response> {
    const own = (p: string) => p.split('/')[0] === user.id;
    if (path.startsWith('list/screenshots') && req.method === 'POST') {
      const { prefix } = (await req.json()) as { prefix: string };
      const dir = prefix.replace(/\/$/, '');
      if (!own(dir)) return this.json(200, []);
      const names = new Map<string, boolean>();
      for (const key of this.objects.keys()) {
        if (!key.startsWith(`${dir}/`)) continue;
        const rest = key.slice(dir.length + 1).split('/');
        names.set(rest[0]!, rest.length > 1 || names.get(rest[0]!) === true);
      }
      return this.json(
        200,
        [...names].sort().map(([name, folder]) => ({ name, id: folder ? null : `id-${name}`, metadata: folder ? null : {} })),
      );
    }
    if (path === 'screenshots' && req.method === 'DELETE') {
      const { prefixes } = (await req.json()) as { prefixes: string[] };
      const gone = prefixes.filter((p) => own(p) && this.objects.delete(p));
      return this.json(200, gone.map((name) => ({ name })));
    }
    if (path.startsWith('authenticated/screenshots/') && req.method === 'GET') {
      const key = decodeURIComponent(path.slice(26));
      const obj = own(key) ? this.objects.get(key) : undefined;
      if (!obj) return this.json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      return new Response(obj.bytes, { status: 200, headers: { ...CORS, 'content-type': obj.type } });
    }
    if (path.startsWith('screenshots/') && req.method === 'POST') {
      const key = decodeURIComponent(path.slice(12));
      if (!own(key) || !this.entitlements.get(user.id)?.cloud) {
        return this.json(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      }
      if (this.objects.has(key) && req.headers.get('x-upsert') !== 'true') return this.json(400, { statusCode: '409', error: 'Duplicate' });
      this.objects.set(key, { type: req.headers.get('content-type') ?? 'application/octet-stream', bytes: new Uint8Array(await req.arrayBuffer()) });
      return this.json(200, { Key: `screenshots/${key}` });
    }
    return this.json(404, { message: `no route ${path}` });
  }
}

/** Postgres-style timestamp with microseconds. */
function iso(us: number): string {
  const ms = Math.floor(us / 1000);
  return new Date(ms).toISOString().replace('Z', '').replace(/\.\d{3}$/, `.${String(us % 1_000_000).padStart(6, '0')}+00:00`);
}

function micros(s: string): number {
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)?$/.exec(s);
  if (!m) return Number.NaN;
  const base = Date.parse(`${m[1]}Z`) * 1000;
  const frac = Number((m[2] ?? '0').padEnd(6, '0').slice(0, 6));
  return base + frac;
}
