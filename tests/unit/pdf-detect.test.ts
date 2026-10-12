import { describe, expect, it } from 'vitest';
import { detectPdf, readerUrlFor } from '@/lib/pdf-detect';

/** A stand-in for the minimal document Chrome wraps its PDF plugin in. */
function pdfDoc(_url: string): Document {
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML = '<embed type="application/pdf" src="about:blank">';
  Object.defineProperty(doc, 'contentType', { value: 'application/pdf', configurable: true });
  return doc;
}

function htmlDoc(_url: string): Document {
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML = '<p>ordinary page</p>';
  Object.defineProperty(doc, 'contentType', { value: 'text/html', configurable: true });
  return doc;
}

describe('detectPdf', () => {
  it('recognises a browser PDF viewer, local or not', () => {
    expect(detectPdf(pdfDoc(''), 'file:///Users/x/Downloads/organic.pdf')).toEqual({ isPdf: true, url: 'file:///Users/x/Downloads/organic.pdf' });
    expect(detectPdf(pdfDoc(''), 'https://example.edu/ch1.pdf').isPdf).toBe(true);
  });

  it('leaves ordinary pages alone, including ones with .pdf in the URL', () => {
    expect(detectPdf(htmlDoc(''), 'https://example.com/page').isPdf).toBe(false);
    expect(detectPdf(htmlDoc(''), 'https://example.com/about-pdf.html?q=x.pdf').isPdf).toBe(false);
  });
});

describe('readerUrlFor', () => {
  it('passes the original file through as an encoded parameter', () => {
    const url = readerUrlFor('file:///Users/x/My Book.pdf', (p) => `chrome-extension://abc/${p}`);
    expect(url).toBe('chrome-extension://abc/reader.html?file=file%3A%2F%2F%2FUsers%2Fx%2FMy%20Book.pdf');
    expect(new URL(url).searchParams.get('file')).toBe('file:///Users/x/My Book.pdf');
  });
});
