/**
 * The app end to end, on the real app (harness.ts). Each test gets a fresh app on its
 * own display, over a window of known pixels.
 *
 *   pnpm --filter desktop test:e2e
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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

/**
 * The waiting bar once the panel is open, as the native core knows it: it
 * narrows then (chats, ghost and gear are the panel's), so a position read
 * before that misses it. The narrowing is animated, so the bar's width is
 * read again each time, and taken once the core has had it for two looks
 * running (a slow machine can be mid-animation when the buttons are gone).
 */
async function settledBar() {
  await waitFor('the panel', async () => (await app.window('panel'))?.visible);
  let before = '';
  const o = await waitFor('the narrower bar told to the core', async () => {
    const l = await barLayout();
    const o = await app.overlay();
    const r = o.regions[0];
    const told = l.shown.length === 0 && o.visible && !o.interactive && !!r && Math.abs(r.width - l.bar.width) <= 2;
    const now = told ? JSON.stringify(r) : '';
    const settled = told && now === before;
    before = now;
    return settled ? o : null;
  });
  return o.regions[0]!;
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

it('the shortcut brings the bar up over the display, armed in Box, with Box and Freeform on offer', async () => {
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

it('the bar always comes up in Box, whatever mode was used last', async () => {
  await app.summon();
  await armed('box');
  await app.eval('overlay', bar(`querySelector('.chip[data-kind=freeform]').click()`));
  await armed('freeform');
  // Nothing selected yet: Escape means never mind, and the bar goes.
  await app.xdo('mousemove', '640', '400');
  await app.xdo('key', 'Escape');
  await waitFor('the overlay hidden', async () => !(await app.overlay()).visible);
  await app.summon();
  await armed('box');
  expect((await app.storage('local')).lastSelectionKind).toBeUndefined();
});

/** Whether one of the bar's buttons can be seen: folded away, it is hidden with no width. */
const SHOWS = `(el) => !!el && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0`;

/** Where the bar and its modes are, and which of its chats, ghost and gear show. */
const barLayout = () =>
  app.read<{ bar: { left: number; width: number }; chips: { left: number; width: number }; shown: string[] }>(
    'overlay',
    `(() => {
      const s = document.querySelector('selection-ai-overlay').shadowRoot;
      const at = (q) => { const r = s.querySelector(q).getBoundingClientRect(); return { left: r.left, width: r.width }; };
      const shown = ['.chats', '.ghost', '.gear'].filter((q) => (${SHOWS})(s.querySelector(q)));
      return { bar: at('.bar'), chips: at('.chips'), shown };
    })()`,
  );

it('the bar is compact, its modes in the middle; chats, ghost and gear leave it to the panel while the panel is open', async () => {
  await app.summon();
  await armed();
  const before = await barLayout();
  expect(before.bar.width).toBeLessThan(340);
  const middle = (r: { left: number; width: number }) => r.left + r.width / 2;
  expect(Math.abs(middle(before.chips) - middle(before.bar))).toBeLessThanOrEqual(1);
  expect(before.shown).toEqual(['.chats', '.ghost', '.gear']);

  // Widened by the gear's settings: ✕ still on the left, the modes in the middle, the buttons on the right.
  await app.eval('overlay', bar(`querySelector('.gear').click()`));
  await waitFor('the bar widened', async () => (await barLayout()).bar.width > before.bar.width + 50);
  await new Promise((r) => setTimeout(r, 300));
  const wide = await app.read<{ bar: [number, number]; close: number; chips: [number, number]; gear: number }>(
    'overlay',
    `(() => {
      const s = document.querySelector('selection-ai-overlay').shadowRoot;
      const r = (q) => s.querySelector(q).getBoundingClientRect();
      return { bar: [r('.bar').left, r('.bar').right], close: r('.close').left, chips: [r('.chips').left, r('.chips').right], gear: r('.gear').right };
    })()`,
  );
  expect(Math.abs((wide.chips[0] + wide.chips[1]) / 2 - (wide.bar[0] + wide.bar[1]) / 2)).toBeLessThanOrEqual(1);
  expect(wide.close - wide.bar[0]).toBeLessThanOrEqual(10);
  expect(wide.bar[1] - wide.gear).toBeLessThanOrEqual(10);
  await app.eval('overlay', bar(`querySelector('.gear').click()`));
  await waitFor('the bar compact again', async () => Math.abs((await barLayout()).bar.width - before.bar.width) <= 1);
  await armed();

  // They fold away (an animation, not a jump) once the panel opens.
  await app.eval(
    'overlay',
    `(() => {
      window.__folds = [];
      document.querySelector('selection-ai-overlay').shadowRoot
        .addEventListener('transitionstart', (e) => window.__folds.push(e.target.classList[0] + ':' + e.propertyName));
    })()`,
  );
  await box(150, 150, 250, 250);
  await selections(1);
  await waitFor('the panel', async () => (await app.window('panel'))?.visible);
  await waitFor('the bar without them', async () => (await barLayout()).shown.length === 0);
  expect(await app.read<string[]>('overlay', 'window.__folds')).toEqual(expect.arrayContaining(['chats:width', 'gear:opacity', 'start:min-width']));
  // ✕ and the modes, as much room before the one as after the other.
  const pads = await app.read<{ before: number; after: number }>(
    'overlay',
    `(() => {
      const s = document.querySelector('selection-ai-overlay').shadowRoot;
      const r = (q) => s.querySelector(q).getBoundingClientRect();
      return { before: r('.close').left - r('.bar').left, after: r('.bar').right - r('.chips').right };
    })()`,
  );
  expect(Math.abs(pads.before - pads.after)).toBeLessThanOrEqual(1);

  // ✕ on the bar: it goes as it is, never showing chats, ghost and gear again on the way out.
  await app.eval(
    'overlay',
    `(() => {
      window.__flashed = false;
      const host = document.querySelector('selection-ai-overlay');
      const look = () => {
        const s = host.shadowRoot;
        if (!host.isConnected) return;
        if (['.chats', '.ghost', '.gear'].some((q) => (${SHOWS})(s.querySelector(q)))) window.__flashed = true;
      };
      new MutationObserver(look).observe(host.shadowRoot, { subtree: true, attributes: true, childList: true });
      const frame = () => { look(); if (host.isConnected) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    })()`,
  );
  await app.eval('overlay', bar(`querySelector('.close').click()`));
  await waitFor('the overlay hidden', async () => !(await app.overlay()).visible);
  expect(await app.read('overlay', 'window.__flashed')).toBe(false);
});

it('the chats button on the bar opens the panel on the list of chats, with nothing armed over it', async () => {
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  const chat = await selections(1);
  await app.eval('panel', 'window.close()');
  await waitFor('the panel hidden', async () => (await app.window('panel'))?.visible === false);

  await app.summon();
  await armed();
  await app.eval('overlay', bar(`querySelector('.chats').click()`));
  await waitFor('the panel', async () => (await app.window('panel'))?.visible);
  await waitFor('the chat menu', () => app.read('panel', `!!document.querySelector('[data-testid=chat-menu]')`));
  expect(await app.read('panel', `document.querySelector('[data-testid=chat-menu] nav').textContent`)).toContain(chat.title);
  // The selection was put down (the bar waits), and no chat was finished for it.
  await waiting();
  expect((await app.storage('local')).chatIndex).toHaveLength(1);
});

it('the panel: ✕ first, then the chats menu; text at the system’s size; notices float over the chat and go by themselves', async () => {
  // Made at start, hidden: a notice's time runs out before anyone sees it (as it did on Windows).
  const ring = `document.querySelector('.notice-timer circle')`;
  await waitFor('the notice in the hidden panel', () => app.read('panel', `!!${ring}`));
  await app.eval('panel', `${ring}.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }))`);
  await waitFor('the notice gone', async () => !(await app.read('panel', `!!document.querySelector('[data-testid=notice]')`)));

  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  await selections(1);
  await waitFor('the panel', async () => (await app.window('panel'))?.visible);
  await waitFor('the selection in the panel', () => app.read('panel', `!!document.querySelector('[data-testid=selection]')`));
  expect(await app.read('panel', `[...document.querySelectorAll('.topbar button')].map((b) => b.dataset.testid)`)).toEqual([
    'close',
    'menu',
    'chat-title',
    'temporary',
    'settings',
  ]);
  // Linux sizes as Windows does: 14 px body text.
  expect(await app.read('panel', `getComputedStyle(document.documentElement).fontSize`)).toBe('14px');

  // Shown, the panel brings the notice back (no AI picked yet), over the end of the chat, on a timer.
  await waitFor('the notice back', () => app.read('panel', `!!document.querySelector('[data-testid=notice]')`));
  expect(await app.read('panel', `document.querySelector('[data-testid=notice]').textContent`)).toContain('Pick who answers');
  expect(await app.read('panel', `getComputedStyle(document.querySelector('.notices')).position`)).toBe('absolute');
  expect(await app.read('panel', `${ring}.style.animationDuration`)).toBe('5000ms');
  // The ring runs out: the notice goes.
  await app.eval('panel', `${ring}.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }))`);
  await waitFor('the notice gone again', async () => !(await app.read('panel', `!!document.querySelector('[data-testid=notice]')`)));
});

it('the first time the app is opened, setup comes up instead of the bar: pick who answers, then the bar', async () => {
  await app.close();
  app = await App.launch({ opened: true, firstRun: true });
  await waitFor('the setup', async () => (await app.window('settings'))?.visible && (await app.read('settings', `!!document.querySelector('[data-testid=setup]')`)), 20_000);
  expect((await app.overlay()).visible).toBe(false);
  // No made-up answers to pick: a key, a local model (or, in builds with accounts, an account).
  const cards = await app.read<string[]>('settings', `[...document.querySelectorAll('[data-testid=setup] .card')].map((c) => c.dataset.testid)`);
  expect(cards.slice(0, 2)).toEqual(['setup-key', 'setup-local']);
  expect(await app.read('settings', `document.querySelector('[data-testid=setup-start]').disabled`)).toBe(true);

  const model = await fakeModelServer();
  onTestFinished(() => model.close());
  await app.eval('settings', `document.querySelector('[data-testid=setup-local] input').click()`);
  await waitFor('the local model fields', () => app.read('settings', `!!document.querySelector('[data-testid=local] input')`));
  await app.eval(
    'settings',
    `(() => {
      const input = document.querySelector('[data-testid=local] input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(model.url)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
  await waitFor('the address saved', async () => ((await app.storage('local')).settings as { localBaseUrl?: string })?.localBaseUrl === model.url);
  await waitFor('Start', async () => !(await app.read('settings', `document.querySelector('[data-testid=setup-start]').disabled`)));
  await app.eval('settings', `document.querySelector('[data-testid=setup-start]').click()`);
  // Setup goes, the bar comes up, and setup is behind the student for good.
  await armed('box');
  expect((await app.window('settings'))?.visible).toBe(false);
  expect((await app.storage('local')).settings).toMatchObject({ provider: 'local', setupDone: true });
  await app.eval('core', `browser.runtime.openOptionsPage()`);
  await waitFor('all of settings', () => app.read('settings', `!!document.querySelector('[data-testid=section-answers]')`));
  expect(await app.read('settings', `!!document.querySelector('[data-testid=setup]')`)).toBe(false);
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

/** Answers come from a local model at `url` (a fakeModelServer). */
async function answerWith(url: string) {
  await app.eval(
    'core',
    `browser.storage.local.get('settings').then(({ settings }) => browser.storage.local.set({ settings: { ...(settings ?? {}), version: 3, provider: 'local', localBaseUrl: ${JSON.stringify(url)}, localModel: 'fake-vision' } }))`,
  );
  await waitFor('settings saved', async () => ((await app.storage('local')).settings as { localBaseUrl?: string })?.localBaseUrl === url);
}

it('asking sends the screenshot to the AI, and the answer streams into the panel', async () => {
  const model = await fakeModelServer('The red square is $x^2$ wide.');
  try {
    await answerWith(model.url);
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

it('scrolling up while an answer streams stays put, by however little; back at the end, the chat follows again', async () => {
  const model = await fakeModelServer(Array.from({ length: 160 }, (_, i) => `Line ${i + 1} of a long answer.`).join('\n\n'));
  try {
    await answerWith(model.url);
    await app.summon();
    await armed();
    await box(150, 150, 250, 250);
    await selections(1);
    await waitFor('the panel', () => app.read('panel', `!!document.querySelector('[data-testid=selection] img')`));
    await app.eval('panel', `[...document.querySelectorAll('button.macro')].find((b) => b.textContent === 'Explain').click()`);
    const thread = `document.querySelector('[data-testid=thread]')`;
    const gap = () => app.read<number>('panel', `(() => { const t = ${thread}; return t.scrollHeight - t.scrollTop - t.clientHeight; })()`);
    const top = () => app.read<number>('panel', `${thread}.scrollTop`);
    const streaming = async () => !!(await app.currentChat())?.items.at(-1)?.streaming;
    await waitFor('the answer past the panel', () => app.read('panel', `(() => { const t = ${thread}; return t.scrollHeight > t.clientHeight + 300; })()`));

    // A trackpad's smallest nudge up: the answer keeps coming, the chat stays where it was put.
    await app.eval('panel', `(() => { const t = ${thread}; t.dispatchEvent(new WheelEvent('wheel', { deltaY: -6, bubbles: true })); t.scrollBy(0, -6); })()`);
    const nudged = await top();
    await new Promise((r) => setTimeout(r, 600));
    expect(await streaming()).toBe(true);
    expect(Math.abs((await top()) - nudged)).toBeLessThanOrEqual(1);
    expect(await gap()).toBeGreaterThan(20);

    // Back at the end, it follows; dragged up by the scroll bar (no wheel), it stays again.
    await app.eval('panel', `${thread}.scrollTo({ top: ${thread}.scrollHeight })`);
    await new Promise((r) => setTimeout(r, 400));
    expect(await gap()).toBeLessThanOrEqual(4);
    await app.eval('panel', `${thread}.scrollBy(0, -40)`);
    const dragged = await top();
    await new Promise((r) => setTimeout(r, 400));
    expect(await streaming()).toBe(true);
    expect(Math.abs((await top()) - dragged)).toBeLessThanOrEqual(1);
  } finally {
    await model.close();
  }
});

/** The panel's latest answer, once it has finished. */
async function answered(after?: string) {
  return await waitFor('the answer', async () => {
    const c = await app.currentChat();
    const last = c?.items.at(-1);
    return last?.kind === 'assistant' && !last.streaming && last.text && last.id !== after ? c : null;
  });
}

it('questions are rounded bubbles: copy any, and edit or retry the latest', async () => {
  const model = await fakeModelServer('4');
  onTestFinished(() => model.close());
  await answerWith(model.url);
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  await selections(1);
  await waitFor('the panel', () => app.read('panel', `!!document.querySelector('[data-testid=selection] img')`));
  await app.eval('panel', `[...document.querySelectorAll('button.macro')].find((b) => b.textContent === 'Answer').click()`);
  const first = await answered();
  const asked = first.items.at(-2)!;
  expect(asked).toMatchObject({ kind: 'user', text: 'Provide the answer first and the explanation after.' });

  await waitFor('the question in its bubble', () => app.read('panel', `!!document.querySelector('[data-testid=question] .bubble')`));
  expect(await app.read('panel', `getComputedStyle(document.querySelector('[data-testid=question] .bubble')).borderTopLeftRadius`)).toBe('18px');
  expect(await app.read('panel', `document.querySelector('[data-testid=question] .bubble').textContent`)).toBe(asked.text);
  // Copy on the question and on the answer.
  expect(await app.read('panel', `!!document.querySelector('[data-testid=question] [data-testid=copy-question]')`)).toBe(true);
  expect(await app.read('panel', `!!document.querySelector('[data-testid=copy-answer]')`)).toBe(true);

  // Retry: the same question again, in place of it and its answer.
  await app.eval('panel', `document.querySelector('[data-testid=retry]').click()`);
  const again = await answered(first.items.at(-1)!.id);
  expect(again.items.filter((i) => i.kind === 'user').map((i) => i.text)).toEqual([asked.text]);
  expect(again.items.filter((i) => i.kind === 'assistant')).toHaveLength(1);

  // Edit: reworded, it replaces the question and its answer.
  await waitFor('the edit button', () => app.read('panel', `!!document.querySelector('[data-testid=edit]')`));
  await app.eval('panel', `document.querySelector('[data-testid=edit]').click()`);
  await waitFor('the edit box', () => app.read('panel', `!!document.querySelector('.edit-box')`));
  await app.eval(
    'panel',
    `(() => {
      const box = document.querySelector('.edit-box');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Only the answer, please.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
  await app.eval('panel', `document.querySelector('[data-testid=edit-send]').click()`);
  const edited = await answered(again.items.at(-1)!.id);
  expect(edited.items.filter((i) => i.kind === 'user').map((i) => i.text)).toEqual(['Only the answer, please.']);
  expect(edited.items.filter((i) => i.kind === 'assistant')).toHaveLength(1);
  // The selection is still there, carried by the reworded question.
  expect(edited.items.filter((i) => i.kind === 'selection')).toHaveLength(1);
});

it('the new-chat key in the panel finishes the chat and brings the bar up for the next', async () => {
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  const chat = await selections(1);
  await waitFor('the panel', () => app.read('panel', `!!document.querySelector('[data-testid=selection]')`));
  await waiting();

  await app.eval('panel', `dispatchEvent(new KeyboardEvent('keydown', { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true, bubbles: true }))`);
  await armed('box');
  // The old chat is kept in the menu; the panel waits, empty, for the new one.
  expect((await app.storage('local')).chatIndex).toEqual([expect.objectContaining({ id: chat.id })]);
  await waitFor('the empty panel', () => app.read('panel', `!!document.querySelector('[data-testid=empty]')`));
  await box(400, 150, 500, 250);
  const next = await selections(1);
  expect(next.id).not.toBe(chat.id);
});

it('settings place the bar and the panel: the bar at the outer edge of its part, the panel in its corner', async () => {
  await app.eval('core', `browser.runtime.openOptionsPage('selecting')`);
  await waitFor('the place pickers', () => app.read('settings', `!!document.querySelector('[data-testid=place-bar]')`), 20_000);
  expect(await app.read('settings', `document.querySelector('[data-testid=place-bar] [aria-checked=true]').dataset.place`)).toBe('bottom-center');
  expect(await app.read('settings', `document.querySelector('[data-testid=place-panel] [aria-checked=true]').dataset.place`)).toBe('top-right');
  await app.eval('settings', `document.querySelector('[data-testid=place-bar] [data-place=top-left]').click()`);
  await app.eval('settings', `document.querySelector('[data-testid=place-panel] [data-place=bottom-left]').click()`);
  await waitFor('the places saved', async () => {
    const s = (await app.storage('local')).settings as { barPlace?: string; panelPlace?: string } | undefined;
    return s?.barPlace === 'top-left' && s.panelPlace === 'bottom-left';
  });
  await app.eval('settings', 'window.close()');
  await waitFor('settings closed', async () => !(await app.window('settings'))?.visible);

  await app.summon();
  await armed();
  const at = await app.read<{ left: number; top: number }>('overlay', `(() => { const r = ${bar(`querySelector('.bar')`)}.getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);
  expect(at).toEqual({ left: 20, top: 20 });

  await box(400, 150, 500, 250);
  await selections(1);
  const panel = await waitFor('the panel', async () => {
    const w = await app.window('panel');
    return w?.visible && w.width > 0 ? w : null;
  });
  // Bottom left, 12 px in, growing upwards from there.
  expect(panel.x).toBe(12);
  expect(panel.y + panel.height).toBe(SCREEN.height - 12);
});

it('a panel resized by hand keeps that size, opens at it next time, and settings can let it grow again', async () => {
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  await selections(1);
  await waitFor('the panel', () => app.read('panel', `!!document.querySelector('[data-testid=selection] img')`));
  // Settled: the fitter's own resizes are done.
  await new Promise((r) => setTimeout(r, 1500));
  // A resize the panel did not ask for, as the student's dragging an edge is.
  await app.eval('panel', `window.__TAURI_INTERNALS__.invoke('panel_fit', { height: 700, animate: false })`);
  await waitFor('the size kept', async () => ((await app.storage('local')).panelSize as { height?: number } | undefined)?.height === 700);

  await app.eval('panel', 'window.close()');
  await waitFor('the panel hidden', async () => (await app.window('panel'))?.visible === false);
  await app.summon();
  await armed();
  await box(400, 150, 500, 250);
  await selections(1);
  await waitFor('the panel at the kept size', async () => {
    const w = await app.window('panel');
    return w?.visible && w.height === 700;
  });
  await new Promise((r) => setTimeout(r, 1500));
  expect((await app.window('panel'))?.height).toBe(700);

  // Settings say so, and can forget it.
  await app.eval('core', `browser.runtime.openOptionsPage('selecting')`);
  await waitFor('the size in settings', async () => (await app.read<string | null>('settings', `document.querySelector('[data-testid=panel-size]')?.textContent ?? null`))?.includes('420 × 700'), 20_000);
  await app.eval('settings', `document.querySelector('[data-testid=panel-size] button').click()`);
  // Forgotten (WXT's storage removes a key set to null), and the note goes.
  await waitFor('the size forgotten', async () => !('panelSize' in (await app.storage('local'))));
  await waitFor('the note gone', async () => !(await app.read('settings', `!!document.querySelector('[data-testid=panel-size]')`)));
});

it('while the bar waits, the pointer goes through to the app beneath, except on the bar', async () => {
  await app.summon();
  await armed();
  // Armed: the whole display takes the pointer, wherever it is.
  await app.xdo('mousemove', '640', '400');
  await waitFor('the overlay taking the pointer', async () => (await app.overlay()).ignoring === false);
  await box(150, 150, 250, 250);
  const b = await settledBar();

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
  const b = await settledBar();
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

it('Escape while selecting closes everything, as ✕ does: the bar and the panel go, and the chat is finished', async () => {
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  const chat = await selections(1);
  await waiting();
  await app.eval('overlay', bar(`querySelector('.chip[data-kind=box]').click()`));
  await armed('box');
  await app.xdo('mousemove', '640', '300');
  await app.xdo('key', 'Escape');
  await waitFor('the overlay hidden', async () => !(await app.overlay()).visible);
  await waitFor('the panel hidden', async () => (await app.window('panel'))?.visible === false);
  expect((await app.storage('session'))['current:1']).toBeUndefined();
  expect(((await app.storage('local')).chatIndex as { id: string }[]).map((c) => c.id)).toEqual([chat.id]);
});

it('Escape in the panel closes it and the bar too', async () => {
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  await selections(1);
  await waitFor('the panel', () => app.read('panel', `!!document.querySelector('[data-testid=selection]')`));
  await app.eval('panel', `document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor('the panel hidden', async () => (await app.window('panel'))?.visible === false);
  await waitFor('the overlay hidden', async () => !(await app.overlay()).visible);
});

it('while a selection is drawn, only the drawing shows: the bar and the panel step aside, and are back once it is made', async () => {
  await app.summon();
  await armed();
  await box(150, 150, 250, 250);
  await selections(1);
  await waitFor('the panel', async () => (await app.window('panel'))?.visible);
  await waiting();
  await app.eval('overlay', bar(`querySelector('.chip[data-kind=box]').click()`));
  await armed('box');
  const barShows = () => app.read<boolean>('overlay', `getComputedStyle(${bar(`querySelector('.bar')`)}).visibility !== 'hidden'`);
  expect(await barShows()).toBe(true);

  await app.xdo('mousemove', '300', '300', 'mousedown', '1');
  await app.xdo('mousemove', '360', '340');
  await app.xdo('mousemove', '420', '380');
  await waitFor('the bar out of sight', async () => !(await barShows()));
  await waitFor('the panel out of sight', async () => (await app.window('panel'))?.visible === false);

  await app.xdo('mouseup', '1');
  await selections(2);
  await waitFor('the panel back', async () => (await app.window('panel'))?.visible);
  await waitFor('the bar back', barShows);
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
  expect(text).toContain("its window's title, to the AI you picked");
  expect(text).toContain('only your account can read');
  // A development build carries no update key.
  expect(text).toContain("Updates aren't set up in this build");
  expect(text).toContain('Quit Juno');

  // Closed, settings are only hidden: opened again (at a section), they are on screen at once, there.
  await app.eval('settings', `document.querySelector('.page').scrollTo({ top: 400, behavior: 'instant' })`);
  await app.eval('settings', 'window.close()');
  await waitFor('settings hidden', async () => !(await app.window('settings'))?.visible);
  expect(await app.window('settings')).toBeTruthy();
  const asked = Date.now();
  await app.eval('core', `browser.runtime.openOptionsPage('privacy')`);
  await waitFor('settings again', async () => (await app.window('settings'))?.visible, 2_000);
  expect(Date.now() - asked).toBeLessThan(1_000);
  // Below the sticky header, at the top of the window.
  await waitFor('at the section', () =>
    app.read('settings', `(() => { const top = document.getElementById('privacy').getBoundingClientRect().top; return top >= 0 && top < 150; })()`),
  );
  expect(await app.read('settings', 'location.hash')).toBe('#privacy');

  // Left open, settings go when the bar is summoned (the menu bar icon, the
  // shortcut): they come back only from a settings button.
  await app.summon();
  await armed();
  expect((await app.window('settings'))?.visible).toBe(false);
});

it('an API key goes in once and no page can read it back: kept privately, sent by the native core only to its own company', async () => {
  await app.eval('core', `browser.runtime.openOptionsPage('answers')`);
  await waitFor('settings', () => app.read('settings', `!!document.querySelector('[data-testid=answer-key]')`), 20_000);
  await app.eval('settings', `document.querySelector('[data-testid=answer-key] input').click()`);
  await waitFor('the key field', () => app.read('settings', `!!document.querySelector('[data-testid=key-input]')`));
  const type = (text: string) =>
    app.eval(
      'settings',
      `(() => {
        const input = document.querySelector('[data-testid=key-input]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-testid=save-key]').click();
      })()`,
    );
  const saved = () => app.read<string | null>('settings', `document.querySelector('[data-testid=key-saved]')?.textContent ?? null`);
  const key = 'sk-ant-api03-e2e-not-a-real-key-WXYZ';
  await type(key);
  // Told apart by the key itself, and shown back by its last four characters only; nothing on the page holds it.
  await waitFor('the key kept', async () => (await saved()) === 'Anthropic …WXYZ');
  expect(await app.read('settings', `document.documentElement.outerHTML.includes(${JSON.stringify(key)})`)).toBe(false);
  // Checked at once, by the native core: Anthropic turns the made-up key down (or, offline, can't be reached).
  await waitFor('the check', () => app.read('settings', `!!document.querySelector('[data-testid=key-status]')`), 30_000);

  // On disk only in the private secrets file, which only this user can read.
  const secrets = join(app.data, 'com.humanbn.juno', 'store', 'secrets.json');
  expect(readFileSync(secrets, 'utf8')).toContain(key);
  expect(statSync(secrets).mode & 0o777).toBe(0o600);
  // No page can read it: asked for by name, with everything, or straight from the native core.
  const tried = (label: string, js: string) => app.read<string>(label, `${js}.then((v) => JSON.stringify(v), (e) => 'refused: ' + String(e))`);
  for (const label of ['core', 'panel', 'settings', 'overlay']) {
    expect(await tried(label, `browser.storage.local.get('keys')`)).toBe('{}');
    expect(await tried(label, `browser.storage.local.get(null)`)).not.toContain(key);
    expect(await tried(label, `window.__TAURI_INTERNALS__.invoke('storage_get', { area: 'local', keys: ['keys'] })`)).toBe('{}');
  }
  // Nor write or remove it behind settings' back.
  expect(await tried('settings', `browser.storage.local.set({ keys: { anthropic: 'sk-x' } })`)).toMatch(/^refused/);
  expect(await tried('core', `browser.storage.local.remove('keys')`)).toMatch(/^refused/);
  expect(await tried('core', `window.__TAURI_INTERNALS__.invoke('key_set', { key: 'sk-ant-api03-x' })`)).toMatch(/^refused/);
  // Only the core sends with it, and only to ask or list models at the company's own API.
  const send = (label: string, url: string, method = 'GET') =>
    tried(label, `window.__TAURI_INTERNALS__.invoke('vendor_fetch', { vendor: 'anthropic', url: '${url}', method: '${method}', body: null, onBody: '__CHANNEL__:4242' })`);
  expect(await send('settings', 'https://api.anthropic.com/v1/models')).toMatch(/^refused/);
  expect(await send('panel', 'https://api.anthropic.com/v1/models')).toMatch(/^refused/);
  expect(await send('core', 'https://example.com/v1/models')).toMatch(/^refused/);
  expect(await send('core', 'https://api.anthropic.com/v1/files', 'POST')).toMatch(/^refused/);
  expect(await send('core', 'http://api.anthropic.com/v1/models')).toMatch(/^refused/);
  expect(readFileSync(secrets, 'utf8')).toContain(key);

  // An OpenAI key in the same field is kept as OpenAI's, and answers come from OpenAI; the Anthropic one stays, offered.
  const openaiKey = 'sk-proj-e2e-not-a-real-key-1234';
  await app.eval('settings', `document.querySelector('[data-testid=add-key]').click()`);
  await type(openaiKey);
  await waitFor('the OpenAI key kept', async () => (await saved()) === 'OpenAI …1234');
  expect(((await app.storage('local')).settings as { vendor?: string }).vendor).toBe('openai');
  expect(await app.read('settings', `document.querySelector('[data-testid=other-key]').textContent`)).toContain('Anthropic …WXYZ');
  const kept = JSON.parse(readFileSync(secrets, 'utf8')) as { keys: Record<string, string> };
  expect(kept.keys).toEqual({ anthropic: key, openai: openaiKey });
  // An admin key can't answer: refused, and nothing changes.
  await app.eval('settings', `document.querySelector('[data-testid=add-key]').click()`);
  await type('sk-ant-admin01-e2e-x');
  await waitFor('the refusal', async () => (await app.read<string>('settings', `document.querySelector('[data-testid=key-status]')?.textContent ?? ''`)).includes('admin key'));
  expect(JSON.parse(readFileSync(secrets, 'utf8')).keys).toEqual({ anthropic: key, openai: openaiKey });

  // Removed, each is gone from the disk too, and answers move to the one left.
  await app.eval('settings', `document.querySelector('[data-testid=remove-key]').click()`);
  await waitFor('back to Anthropic', async () => (await saved()) === 'Anthropic …WXYZ');
  expect(readFileSync(secrets, 'utf8')).not.toContain(openaiKey);
  await app.eval('settings', `document.querySelector('[data-testid=remove-key]').click()`);
  await waitFor('the field back', async () => (await saved()) === null && (await app.read('settings', `!!document.querySelector('[data-testid=key-input]')`)));
  expect(readFileSync(secrets, 'utf8')).not.toContain(key);
});

it('the app’s windows load only its own pages: a link can’t take the panel to another site', async () => {
  const before = await app.read<string>('panel', 'location.href');
  await app.eval('panel', `location.href = 'https://example.com/'`);
  await new Promise((r) => setTimeout(r, 1500));
  expect(await app.read<string>('panel', 'location.href')).toBe(before);
  // A link inside an SVG is no longer followed in place: even to one of the
  // app's own pages (which the native core would allow), clicking it leaves
  // the panel where it is. (An external one opens the browser instead.)
  await app.eval(
    'panel',
    `(() => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const a = document.createElementNS('http://www.w3.org/2000/svg', 'a');
      a.setAttribute('href', '/web/settings.html');
      a.textContent = 'x';
      svg.append(a);
      document.body.append(svg);
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    })()`,
  );
  await new Promise((r) => setTimeout(r, 1500));
  expect(await app.read<string>('panel', 'location.href')).toBe(before);
});

it('settings open on a dashboard: who you are, this month’s answers and who answers; the settings’ menu comes in once they are reached', async () => {
  await app.eval('core', `browser.runtime.openOptionsPage()`);
  await waitFor('the dashboard', () => app.read('settings', `!!document.querySelector('[data-testid=dashboard]')`), 20_000);
  // Not signed in (this build has no accounts): a guest, with a blank picture.
  expect(await app.read('settings', `document.querySelector('[data-testid=profile-name]').textContent`)).toBe('Guest');
  expect(await app.read('settings', `!!document.querySelector('[data-testid=avatar] svg')`)).toBe(true);
  expect(await app.read('settings', `document.querySelector('[data-testid=answers-this-month]').textContent`)).toBe('0 answers');
  expect(await app.read('settings', `document.querySelector('[data-testid=who-answers]').textContent`)).toContain('No one yet');
  // The settings follow the dashboard, the most used first.
  expect(await app.read('settings', `[...document.querySelectorAll('.sections > section')].map((s) => s.id).slice(0, 5)`)).toEqual([
    'answers',
    'asking',
    'appearance',
    'selecting',
    'privacy',
  ]);
  const shown = () => app.read<boolean>('settings', `document.querySelector('[data-testid=side-menu]').classList.contains('on')`);
  expect(await shown()).toBe(false);
  await app.eval('settings', `document.getElementById('selecting').scrollIntoView({ behavior: 'instant' })`);
  await waitFor('the side menu', shown);
  await app.eval('settings', `document.querySelector('.page').scrollTo({ top: 0, behavior: 'instant' })`);
  await waitFor('the side menu gone', async () => !(await shown()));
});

it('light or dark, as chosen, whatever the system shows; or as the system is', async () => {
  await app.eval('core', `browser.runtime.openOptionsPage('appearance')`);
  await waitFor('the choice', () => app.read('settings', `!!document.querySelector('[data-scheme-choice=dark]')`), 20_000);
  const scheme = (label: string) => app.read<string>(label, 'document.documentElement.dataset.scheme');
  const bg = (label: string) => app.read<string>(label, `getComputedStyle(document.body).backgroundColor`);
  await app.eval('settings', `document.querySelector('[data-scheme-choice=dark]').click()`);
  await waitFor('the panel dark', async () => (await scheme('panel')) === 'dark');
  expect(await scheme('settings')).toBe('dark');
  expect(await bg('panel')).toBe('rgb(34, 29, 26)');
  await app.eval('settings', `document.querySelector('[data-scheme-choice=light]').click()`);
  await waitFor('the panel light', async () => (await scheme('panel')) === 'light');
  expect(await bg('panel')).toBe('rgb(251, 248, 245)');
  await app.eval('settings', `document.querySelector('[data-scheme-choice=system]').click()`);
  await waitFor('as the system is', async () => ((await app.storage('local')).settings as { scheme?: string }).scheme === 'system');
});

it('a theme from settings colours the panel and the bar', async () => {
  await app.eval('core', `browser.runtime.openOptionsPage('appearance')`);
  await waitFor('the themes', () => app.read('settings', `!!document.querySelector('[data-testid=themes]')`), 20_000);
  expect(await app.read('settings', `document.querySelector('[data-testid=themes] [aria-checked=true]').dataset.theme`)).toBe('ember');
  await app.eval('settings', `document.querySelector('[data-theme=ocean]').click()`);
  await waitFor('the theme saved', async () => ((await app.storage('local')).settings as { theme?: string } | undefined)?.theme === 'ocean');
  const accent = (label: string, name: string) => app.read<string>(label, `getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`);
  // The light or the dark palette, whichever the system shows.
  await waitFor('the panel in Ocean', async () => ['#0e7490', '#22b8cf'].includes(await accent('panel', '--accent')));
  expect(['#0e7490', '#22b8cf']).toContain(await accent('settings', '--accent'));
  // The bar is dark in every theme.
  await waitFor('the bar in Ocean', async () => (await accent('overlay', '--sai-bar-bg')) === '#16252d');

  await app.eval('settings', `document.querySelector('[data-theme=ember]').click()`);
  await waitFor('back to Ember', async () => (await accent('panel', '--accent')) !== '#0e7490' && (await accent('panel', '--accent')) !== '#22b8cf');
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
  // The privacy policy and terms are a click away.
  expect(await app.read('settings', `[...document.querySelectorAll('[data-testid=legal] a')].map((a) => a.href)`)).toEqual([
    'https://humanbn.com/privacy',
    'https://humanbn.com/terms',
  ]);

  const dir = join(home, '.config', 'autostart');
  const entries = () => (existsSync(dir) ? readdirSync(dir) : []);
  await app.eval('settings', `document.querySelector('[data-testid=open-at-login]').click()`);
  await waitFor('the autostart entry', () => entries().length === 1);
  expect(readFileSync(join(dir, entries()[0]!), 'utf8')).toContain('--hidden');
  await waitFor('the box ticked', () => app.read('settings', `document.querySelector('[data-testid=open-at-login]').checked`));

  await app.eval('settings', `document.querySelector('[data-testid=open-at-login]').click()`);
  await waitFor('the entry gone', () => entries().length === 0);
});
