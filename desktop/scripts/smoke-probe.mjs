// Looks inside the app's pages through WebView2's DevTools port (the smoke
// script starts the app with --remote-debugging-port): whether each page's
// scripts ran, whether it can reach the app (a command, answered or not),
// and what it threw. Then reloads the core page, catching every exception
// and console line from its start. For CI only (smoke-windows.ps1).
//
//   node smoke-probe.mjs [port]
const port = Number(process.argv[2] ?? 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      return await res.json();
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`no DevTools on port ${port}`);
}

function session(url) {
  const ws = new WebSocket(url);
  let next = 0;
  const waiting = new Map();
  const events = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
    else events.push(msg);
  });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const send = async (method, params = {}) => {
    await open;
    const id = ++next;
    const reply = new Promise((resolve) => waiting.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params }));
    return await Promise.race([reply, sleep(10_000).then(() => ({ error: { message: `${method} timed out` } }))]);
  };
  return { send, events, close: () => ws.close() };
}

const PROBE = `(async () => {
  const internals = window.__TAURI_INTERNALS__;
  const out = {
    href: location.href,
    readyState: document.readyState,
    tauri: typeof internals,
    browser: typeof globalThis.browser,
    chrome: typeof globalThis.chrome,
    webview: typeof globalThis.chrome?.webview,
    scripts: [...document.scripts].map((s) => s.src.split('/').pop() || '(inline)'),
    body: document.body ? document.body.innerHTML.length : -1,
  };
  if (internals) {
    out.invoke = await Promise.race([
      internals.invoke('app_info').then((v) => ({ answered: !!v }), (e) => ({ failed: String(e?.message ?? e) })),
      new Promise((r) => setTimeout(() => r({ timedOut: true }), 4000)),
    ]);
  }
  return JSON.stringify(out);
})()`;

const describe = (e) =>
  e.method === 'Runtime.exceptionThrown'
    ? `exception: ${e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text} (${e.params.exceptionDetails.url ?? ''}:${e.params.exceptionDetails.lineNumber})`
    : e.method === 'Runtime.consoleAPICalled'
      ? `console.${e.params.type}: ${e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`
      : e.method === 'Log.entryAdded'
        ? `log ${e.params.entry.level} (${e.params.entry.source}): ${e.params.entry.text} ${e.params.entry.url ?? ''}`
        : null;

const pages = (await targets()).filter((t) => t.type === 'page');
console.log(`${pages.length} page(s)`);
for (const page of pages) {
  console.log(`\n-- ${page.title} ${page.url}`);
  const s = session(page.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.send('Log.enable');
  const probe = await s.send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
  console.log(probe.result?.result?.value ?? JSON.stringify(probe.result?.exceptionDetails ?? probe.error));
  await sleep(300);
  for (const e of s.events) {
    const line = describe(e);
    if (line) console.log(`  ${line}`);
  }
  if (page.url.includes('core.html')) {
    console.log('  reloading the core page, watching it start:');
    s.events.length = 0;
    await s.send('Page.enable');
    await s.send('Page.reload', { ignoreCache: true });
    await sleep(8000);
    for (const e of s.events) {
      const line = describe(e);
      if (line) console.log(`  ${line}`);
    }
    const again = await s.send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
    console.log(`  after: ${again.result?.result?.value ?? JSON.stringify(again.result?.exceptionDetails ?? again.error)}`);
  }
  s.close();
}
process.exit(0);
