import { BadRequest } from './models';

/**
 * The body as text, refused past `max` bytes whatever Content-Length says
 * (a chunked body has none): read in pieces, never buffered whole first.
 */
export async function readBody(request: Request, max: number, tooBig = 'That request is too large.'): Promise<string> {
  const refuse = () => new BadRequest(tooBig, 413, 'too-large');
  if (Number(request.headers.get('content-length') ?? 0) > max) throw refuse();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw refuse();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
