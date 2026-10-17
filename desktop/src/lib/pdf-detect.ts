/**
 * Chrome, Edge and Firefox all render PDFs with a built-in viewer, a plugin
 * whose scrolling a content script cannot reach: the overlay's surface would
 * freeze the page while a selection is armed. `reader.html` re-renders the
 * same file with PDF.js, which scrolls while selecting.
 */

export interface PdfContext {
  /** True when the current document is a browser PDF viewer. */
  isPdf: boolean;
  /** The PDF's own URL, for handing to the reader. */
  url: string;
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
  };
}

export function readerUrlFor(pdfUrl: string, runtimeUrl: (path: string) => string): string {
  return `${runtimeUrl('reader.html')}?file=${encodeURIComponent(pdfUrl)}`;
}
