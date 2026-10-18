/**
 * The page's side of the key vault (desktop/src/platform/vault.ts): a
 * request with a key goes to the native core with no key in it, and its
 * answer streams back as an ordinary Response.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Message = ArrayBuffer | Record<string, unknown>;
const calls: { command: string; args: Record<string, unknown> }[] = [];
/** What the native core sends back to the request under way. */
let reply: (send: (m: Message) => void) => void = () => {};

// The app's own copy (the tests' root has none).
vi.mock('../../desktop/node_modules/@tauri-apps/api/core.js', () => {
  let next = 1;
  class Channel {
    id = next++;
    onmessage: (m: Message) => void = () => {};
  }
  return {
    Channel,
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      if (command === 'vendor_fetch') {
        const channel = args.onBody as Channel;
        setTimeout(() => reply((m) => channel.onmessage(m)));
      }
      if (command === 'key_status') return { anthropic: '…WXYZ', openai: null };
    },
  };
});
vi.mock('../../desktop/node_modules/@tauri-apps/api/webviewWindow.js', () => ({ getCurrentWebviewWindow: () => ({ listen: async () => () => {} }) }));

const { nativeVault } = await import('@/platform/vault');
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

beforeEach(() => {
  calls.length = 0;
});

describe('the vault, from a page', () => {
  it('sends the request without any key, and streams the answer back', async () => {
    reply = (send) => {
      send({ status: 200, headers: [['content-type', 'text/event-stream']] });
      send(bytes('data: one\n\n'));
      send(bytes('data: two\n\n'));
      send({ done: true });
    };
    const res = await nativeVault.fetch('anthropic', 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"m"}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: one\n\ndata: two\n\n');
    const sent = calls.find((c) => c.command === 'vendor_fetch')!.args;
    expect(sent).toMatchObject({ vendor: 'anthropic', url: 'https://api.anthropic.com/v1/messages', method: 'POST', body: '{"model":"m"}' });
    // Nothing that could carry a key: no headers at all.
    expect(Object.keys(sent).sort()).toEqual(['body', 'method', 'onBody', 'url', 'vendor']);
  });

  it('says what the company said, status and all', async () => {
    reply = (send) => {
      send({ status: 401, headers: [['request-id', 'req_1']] });
      send(bytes('{"error":{"type":"authentication_error"}}'));
      send({ done: true });
    };
    const res = await nativeVault.fetch('openai', 'https://api.openai.com/v1/models', {});
    expect(res.status).toBe(401);
    expect(res.headers.get('request-id')).toBe('req_1');
    expect(await res.json()).toEqual({ error: { type: 'authentication_error' } });
  });

  it('fails like fetch when the request does', async () => {
    reply = (send) => send({ error: "The request couldn't connect." });
    await expect(nativeVault.fetch('openai', 'https://api.openai.com/v1/models', {})).rejects.toThrow(TypeError);
  });

  it('stops the request when asked to', async () => {
    reply = () => {};
    const stop = new AbortController();
    const asked = nativeVault.fetch('anthropic', 'https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}', signal: stop.signal });
    stop.abort();
    await expect(asked).rejects.toMatchObject({ name: 'AbortError' });
    const id = (calls.find((c) => c.command === 'vendor_fetch')!.args.onBody as { id: number }).id;
    expect(calls).toContainEqual({ command: 'vendor_fetch_cancel', args: { id } });
  });

  it('knows a key only by its last four characters', async () => {
    expect(await nativeVault.status()).toEqual({ anthropic: '…WXYZ', openai: null });
  });
});
