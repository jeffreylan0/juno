/**
 * Runs the real app (built with the test hook, see src-tauri/src/testhook.rs)
 * on its own virtual X display, with a fresh data folder, and drives it the
 * way a student would: the real shortcut and real pointer and keys through
 * the X server (xdotool), real screen capture. The hook only reports state
 * and runs a line of JavaScript where a test has to look inside a window.
 *
 * Linux is a development target, not a shipping one: no compositor runs on
 * a virtual display, so the transparent overlay draws black there, and the
 * capture steps the overlay aside instead (capture/mod.rs). Everything else
 * is the code macOS and Windows run.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const BINARY = resolve(__dirname, '../../src-tauri/target/e2e/debug/selection-ai-desktop');
export const SCREEN = { width: 1280, height: 800 };

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(what: string, check: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await check();
      if (v) return v as T;
    } catch (err) {
      last = err;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${String(last)})` : ''}`);
}

let displays = 110 + (process.pid % 40) * 3;

export interface WindowInfo {
  label: string;
  visible: boolean;
  focused: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayInfo {
  visible: boolean;
  interactive: boolean;
  regions: { x: number; y: number; width: number; height: number }[];
  ignoring: boolean | null;
}

export class App {
  private outputs: string[] = [];
  private reads = 0;

  private constructor(
    readonly display: number,
    readonly port: number,
    private xvfb: ChildProcess,
    private app: ChildProcess,
    private data: string,
  ) {
    for (const stream of [app.stdout, app.stderr]) stream?.on('data', (b: Buffer) => this.outputs.push(b.toString()));
  }

  /** A fresh app on a fresh display, with its core and overlay pages loaded. */
  static async launch(): Promise<App> {
    const display = displays++;
    const xvfb = spawn('Xvfb', [`:${display}`, '-screen', '0', `${SCREEN.width}x${SCREEN.height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
    await waitFor('the X server', () => existsSync(`/tmp/.X11-unix/X${display}`));
    const data = mkdtempSync(join(tmpdir(), 'sai-desktop-'));
    const port = 47000 + display;
    const app = spawn(BINARY, [], {
      env: {
        ...process.env,
        DISPLAY: `:${display}`,
        XDG_DATA_HOME: data,
        XDG_CONFIG_HOME: data,
        XDG_CACHE_HOME: data,
        SAI_TEST_PORT: String(port),
        WEBKIT_DISABLE_DMABUF_RENDERER: '1',
        NO_AT_BRIDGE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const it = new App(display, port, xvfb, app, data);
    await waitFor('the test hook', () => it.windows().then((w) => w.some((x) => x.label === 'overlay')), 30_000);
    await waitFor('the core page', () => it.read('core', `typeof browser === 'object'`), 30_000);
    await waitFor('the overlay page', () => it.read('overlay', `typeof browser === 'object'`), 30_000);
    return it;
  }

  async close(): Promise<void> {
    await this.hook('POST', '/quit').catch(() => {});
    await Promise.race([new Promise((r) => this.app.once('exit', r)), sleep(3000)]);
    this.app.kill('SIGKILL');
    this.xvfb.kill('SIGKILL');
    rmSync(this.data, { recursive: true, force: true });
  }

  get log(): string {
    return this.outputs.join('');
  }

  async hook<T = unknown>(method: string, path: string, body?: string): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, { method, body, signal: AbortSignal.timeout(10_000) });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? res.statusText);
    return json;
  }

  windows = () => this.hook<WindowInfo[]>('GET', '/windows');
  window = async (label: string) => (await this.windows()).find((w) => w.label === label);
  overlay = () => this.hook<OverlayInfo>('GET', '/overlay');
  storage = (area: 'local' | 'session') => this.hook<Record<string, unknown>>('GET', `/storage/${area}`);
  image = (id: string) => this.hook<{ chatId: string; dataUrl: string } | null>('GET', `/image/${id}`);

  /** A window with known pixels to select over: white, red square at 100–300, blue at 400–600 (y 100–300). */
  fixture = () => this.hook('POST', `/fixture?x=0&y=0&w=${SCREEN.width}&h=${SCREEN.height}`);

  /** The shortcut, as the menu bar icon's Select does it. */
  summon = () => this.hook('POST', '/summon');

  eval = (label: string, js: string) => this.hook('POST', `/eval/${label}`, js);

  /** The value of `expr` (awaited) inside a window. */
  async read<T = unknown>(label: string, expr: string): Promise<T> {
    const key = `test:out:${this.reads++}`;
    await this.eval(
      label,
      `(async () => { let v; try { v = await (async () => (${expr}))(); } catch (e) { v = { thrown: String(e) }; }
         await browser.storage.session.set({ ${JSON.stringify(key)}: { v: v === undefined ? null : v } }); })()`,
    );
    const out = await waitFor(`${expr} in ${label}`, async () => (await this.storage('session'))[key] as { v: T } | undefined, 10_000);
    return out.v;
  }

  /** Real input through the X server. */
  async xdo(...args: string[]): Promise<void> {
    await run('xdotool', args, { env: { ...process.env, DISPLAY: `:${this.display}` } });
  }

  async drag(points: [number, number][]): Promise<void> {
    const [first, ...rest] = points;
    await this.xdo('mousemove', String(first![0]), String(first![1]), 'mousedown', '1');
    for (const [x, y] of rest) {
      await sleep(30);
      await this.xdo('mousemove', String(x), String(y));
    }
    await sleep(60);
    await this.xdo('mouseup', '1');
  }

  async screenshot(file: string): Promise<void> {
    await run('import', ['-window', 'root', file], { env: { ...process.env, DISPLAY: `:${this.display}` } });
  }

  /** The current chat, saved or temporary. */
  async currentChat(): Promise<Chat | null> {
    const session = await this.storage('session');
    const current = session['current:1'] as { chatId: string } | undefined;
    if (!current) return null;
    const key = `chat:${current.chatId}`;
    return ((await this.storage('local'))[key] ?? session[key] ?? null) as Chat | null;
  }
}

export interface Chat {
  id: string;
  title: string;
  temporary?: boolean;
  items: Array<{
    kind: string;
    text?: string;
    error?: string;
    streaming?: boolean;
    plan?: { page: { title: string }; selection: { kind: string; rect: unknown }; parts: Array<{ kind: string; dataUrl: string; width: number; height: number }> };
  }>;
}

/** Pixels of a PNG data URL, read with ImageMagick: "r,g,b" at each point. */
export async function pixels(dataUrl: string, points: [number, number][]): Promise<string[]> {
  const file = join(tmpdir(), `sai-crop-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1]!, 'base64'));
  try {
    const format = points.map(([x, y]) => `%[fx:int(255*p{${x},${y}}.r)],%[fx:int(255*p{${x},${y}}.g)],%[fx:int(255*p{${x},${y}}.b)]`).join(' ');
    const { stdout } = await run('convert', [file, '-format', format, 'info:']);
    return stdout.trim().split(' ');
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * An OpenAI-compatible server standing in for a local model: it records
 * every request and streams a short answer.
 */
export async function fakeModelServer(answer = 'The red square is $x^2$.'): Promise<{ url: string; requests: { path: string; body: unknown }[]; close: () => Promise<void> }> {
  const requests: { path: string; body: unknown }[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((r) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => r(s));
    });
  const server: Server = createServer(async (req, res) => {
    const text = await read(req);
    requests.push({ path: req.url ?? '', body: text ? JSON.parse(text) : null });
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-vision' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of answer.match(/.{1,8}/g) ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await sleep(10);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 12 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
