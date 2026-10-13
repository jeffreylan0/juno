/**
 * The app end to end: the extension's scenarios that make sense outside a
 * browser, on the real app (harness.ts). Each test gets a fresh app on its
 * own display, over a window of known pixels.
 *
 *   pnpm --filter desktop test:e2e
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, onTestFinished } from 'vitest';
import { App, SCREEN, fakeModelServer, pixels, waitFor, type Chat } from './harness';

let app: App;

beforeEach(async () => {
  app = await App.launch();
  await app.fixture();
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === 'fail') console.log(`── app output ──\n${app?.log.slice(-6000)}`);
  await app?.close();
});

const RED = '220,20,20';
const BLUE = '20,20,220';
const WHITE = '255,255,255';

/** An expression on the bar, inside the overlay's shadow root. */
const bar = (rest: string) => `document.querySelector('selection-ai-overlay').shadowRoot.${rest}`;

async function armed(kind = 'box') {
  await waitFor(`the bar armed in ${kind}`, async () => {
    const o = await app.overlay();
    if (!o.visible || !o.interactive) return false;
    return (await app.read<string | null>('overlay', bar(`querySelector('.chip[aria-pressed=true]')?.dataset.kind ?? null`))) === kind;
  });
}

async function waiting() {
  return await waitFor('the bar waiting', async () => {
    const o = await app.overlay();
    return o.visible && !o.interactive && o.regions.length > 0 ? o : null;
  });
}

async function selections(n: number): Promise<Chat> {
  return await waitFor(`${n} selection(s) in the chat`, async () => {
    const chat = await app.currentChat();
    return chat && chat.items.filter((i) => i.kind === 'selection').length >= n ? chat : null;
  });
}

async function cropOf(chat: Chat, index = 0) {
  const part = chat.items.filter((i) => i.kind === 'selection')[index]!.plan!.parts[0]!;
  const id = part.dataUrl.replace(/^(idb|mem):/, '');
  const image = part.dataUrl.startsWith('mem:')
    ? ((await app.storage('session'))[`img:${id}`] as { dataUrl: string })
    : await app.image(id);
  return { part, dataUrl: image!.dataUrl };
}

/** A box from (x0, y0) to (x1, y1), dragged with the real pointer. */
const box = (x0: number, y0: number, x1: number, y1: number) =>
  app.drag([
    [x0, y0],
    [(x0 + x1) / 2, (y0 + y1) / 2],
    [x1, y1],
  ]);

it('the shortcut brings the bar up over the display, armed in the last mode, with Box and Freeform on offer', async () => {
  // The real key, through the X server, to the app's global shortcut.
  const pressed = Date.now();
  await app.xdo('key', 'alt+shift+s');
  await armed('box');
  // Promptly: the overlay page was loaded and listening before the key.
  expect(Date.now() - pressed).toBeLessThan(2500);
  // Over the whole display (the page's own viewport: GTK reports no outer size for an undecorated window).
  expect(await app.read('overlay', '[innerWidth, innerHeight]')).toEqual([SCREEN.width, SCREEN.height]);
  expect(await app.window('overlay')).toMatchObject({ x: 0, y: 0, visible: true });

  const chips = await app.read<string[]>('overlay', `[...${bar(`querySelectorAll('.chip')`)}].map((c) => c.dataset.kind)`);
  expect(chips).toEqual(['box', 'freeform']);
  // Armed, the screen is dimmed a little; Send waits off the bar (selections go when drawn, by default).
  await waitFor('the dim', async () => (await app.read('overlay', `getComputedStyle(${bar(`querySelector('.backdrop')`)}).backgroundColor`)) === 'rgba(20, 20, 19, 0.26)');
  expect(await app.read('overlay', `getComputedStyle(${bar(`querySelector('.ask')`)}).display`)).toBe('none');
  // The panel waits, hidden, for the first selection.
  expect((await app.window('panel'))?.visible).toBe(false);
});

it('opening the app brings the bar straight up, armed, as the shortcut does', async () => {
  await app.close();
  app = await App.launch({ opened: true });
  await armed('box');
  expect(await app.read('overlay', `${bar(`querySelector('[data-testid=bar-notice]')`)}.classList.contains('on')`)).toBe(false);
});

it('before macOS lets the app see the screen, the bar asks for it; "Not now" selects anyway', async () => {
  await app.close();
  app = await App.launch({ env: { SAI_TEST_SCREEN_ACCESS: 'denied' } });
  await app.summon();
  // Up, but nothing armed: the note under the row is what to do first.
  await waiting();
  const notice = () => app.read<string | null>('overlay', `${bar(`querySelector('[data-testid=bar-notice].on')`)}?.dataset.id ?? null`);
  await waitFor('the permission note', async () => (await notice()) === 'screen-permission');
  expect(await app.read('overlay', bar(`querySelector('[data-testid=bar-notice]').textContent`))).toContain('Needs Screen Recording permission');

  await app.eval('overlay', bar(`querySelector('[data-testid=notice-later]').click()`));
  await armed('box');
  expect(await notice()).toBeNull();
  // Not asked again this time round.
  await app.xdo('mousemove', '640', '400');
  await app.xdo('key', 'Escape');
  await waitFor('the overlay hidden', async () => !(await app.overlay()).visible);
  await app.summon();
  await armed('box');
  expect(await notice()).toBeNull();
});

it('"Turn on Screen Recording" steps the bar aside for System Settings; next time it says to restart', async () => {
  await app.close();
  app = await App.launch({ env: { SAI_TEST_SCREEN_ACCESS: 'denied' } });
  await app.summon();
  const notice = () => app.read<string | null>('overlay', `${bar(`querySelector('[data-testid=bar-notice].on')`)}?.dataset.id ?? null`);
  await waitFor('the permission note', async () => (await notice()) === 'screen-permission');
  await app.eval('overlay', bar(`querySelector('[data-testid=notice-screen-enable]').click()`));
  await waitFor('the overlay hidden', async () => !(await app.overlay()).visible);

  await app.summon();
  await waiting();
  await waitFor('the restart note', async () => (await notice()) === 'screen-restart');
  expect(await app.read('overlay', bar(`querySelector('[data-testid=notice-restart]').textContent`))).toBe('Restart');
});

it('a box over known pixels: the panel opens as a card at the top right, the chat gets exactly that crop, and the bar waits', async () => {
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);

  const chat = await selections(1);
  const { part, dataUrl } = await cropOf(chat);
  expect([part.width, part.height]).toEqual([100, 100]);
  expect(await pixels(dataUrl, [[2, 2], [50, 50], [97, 97]])).toEqual([RED, RED, RED]);
  // Saved: the chat in the app's storage, its screenshot as a file.
  expect(part.dataUrl).toMatch(/^idb:/);
  expect(chat.temporary).toBeFalsy();

  const panel = await waitFor('the panel', async () => {
    const w = await app.window('panel');
    return w?.visible && w.width > 0 ? w : null;
  });
  // A card 12 px in from the top right, most of the screen tall (72%), never past its bottom margin.
  expect(panel.width).toBe(420);
  expect(panel.x + panel.width).toBe(SCREEN.width - 12);
  expect(panel.y).toBe(12);
  expect(panel.height).toBeGreaterThanOrEqual(Math.round(SCREEN.height * 0.72));
  expect(panel.height).toBeLessThanOrEqual(SCREEN.height - 24);

  const o = await waiting();
  expect(o.regions).toHaveLength(1);
  await waitFor('the screenshot in the panel', async () => (await app.read('panel', `document.querySelectorAll('[data-testid=selection] img').length`)) === 1);
  expect(await app.read('panel', `document.querySelector('[data-testid=selection-kind]').textContent`)).toBe('Box');
});

it('freeform: the model gets the shape’s bounding box with everything outside the outline painted white', async () => {
  await app.summon();
  await armed();
  await app.eval('overlay', bar(`querySelector('.chip[data-kind=freeform]').click()`));
  await armed('freeform');
  // A diamond inside the red square.
  await app.drag([
    [200, 110],
    [245, 155],
    [290, 200],
    [245, 245],
    [200, 290],
    [155, 245],
    [110, 200],
    [155, 155],
    [199, 111],
  ]);
  const chat = await selections(1);
  const { part, dataUrl } = await cropOf(chat);
  expect([part.width, part.height]).toEqual([180, 180]);
  expect(await pixels(dataUrl, [[90, 90], [2, 2], [177, 2], [2, 177], [177, 177]])).toEqual([RED, WHITE, WHITE, WHITE, WHITE]);
  expect(chat.items[0]!.plan!.selection.kind).toBe('freeform');
});

it('asking sends the screenshot to the AI, and the answer streams into the panel', async () => {
  const model = await fakeModelServer('The red square is $x^2$ wide.');
  try {
    await app.eval(
      'core',
      `browser.storage.local.get('settings').then(({ settings }) => browser.storage.local.set({ settings: { ...(settings ?? {}), version: 3, provider: 'local', localBaseUrl: ${JSON.stringify(model.url)}, localModel: 'fake-vision' } }))`,
    );
    await waitFor('settings saved', async () => ((await app.storage('local')).settings as { provider?: string })?.provider === 'local');
    await app.summon();
    await armed();
    await box(150, 150, 250, 250);
    await selections(1);
    await waitFor('the panel', () => app.read('panel', `!!document.querySelector('[data-testid=selection] img')`));
    await app.eval('panel', `[...document.querySelectorAll('button.macro')].find((b) => b.textContent === 'Explain').click()`);

    const chat = await waitFor('the answer', async () => {
      const c = await app.currentChat();
      const last = c?.items.at(-1);
      return last?.kind === 'assistant' && !last.streaming && last.text ? c : null;
    });
    expect(chat.items.at(-1)!.text).toBe('The red square is $x^2$ wide.');
    expect(chat.items.at(-2)).toMatchObject({ kind: 'user', text: 'Explain this step by step.' });

    // Through the native core, not the page: no CORS, and exactly the crop.
    const ask = model.requests.find((r) => r.path.endsWith('/chat/completions'))!;
    const body = ask.body as { model: string; messages: { role: string; content: unknown }[] };
    expect(body.model).toBe('fake-vision');
    const images = JSON.stringify(body.messages).match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? [];
    expect(images).toHaveLength(1);
    expect(await pixels(images[0]!, [[50, 50]])).toEqual([RED]);
    // The answer is rendered, maths included.
    await waitFor('KaTeX in the answer', () => app.read('panel', `!!document.querySelector('.turn.assistant .katex')`));
  } finally {
    await model.close();
  }
});

it('while the bar waits, the pointer goes through to the app beneath, except on the bar', async () => {
  await app.summon();
  await armed();
  // Armed: the whole display takes the pointer, wherever it is.
  await app.xdo('mousemove', '640', '400');
  await waitFor('the overlay taking the pointer', async () => (await app.overlay()).ignoring === false);
  await box(150, 150, 250, 250);
  const { regions } = await waiting();
  const b = regions[0]!;

  await app.xdo('mousemove', '640', '300');
  await waitFor('clicks going through', async () => (await app.overlay()).ignoring === true);
  await app.xdo('mousemove', String(b.x + 20), String(b.y + b.height / 2));
  await waitFor('clicks reaching the bar', async () => (await app.overlay()).ignoring === false);
});

it('✕ on the bar finishes the chat: the bar and the panel go, and the chat stays in the menu', async () => {
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  const chat = await selections(1);
  const { regions } = await waiting();
  const b = regions[0]!;
  // The ✕ is the bar's first control: a real click on it.
  await app.xdo('mousemove', String(b.x + 23), String(b.y + b.height / 2));
  await waitFor('the bar taking the click', async () => (await app.overlay()).ignoring === false);
  await app.xdo('click', '1');

  await waitFor('the overlay hidden', async () => !(await app.overlay()).visible && !(await app.window('overlay'))?.visible);
  // Hidden, and kept for the next selection.
  await waitFor('the panel hidden', async () => (await app.window('panel'))?.visible === false);
  const session = await app.storage('session');
  expect(session['current:1']).toBeUndefined();
  const index = (await app.storage('local')).chatIndex as { id: string }[];
  expect(index.map((c) => c.id)).toEqual([chat.id]);
});

it('Escape before anything is selected means never mind: the bar goes and no chat is made', async () => {
  await app.summon();
  await armed();
  await app.xdo('mousemove', '640', '400');
  await app.xdo('key', 'Escape');
  await waitFor('the overlay hidden', async () => !(await app.overlay()).visible);
  expect(await app.currentChat()).toBeNull();
  expect((await app.window('panel'))?.visible).toBe(false);
});

it('Escape while selecting after a selection only stops that selection; the bar waits', async () => {
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  await selections(1);
  await waiting();
  await app.eval('overlay', bar(`querySelector('.chip[data-kind=box]').click()`));
  await armed('box');
  await app.xdo('mousemove', '640', '300');
  await app.xdo('key', 'Escape');
  await waiting();
  expect((await app.overlay()).visible).toBe(true);
  expect((await app.currentChat())!.items).toHaveLength(1);
});

it('closing the panel finishes the chat and takes the bar away, as ✕ on the side panel does', async () => {
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  await selections(1);
  await waitFor('the panel', () => app.read('panel', `!!document.querySelector('[data-testid=selection]')`));
  await app.eval('panel', 'window.close()');
  await waitFor('the panel hidden', async () => (await app.window('panel'))?.visible === false);
  await waitFor('the overlay hidden', async () => !(await app.overlay()).visible);
  expect((await app.storage('session'))['current:1']).toBeUndefined();
});

it('the panel is ready before the first selection: it shows at once, with a placeholder until the selection lands, and is the same panel next time', async () => {
  // Made at start, hidden, its page loaded (App.launch waits for it).
  expect((await app.window('panel'))?.visible).toBe(false);
  await app.eval(
    'panel',
    `window.__mark = 'kept'; window.__sawIncoming = false;
     new MutationObserver(() => { if (document.querySelector('[data-testid=selection-incoming]')) window.__sawIncoming = true; })
       .observe(document.body, { subtree: true, childList: true });`,
  );
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  await selections(1);
  await waitFor('the panel', async () => (await app.window('panel'))?.visible);
  expect(await app.read('panel', 'window.__sawIncoming')).toBe(true);
  // The placeholder gives way to the selection itself.
  await waitFor('the screenshot in the panel', async () => (await app.read('panel', `document.querySelectorAll('[data-testid=selection] img').length`)) === 1);
  expect(await app.read('panel', `!!document.querySelector('[data-testid=selection-incoming]')`)).toBe(false);

  // Finished, then a new chat: the same page shows it, not a new window.
  await app.eval('panel', 'window.close()');
  await waitFor('the panel hidden', async () => (await app.window('panel'))?.visible === false);
  await app.summon();
  await armed();
  await box(400, 150, 500, 250);
  await waitFor('the new chat in the panel', async () => (await app.window('panel'))?.visible && (await app.read('panel', `document.querySelectorAll('[data-testid=selection]').length`)) === 1);
  expect(await app.read('panel', 'window.__mark')).toBe('kept');
  expect(await app.read('panel', `document.documentElement.dataset.card`)).toBe('in');
});

it('scrolling while armed goes to the app beneath, the dim staying put, until the pointer moves to select', async () => {
  await app.summon();
  await armed();
  await app.xdo('mousemove', '640', '400');
  await waitFor('the overlay taking the pointer', async () => (await app.overlay()).ignoring === false);
  // A wheel turn (button 5): the overlay lets the pointer through, still armed and dimmed.
  await app.xdo('click', '5');
  await waitFor('the wheel going through', async () => (await app.overlay()).ignoring === true);
  const o = await app.overlay();
  expect(o.visible && o.interactive).toBe(true);
  expect(await app.read('overlay', bar(`host.dataset.state`))).toBe('armed');
  // Moving to select takes the pointer back.
  await app.xdo('mousemove', '660', '420');
  await waitFor('the overlay taking the pointer again', async () => (await app.overlay()).ignoring === false);
  await box(150, 150, 250, 250);
  await selections(1);
});

it('two selections go into one chat, each with its own crop', async () => {
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  await selections(1);
  await waiting();
  await app.eval('overlay', bar(`querySelector('.chip[data-kind=box]').click()`));
  await armed('box');
  await box(450, 150, 550, 250);
  const chat = await selections(2);
  expect(await pixels((await cropOf(chat, 0)).dataUrl, [[50, 50]])).toEqual([RED]);
  expect(await pixels((await cropOf(chat, 1)).dataUrl, [[50, 50]])).toEqual([BLUE]);
  await waitFor('both in the panel', async () => (await app.read('panel', `document.querySelectorAll('[data-testid=selection]').length`)) === 2);
  // The panel grew downwards to fit them, from where its top was.
  await waitFor('the panel grown to fit its chat', async () => {
    const w = await app.window('panel');
    return w && w.y === 12 && w.height > 460 ? w : null;
  });
});

it('the ghost on the bar: the next selection is a temporary chat, in memory only, gone when finished', async () => {
  await app.summon();
  await armed();
  await app.eval('overlay', bar(`querySelector('.ghost').click()`));
  await waitFor('the ghost on', async () => (await app.read('overlay', bar(`querySelector('.ghost').getAttribute('aria-pressed')`))) === 'true');
  await box(150, 150, 250, 250);
  const chat = await selections(1);
  expect(chat.temporary).toBe(true);
  expect((await cropOf(chat)).part.dataUrl).toMatch(/^mem:/);
  expect(Object.keys(await app.storage('local')).filter((k) => k.startsWith('chat'))).toEqual([]);
  await waitFor('the panel on the temporary chat', async () => (await app.read('panel', `document.querySelector('[data-testid=chat-title]')?.textContent`)) === 'Temporary chat');

  await app.eval('overlay', bar(`querySelector('.close').click()`));
  await waitFor('the temporary chat deleted', async () => {
    const session = await app.storage('session');
    return !Object.keys(session).some((k) => k.startsWith('chat:') || k.startsWith('img:'));
  });
});

it('the gear on the bar opens settings: the app’s own shortcut, no blocked sites, keys in a private file, and Quit', async () => {
  await app.summon();
  await armed();
  await app.eval('overlay', bar(`querySelector('.gear').click()`));
  await waitFor('quick settings', () => app.read('overlay', `!!${bar(`querySelector('.more')`)}`));
  await app.eval('overlay', bar(`querySelector('.more').click()`));
  await waitFor('the settings window', async () => (await app.window('settings'))?.visible);
  // Settings are not a selection: the bar goes, and the dim with it.
  await waitFor('the bar gone', async () => !(await app.overlay()).visible);
  await waitFor('the settings page', () => app.read('settings', `!!document.querySelector('[data-testid=section-answers]')`));
  // The page fills its window plainly (no frame drawn around it), and every field shows.
  expect(await app.read('settings', `getComputedStyle(document.documentElement).borderTopWidth`)).toBe('0px');
  const macro = await app.read<{ opacity: string; width: number; prompt: number }>(
    'settings',
    `(() => { const n = document.querySelector('.macro-name'); return { opacity: getComputedStyle(n).opacity, width: n.getBoundingClientRect().width, prompt: document.querySelector('.macro-prompt').getBoundingClientRect().width }; })()`,
  );
  expect(macro.opacity).toBe('1');
  expect(macro.width).toBeGreaterThan(100);
  expect(macro.prompt).toBeGreaterThan(300);
  const text = await app.read<string>('settings', 'document.body.innerText');
  expect(text).toContain('Keyboard shortcut');
  expect(text).toContain('Alt + Shift + S');
  expect(text).toContain('Works in every app');
  expect(text).not.toContain('Blocked sites');
  expect(text).not.toContain("browser's PDF viewer");
  expect(text).toContain("the window's title go to the AI you picked");
  expect(text).toContain('only your account can read');
  expect(text).toContain('Quit Juno');
});

it('Quit in settings ends the app (the menu bar icon starts a selection when clicked, so Quit lives here and in its right-click menu)', async () => {
  await app.summon();
  await armed();
  await app.eval('overlay', bar(`querySelector('.gear').click()`));
  await waitFor('quick settings', () => app.read('overlay', `!!${bar(`querySelector('.more')`)}`));
  await app.eval('overlay', bar(`querySelector('.more').click()`));
  await waitFor('the settings page', () => app.read('settings', `!!document.querySelector('[data-testid=quit]')`));
  await app.eval('settings', `document.querySelector('[data-testid=quit]').click()`);
  await waitFor('the app to quit', () => app.app.exitCode !== null || app.app.signalCode !== null, 10_000);
  expect(app.app.exitCode).toBe(0);
});

it('Open at login is off until turned on; on, the app starts hidden in the menu bar', async () => {
  // A home of its own: the autostart entry goes under ~/.config/autostart on Linux.
  await app.close();
  const home = mkdtempSync(join(tmpdir(), 'sai-home-'));
  // After afterEach has closed the app.
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  app = await App.launch({ env: { HOME: home } });
  await app.summon();
  await armed();
  await app.eval('overlay', bar(`querySelector('.gear').click()`));
  await waitFor('quick settings', () => app.read('overlay', `!!${bar(`querySelector('.more')`)}`));
  await app.eval('overlay', bar(`querySelector('.more').click()`));
  await waitFor('the setting', () => app.read('settings', `!!document.querySelector('[data-testid=open-at-login]')`));
  expect(await app.read('settings', `document.querySelector('[data-testid=open-at-login]').checked`)).toBe(false);

  const dir = join(home, '.config', 'autostart');
  const entries = () => (existsSync(dir) ? readdirSync(dir) : []);
  await app.eval('settings', `document.querySelector('[data-testid=open-at-login]').click()`);
  await waitFor('the autostart entry', () => entries().length === 1);
  expect(readFileSync(join(dir, entries()[0]!), 'utf8')).toContain('--hidden');
  await waitFor('the box ticked', () => app.read('settings', `document.querySelector('[data-testid=open-at-login]').checked`));

  await app.eval('settings', `document.querySelector('[data-testid=open-at-login]').click()`);
  await waitFor('the entry gone', () => entries().length === 0);
});
