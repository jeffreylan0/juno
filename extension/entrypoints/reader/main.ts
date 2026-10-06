/**
 * PDF reader. The browser's own PDF viewer keeps its text inside a plugin, so
 * a content script sees an empty document and only a screenshot can be sent.
 * Rendering the same file with PDF.js gives a real DOM text layer, which puts
 * text and element selection — and the visible-text extractor — back in play.
 *
 * Pages are placeholders sized from page 1 and rendered as they scroll into
 * view, so a 2,600-page textbook opens as fast as a one-page worksheet.
 */
// The legacy build, not the default one: pdf.js 6 calls Map.getOrInsertComputed,
// which only very recent engines have. Shipping legacy keeps the reader working
// on the Chrome, Edge and Firefox versions students actually run.
import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { BRAND } from '@/brand';
import { SelectionController } from '@/lib/selection-controller';
import { send, type BarControlMsg } from '@/lib/messages';
import 'pdfjs-dist/web/pdf_viewer.css';
import './reader.css';

GlobalWorkerOptions.workerPort = new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url), {
  type: 'module',
});

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];
/** Pages kept rendered outside the viewport, each way. */
const RENDER_MARGIN_PX = 1200;

const els = {
  viewer: document.getElementById('viewer') as HTMLElement,
  file: document.getElementById('file') as HTMLElement,
  page: document.getElementById('page') as HTMLInputElement,
  pages: document.getElementById('pages') as HTMLElement,
  prev: document.getElementById('prev') as HTMLButtonElement,
  next: document.getElementById('next') as HTMLButtonElement,
  zoomIn: document.getElementById('in') as HTMLButtonElement,
  zoomOut: document.getElementById('out') as HTMLButtonElement,
  zoom: document.getElementById('zoom') as HTMLElement,
  status: document.getElementById('status') as HTMLElement,
};

let doc: PDFDocumentProxy | null = null;
let scale = 1;
let basePage: { width: number; height: number } = { width: 612, height: 792 };
const frames = new Map<number, HTMLElement>();
const rendered = new Set<number>();
const rendering = new Set<number>();

/** Shows a status line. Built from nodes, so an error message can never be read as markup. */
function status(content: string | (string | Node)[], isError = false): void {
  els.status.replaceChildren(...(typeof content === 'string' ? [content] : content));
  els.status.hidden = false;
  els.status.classList.toggle('error', isError);
}

function h(tag: string, ...children: (string | Node)[]): HTMLElement {
  const el = document.createElement(tag);
  el.append(...children);
  return el;
}

function clearStatus(): void {
  els.status.hidden = true;
}

function fileParam(): string | null {
  return new URL(location.href).searchParams.get('file');
}

async function main(): Promise<void> {
  const brand = document.querySelector('.brand');
  if (brand) brand.textContent = `${BRAND.shortName} reader`;
  const url = fileParam();
  if (!url) return status('No PDF to open here.', true);
  els.file.textContent = decodeURIComponent(url.split('/').pop() ?? url);
  document.title = `${els.file.textContent} — ${BRAND.shortName} reader`;

  status('Opening…');
  try {
    doc = await getDocument({
      url,
      cMapUrl: browser.runtime.getURL('/pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: browser.runtime.getURL('/pdfjs/standard_fonts/'),
      wasmUrl: browser.runtime.getURL('/pdfjs/wasm/'),
    }).promise;
  } catch (err) {
    return failed(url, err as Error);
  }

  els.pages.textContent = String(doc.numPages);
  els.page.max = String(doc.numPages);
  const first = await doc.getPage(1);
  const v = first.getViewport({ scale: 1 });
  basePage = { width: v.width, height: v.height };

  layout();
  clearStatus();

  const startPage = Number(new URL(location.href).hash.match(/page=(\d+)/)?.[1] ?? 1);
  if (startPage > 1) goTo(startPage);
}

function failed(url: string, err: Error): void {
  const fileUrl = url.startsWith('file://');
  const detail = [h('br'), h('br'), h('small', err.message)];
  if (fileUrl) {
    status(
      [
        'To open files on your computer, go to ',
        h('code', 'chrome://extensions'),
        `, find ${BRAND.name}, turn on `,
        h('b', 'Allow access to file URLs'),
        ', and reload.',
        ...detail,
      ],
      true,
    );
    return;
  }
  status(["Couldn't open this PDF.", ...detail], true);
}

/** Builds (or resizes) one placeholder per page at the current scale. */
function layout(): void {
  if (!doc) return;
  const width = Math.round(basePage.width * scale);
  const height = Math.round(basePage.height * scale);
  els.zoom.textContent = `${Math.round(scale * 100)}%`;

  for (let n = 1; n <= doc.numPages; n++) {
    let frame = frames.get(n);
    if (!frame) {
      frame = document.createElement('div');
      frame.className = 'page';
      frame.dataset.page = String(n);
      const placeholder = document.createElement('div');
      placeholder.className = 'placeholder';
      placeholder.textContent = `Page ${n}`;
      frame.append(placeholder);
      els.viewer.append(frame);
      frames.set(n, frame);
    }
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
  }
  rendered.clear();
  for (const frame of frames.values()) frame.querySelectorAll('canvas, .textLayer').forEach((n) => n.remove());
  renderVisible();
}

/** Renders every page whose frame is near the viewport. */
function renderVisible(): void {
  if (!doc) return;
  const top = els.viewer.scrollTop - RENDER_MARGIN_PX;
  const bottom = els.viewer.scrollTop + els.viewer.clientHeight + RENDER_MARGIN_PX;
  for (const [n, frame] of frames) {
    const frameTop = frame.offsetTop;
    const frameBottom = frameTop + frame.offsetHeight;
    const near = frameBottom >= top && frameTop <= bottom;
    if (near && !rendered.has(n) && !rendering.has(n)) void renderPage(n, frame);
    else if (!near && rendered.has(n)) {
      // Drop far-away pages so a long book does not grow without bound.
      frame.querySelectorAll('canvas, .textLayer').forEach((node) => node.remove());
      rendered.delete(n);
    }
  }
  updateCurrentPage();
}

async function renderPage(n: number, frame: HTMLElement): Promise<void> {
  if (!doc) return;
  rendering.add(n);
  try {
    const page: PDFPageProxy = await doc.getPage(n);
    const viewport = page.getViewport({ scale });
    // Page sizes can vary; trust the real one once we have it.
    frame.style.width = `${Math.round(viewport.width)}px`;
    frame.style.height = `${Math.round(viewport.height)}px`;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    frame.prepend(canvas);

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    const layer = document.createElement('div');
    layer.className = 'textLayer';
    // pdf_viewer.css positions every span against this factor.
    layer.style.setProperty('--scale-factor', String(scale));
    layer.style.setProperty('--total-scale-factor', String(scale));
    frame.append(layer);
    const textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
    await textLayer.render();

    frame.querySelector('.placeholder')?.remove();
    rendered.add(n);
  } catch (err) {
    console.warn('[selection-ai] page render failed', n, err);
  } finally {
    rendering.delete(n);
  }
}

function updateCurrentPage(): void {
  const mid = els.viewer.scrollTop + els.viewer.clientHeight / 2;
  for (const [n, frame] of frames) {
    if (frame.offsetTop <= mid && frame.offsetTop + frame.offsetHeight >= mid) {
      if (document.activeElement !== els.page) els.page.value = String(n);
      return;
    }
  }
}

function goTo(n: number): void {
  const frame = frames.get(Math.max(1, Math.min(n, doc?.numPages ?? 1)));
  if (frame) els.viewer.scrollTo({ top: frame.offsetTop - 8 });
}

function zoom(delta: number): void {
  const i = ZOOMS.indexOf(scale);
  const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i === -1 ? 3 : i) + delta))]!;
  if (next === scale) return;
  const anchor = Number(els.page.value) || 1;
  scale = next;
  layout();
  goTo(anchor);
}

let scrollTimer: ReturnType<typeof setTimeout> | null = null;
els.viewer.addEventListener('scroll', () => {
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(renderVisible, 80);
  updateCurrentPage();
});
window.addEventListener('resize', () => renderVisible());
els.prev.addEventListener('click', () => goTo(Number(els.page.value) - 1));
els.next.addEventListener('click', () => goTo(Number(els.page.value) + 1));
els.page.addEventListener('change', () => goTo(Number(els.page.value)));
els.zoomIn.addEventListener('click', () => zoom(1));
els.zoomOut.addEventListener('click', () => zoom(-1));

/**
 * Selection runs here in-page rather than through a content script, because
 * Chrome refuses to inject one into an extension page. The background cannot
 * use tabs.sendMessage for the same reason, so it broadcasts with our tab id
 * attached and we answer only to our own.
 */
const controller = new SelectionController();
void (async () => {
  // The hello both registers this tab with the background and tells us our own
  // id, which an extension page cannot learn without the tabs permission.
  const reply = await send<{ tabId?: number }>({ type: 'reader:hello' });
  const selfTabId = reply?.tabId;
  browser.runtime.onMessage.addListener((raw: unknown) => {
    const msg = raw as { type?: string; tabId?: number };
    // Messages for a reader are addressed to one tab; anything else is not ours.
    if (msg?.tabId === undefined || msg.tabId !== selfTabId) return;
    if (msg.type === 'panel:needs-click') controller.promptForPanel();
    else if (msg.type?.startsWith('bar:')) controller.handle(raw as BarControlMsg);
  });
})();

void main();
