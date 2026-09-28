import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { Plan } from '@shared/payload';
import { chatKey, getThread, historyOf, parseKey, saveChat, selKey, setThreadMode, startThread, clearThread, type Turn } from '@/lib/threads';

function plan(id: string, text = 'F = ma'): Plan {
  return {
    id,
    createdAt: 0,
    mode: 'explain',
    parts: [{ kind: 'text', text }],
    selection: { kind: 'text', rect: { x: 0, y: 0, width: 10, height: 10 }, devicePixelRatio: 1 },
    page: { url: 'https://example.test/', title: 'Example' },
    route: 'small',
    estimatedTokens: 5,
  };
}

const turn = (role: Turn['role'], text: string, over: Partial<Turn> = {}): Turn => ({ id: `${role}-${text}`, role, text, ...over });

beforeEach(() => fakeBrowser.reset());

describe('per-tab threads', () => {
  it('keeps each tab to its own selection and conversation', async () => {
    await startThread(1, plan('a', 'textbook'));
    await startThread(2, plan('b', 'paper'));
    const one = await getThread(1);
    const two = await getThread(2);
    expect(one.plan?.id).toBe('a');
    expect(two.plan?.id).toBe('b');
    expect(one.chat?.turns).toEqual([]);

    await saveChat(1, { ...one.chat!, turns: [turn('user', 'Q'), turn('assistant', 'A')] });
    expect((await getThread(1)).chat?.turns).toHaveLength(2);
    expect((await getThread(2)).chat?.turns).toHaveLength(0);
  });

  it('starts a fresh conversation when the tab gets a new selection', async () => {
    const first = await startThread(1, plan('a'));
    await saveChat(1, { ...first.chat!, turns: [turn('user', 'Q'), turn('assistant', 'A')] });
    await startThread(1, plan('b'));
    const t = await getThread(1);
    expect(t.plan?.id).toBe('b');
    expect(t.chat?.planId).toBe('b');
    expect(t.chat?.turns).toEqual([]);
  });

  it('stores the selection and the conversation under separate keys', async () => {
    await startThread(7, plan('a'));
    const all = await browser.storage.session.get(null);
    expect(Object.keys(all).sort()).toEqual([chatKey(7), selKey(7)].sort());
    // Nothing goes to local storage, which survives a browser restart.
    expect(await browser.storage.local.get(null)).toEqual({});
  });

  it('remembers a mode switch and forgets a closed tab', async () => {
    await startThread(3, plan('a'));
    await setThreadMode(3, 'hint');
    expect((await getThread(3)).chat?.mode).toBe('hint');
    await clearThread(3);
    expect(await getThread(3)).toEqual({ tabId: 3, plan: null, chat: null });
  });

  it('parses its own keys and nothing else', () => {
    expect(parseKey('sel:12')).toEqual({ kind: 'sel', tabId: 12 });
    expect(parseKey('chat:3')).toEqual({ kind: 'chat', tabId: 3 });
    expect(parseKey('cache:abc')).toBeNull();
  });
});

describe('historyOf', () => {
  it('passes complete question-and-answer pairs through in order', () => {
    const h = historyOf([turn('user', 'Q1'), turn('assistant', 'A1'), turn('user', 'Q2'), turn('assistant', 'A2')]);
    expect(h).toEqual([
      { role: 'user', text: 'Q1' },
      { role: 'assistant', text: 'A1' },
      { role: 'user', text: 'Q2' },
      { role: 'assistant', text: 'A2' },
    ]);
  });

  it('drops a failed, empty or still-streaming answer together with its question', () => {
    const h = historyOf([
      turn('user', 'Q1'),
      turn('assistant', '', { error: 'No key' }),
      turn('user', 'Q2'),
      turn('assistant', 'A2'),
      turn('user', 'Q3'),
      turn('assistant', '   '),
      turn('user', 'Q4'),
      turn('assistant', 'partial', { streaming: true }),
    ]);
    expect(h).toEqual([
      { role: 'user', text: 'Q2' },
      { role: 'assistant', text: 'A2' },
    ]);
  });

  it('always alternates roles, starting with the student', () => {
    const h = historyOf([turn('assistant', 'stray'), turn('user', 'Q1'), turn('user', 'Q2'), turn('assistant', 'A2'), turn('user', 'dangling')]);
    expect(h.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(h[0]!.text).toBe('Q2');
  });

  it('keeps a stopped answer that had text, since the student saw it', () => {
    const h = historyOf([turn('user', 'Q1'), turn('assistant', 'half an answer')]);
    expect(h).toHaveLength(2);
  });
});
