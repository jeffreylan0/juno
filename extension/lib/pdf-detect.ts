/**
 * Chrome, Edge and Firefox all render PDFs with a built-in viewer whose text
 * lives inside a plugin rather than the DOM. `document.getSelection()` comes
 * back empty there and mouse events never reach a content script, so text and
 * element selection cannot work — only a screenshot can.
 *
 * `reader.html` re-renders the same file with PDF.js and a real text layer,
 * which puts every mode back on the table.
 */

import type { SelectionKind } from '@shared/payload';

export interface PdfContext {
  /** True when the current document is a browser PDF viewer. */
  isPdf: boolean;
  /** The PDF's own URL, for handing to the reader. */
  url: string;
  /** file:// PDFs need "Allow access to file URLs" before the reader can read them. */
  isFile: boolean;
}

export function detectPdf(doc: Document = document, href?: string): PdfContext {
  // The URL is a parameter because a detached document has no usable location,
  // and because callers always know it anyway.
  const url = href ?? doc.location?.href ?? location.href;
  const byType = doc.contentType === 'application/pdf';
  // Chrome wraps the plugin in a minimal document with a single full-page embed.
  const embed = doc.querySelector<HTMLEmbedElement>('embed[type="application/pdf"]');
  const byEmbed = !!embed && doc.body?.children.length === 1;
  const byExtension = /\.pdf(?:[?#]|$)/i.test(url);
  return {
    isPdf: byType || byEmbed || (byExtension && !!embed),
    url,
    isFile: url.startsWith('file://'),
  };
}

/**
 * Modes that actually work on the current document. In the browser's PDF
 * viewer only screenshot-based modes do: box and freeform. Text and element
 * both need a DOM, which the plugin does not have.
 */
export function availableModes(pdf: PdfContext): SelectionKind[] {
  return pdf.isPdf ? ['box', 'freeform'] : ['box', 'text', 'element', 'freeform'];
}

export function readerUrlFor(pdfUrl: string, runtimeUrl: (path: string) => string): string {
  return `${runtimeUrl('reader.html')}?file=${encodeURIComponent(pdfUrl)}`;
}
