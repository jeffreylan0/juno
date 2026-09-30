/**
 * Screenshot the visible tab and crop a CSS-pixel rectangle out of it.
 * captureVisibleTab returns device pixels, so rectangles are scaled by
 * devicePixelRatio before cropping on an OffscreenCanvas (available in MV3
 * service workers and Firefox background scripts).
 */
import { browser } from 'wxt/browser';
import type { Point, Rect } from '@shared/payload';

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Converts a CSS-pixel viewport rect to device pixels and clamps it to the
 * captured image. Pure, so it is unit-tested on its own.
 */
export function toDeviceRect(rect: Rect, dpr: number, image: { width: number; height: number }): PixelRect {
  const x0 = Math.max(0, Math.floor(rect.x * dpr));
  const y0 = Math.max(0, Math.floor(rect.y * dpr));
  const x1 = Math.min(image.width, Math.ceil((rect.x + rect.width) * dpr));
  const y1 = Math.min(image.height, Math.ceil((rect.y + rect.height) * dpr));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Longest edge we send to a model; larger crops are downscaled to save tokens. */
export const MAX_EDGE = 1568;

export function fitWithin(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const s = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export interface CaptureResult {
  dataUrl: string;
  width: number;
  height: number;
}

async function dataUrlToBitmap(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

/**
 * Maps a freeform outline from viewport CSS pixels into the output canvas:
 * scale to device pixels, shift to the crop's origin, then scale to the
 * (possibly downsized) output. Pure, so it is unit-tested on its own.
 */
export function pathToCrop(path: Point[], dpr: number, src: PixelRect, out: { width: number; height: number }): Point[] {
  const sx = out.width / src.width;
  const sy = out.height / src.height;
  return path.map((p) => ({ x: (p.x * dpr - src.x) * sx, y: (p.y * dpr - src.y) * sy }));
}

/**
 * Crops a data-URL screenshot to `rect` (CSS px) at `dpr`; returns PNG data URL.
 * With a freeform `path`, everything outside the outline is painted white, so
 * only what the student drew around reaches the model. White rather than
 * transparent: some models render transparency as black.
 */
export async function cropDataUrl(dataUrl: string, rect: Rect, dpr: number, path?: Point[]): Promise<CaptureResult> {
  const bitmap = await dataUrlToBitmap(dataUrl);
  try {
    const src = toDeviceRect(rect, dpr, bitmap);
    if (src.width === 0 || src.height === 0) throw new Error('Selection is empty after clamping to the viewport');
    const out = fitWithin(src.width, src.height);
    const canvas = new OffscreenCanvas(out.width, out.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    if (path && path.length >= 3) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, out.width, out.height);
      const pts = pathToCrop(path, dpr, src, out);
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.clip();
    }
    ctx.drawImage(bitmap, src.x, src.y, src.width, src.height, 0, 0, out.width, out.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { dataUrl: await blobToDataUrl(blob), width: out.width, height: out.height };
  } finally {
    bitmap.close();
  }
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return `data:${blob.type};base64,${btoa(bin)}`;
}

/** A screenshot of what the active tab in `windowId` shows, as a PNG data URL. Requires activeTab. */
export async function captureVisible(windowId: number): Promise<string> {
  return await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
}
