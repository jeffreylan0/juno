// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { openWith, sealWith } from '@/lib/sealed';

describe('secrets sealed at rest', () => {
  it('stores ciphertext a content script can read but not use, and opens with the key alone', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const keys = { anthropic: 'sk-ant-secret-123', openai: 'sk-proj-456', session: '' };
    const box = await sealWith(key, keys);
    expect(JSON.stringify(box)).not.toMatch(/sk-ant|sk-proj|secret/);
    expect(await openWith(key, box)).toEqual(keys);

    // A fresh IV every time: the same value never seals the same way twice.
    expect((await sealWith(key, keys)).data).not.toBe(box.data);

    // Another key (or a tampered box) opens nothing.
    const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await expect(openWith(other, box)).rejects.toThrow();
    await expect(openWith(key, { ...box, data: box.data.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) })).rejects.toThrow();
  });
});
