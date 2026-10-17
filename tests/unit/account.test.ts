/**
 * Accounts and cloud copies, against the fake Supabase in tests/support:
 * signing in with an email code, staying signed in, and chats (with their
 * screenshots) going up and coming down, the newer version winning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from '@webext-core/fake-browser';
import type { Plan } from '@shared/payload';
import { FakeSupabase } from '../support/fake-supabase';
import {
  currentSession,
  entitlementItem,
  refreshEntitlement,
  sendEmailCode,
  sessionItem,
  signInWithGoogle,
  signOut,
  syncStatusItem,
  verifyEmailCode,
} from '@/lib/account/session';
import { deleteAccount } from '@/lib/account/cloud';
import { ChatSync, imageIdsOf } from '@/lib/account/sync';
import {
  deleteAllChats,
  deleteChat,
  getChat,
  listChats,
  newChat,
  renameChat,
  saveChat,
  versionOf,
  withSelection,
  type Chat,
  type SelectionItem,
} from '@/lib/chats';
import { MemoryImageStore, setImageStore, storePlanImages } from '@/lib/images';
import { DEFAULT_SETTINGS, settingsItem } from '@/lib/storage';

const realFetch = globalThis.fetch;
let fake: FakeSupabase;
let store: MemoryImageStore;
let sync: ChatSync | null = null;
const gone: string[] = [];

beforeEach(() => {
  fakeBrowser.reset();
  store = new MemoryImageStore();
  setImageStore(store);
  fake = new FakeSupabase();
  gone.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return req.url.startsWith(fake.url) ? await fake.handle(req) : await realFetch(input, init);
  });
});

afterEach(() => {
  sync?.stop();
  sync = null;
  vi.unstubAllGlobals();
});

/** Lets storage events and the listeners they start run. */
const settle = () => new Promise((r) => setTimeout(r, 20));

async function signIn(email: string) {
  await sendEmailCode(email);
  return await verifyEmailCode(email, fake.codes.get(email)!);
}

function startSync(): ChatSync {
  sync = new ChatSync({ serial: (fn) => fn(), gone: async (ids) => void gone.push(...ids) }).start();
  return sync;
}

const png = (id: string) => `data:image/png;base64,${btoa(`png-${id}`)}`;

function plan(id: string, image = false): Plan {
  return {
    id,
    createdAt: 0,
    mode: 'ask',
    parts: image ? [{ kind: 'image', dataUrl: png(id), width: 4, height: 2, reason: 'user' }] : [{ kind: 'text', text: `text ${id}` }],
    selection: { kind: image ? 'box' : 'text', rect: { x: 0, y: 0, width: 10, height: 10 }, devicePixelRatio: 1 },
    page: { url: `https://example.test/${id}`, title: `Page ${id}` },
    route: 'small',
    estimatedTokens: 5,
  };
}

/** A saved chat with one selection (a screenshot if `image`). */
async function chatWith(id: string, image = false, temporary = false): Promise<Chat> {
  const chat = newChat(temporary, id);
  const stored = await storePlanImages(plan(id, image), chat.id, temporary);
  const item: SelectionItem = { kind: 'selection', id: `s-${id}`, at: 1, plan: stored };
  return (await saveChat(withSelection(chat, item))).chat;
}

describe('signing in', () => {
  it('signs in with an emailed code, and says so plainly when the code is wrong', async () => {
    await sendEmailCode('Student@Example.com');
    await expect(verifyEmailCode('student@example.com', '000000')).rejects.toThrow("That code didn't work");
    const s = await verifyEmailCode('student@example.com', fake.codes.get('student@example.com')!);
    expect(s.user.email).toBe('student@example.com');
    expect((await sessionItem.getValue())?.accessToken).toBe(s.accessToken);
  });

  it('signs in with Google through the browser’s own window (PKCE), back on the extension’s redirect URL', async () => {
    const redirect = 'https://bipacelfiohnnmfkhfhkjblblkediabm.chromiumapp.org/';
    const identity = {
      getRedirectURL: () => redirect,
      launchWebAuthFlow: vi.fn(async ({ url, interactive }: { url: string; interactive: boolean }) => {
        const u = new URL(url);
        expect(interactive).toBe(true);
        expect(`${u.origin}${u.pathname}`).toBe(`${fake.url}/auth/v1/authorize`);
        expect(u.searchParams.get('provider')).toBe('google');
        expect(u.searchParams.get('redirect_to')).toBe(redirect);
        expect(u.searchParams.get('code_challenge_method')).toBe('s256');
        fake.pkce.set('code-1', { challenge: u.searchParams.get('code_challenge')!, email: 'g@example.com' });
        return `${redirect}?code=code-1`;
      }),
    };
    (fakeBrowser as unknown as { identity: typeof identity }).identity = identity;
    const s = await signInWithGoogle();
    expect(s.user.email).toBe('g@example.com');
    expect(identity.launchWebAuthFlow).toHaveBeenCalledOnce();

    // Closing Google's window is not an error worth more than a sentence.
    identity.launchWebAuthFlow.mockRejectedValueOnce(new Error('The user did not approve access.'));
    await expect(signInWithGoogle()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('refuses an address that is not one before asking the server', async () => {
    await expect(sendEmailCode('not-an-email')).rejects.toThrow("doesn't look right");
    expect(fake.log).toEqual([]);
  });

  it('refreshes a token about to run out, and a token the server turns down', async () => {
    const first = await signIn('a@example.com');
    await sessionItem.setValue({ ...first, expiresAt: Date.now() + 1000 }); // nearly out
    const next = await currentSession();
    expect(next?.accessToken).not.toBe(first.accessToken);

    fake.entitle('a@example.com', { cloud: true });
    fake.expireAccessTokens(); // the server says no before our clock does
    const ent = await refreshEntitlement();
    expect(ent?.cloud).toBe(true);
    expect((await sessionItem.getValue())?.accessToken).not.toBe(next?.accessToken);
  });

  it('is signed out here when the server has ended the session', async () => {
    const s = await signIn('a@example.com');
    fake.refresh.clear();
    await sessionItem.setValue({ ...s, expiresAt: 0 });
    expect(await currentSession()).toBeNull();
    expect(await sessionItem.getValue()).toBeNull();
  });

  it('signing out forgets the session and what the account may use', async () => {
    await signIn('a@example.com');
    fake.entitle('a@example.com', { cloud: true });
    await refreshEntitlement();
    await signOut();
    expect(await sessionItem.getValue()).toBeNull();
    expect(await entitlementItem.getValue()).toBeNull();
  });
});

describe('cloud copies', () => {
  async function ready(email = 'a@example.com') {
    const s = await signIn(email);
    fake.entitle(email, { cloud: true });
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, cloudSync: true });
    return s.user.id;
  }

  it('does nothing until the account has cloud storage and the student turns it on', async () => {
    await chatWith('one');
    await signIn('a@example.com');
    const s = startSync();
    await s.now();
    expect(await syncStatusItem.getValue()).toEqual({ state: 'off' }); // not turned on
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, cloudSync: true });
    await s.now();
    expect((await syncStatusItem.getValue()).state).toBe('not-allowed'); // turned on, not given
    expect(fake.chats).toEqual([]);
  });

  it('uploads this computer’s chats and screenshots, but never a temporary chat', async () => {
    const one = await chatWith('one', true);
    await chatWith('two');
    const temp = await chatWith('ghost', true, true);
    const uid = await ready();
    await startSync().now();

    expect(fake.chats.map((r) => r.id).sort()).toEqual(['one', 'two']);
    expect(fake.row(uid, 'one')?.updated_ms).toBe(versionOf(one));
    const [img] = imageIdsOf(one);
    expect([...fake.objects.keys()]).toEqual([`${uid}/one/${img}`]);
    expect(fake.row(uid, temp.id)).toBeUndefined();
    expect((await syncStatusItem.getValue()).state).toBe('ok');
  });

  it('takes newer chats from the cloud, with their screenshots, and keeps its own newer ones', async () => {
    const mine = await chatWith('mine');
    const uid = await ready();
    const s = startSync();
    await s.now();

    // Another computer: renames "mine" (older than what we have? no — newer), adds "theirs" with a screenshot.
    const theirs = { ...newChat(false, 'theirs'), title: 'From the laptop', updatedAt: Date.now(), items: [] as Chat['items'] };
    const shot = png('theirs');
    fake.objects.set(`${uid}/theirs/img-1`, { type: 'image/png', bytes: Uint8Array.from(atob(shot.split(',')[1]!), (c) => c.charCodeAt(0)) });
    theirs.items = [{ kind: 'selection', id: 's1', at: 1, plan: { ...plan('theirs', true), parts: [{ kind: 'image', dataUrl: 'idb:img-1', width: 4, height: 2, reason: 'user' }] } }];
    fake.put(uid, 'theirs', Date.now() + 5, theirs);
    fake.put(uid, 'mine', versionOf(mine) - 10, { ...mine, title: 'stale' }); // older: ignored
    await s.now();

    expect((await getChat('theirs'))?.title).toBe('From the laptop');
    expect((await store.get('img-1'))?.dataUrl).toBe(shot);
    expect((await getChat('mine'))?.title).toBe(mine.title);
    expect((await listChats()).map((c) => c.id).sort()).toEqual(['mine', 'theirs']);
  });

  it('sends changes made here, and deletes go everywhere (tombstones), screenshots too', async () => {
    const one = await chatWith('one', true);
    await chatWith('two');
    const uid = await ready();
    const s = startSync();
    await s.now();

    await renameChat('two', 'Renamed here');
    await settle();
    await s.now();
    expect((fake.row(uid, 'two')?.data as Chat).title).toBe('Renamed here');

    await deleteChat(one.id);
    await settle();
    await s.now();
    expect(fake.row(uid, 'one')).toMatchObject({ deleted: true, data: null });
    expect(fake.objects.size).toBe(0);
  });

  it('deletes a chat another computer deleted, and tells the windows showing it', async () => {
    await chatWith('one');
    const uid = await ready();
    const s = startSync();
    await s.now();
    fake.put(uid, 'one', Date.now() + 1000, null, true);
    await s.now();
    expect(await getChat('one')).toBeNull();
    expect(gone).toEqual(['one']);
  });

  it('the limit only drops chats from this computer: the cloud keeps them, and does not send old ones back', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, chatLimit: 10 });
    for (let i = 0; i < 10; i++) await chatWith(`c${i}`);
    const uid = await ready();
    await settingsItem.setValue({ ...(await settingsItem.getValue()), chatLimit: 10, cloudSync: true });
    const s = startSync();
    await s.now();
    const before = (await listChats()).map((c) => c.id);
    await chatWith('c10'); // drops the oldest here
    await settle();
    await s.now();
    const after = (await listChats()).map((c) => c.id);
    const dropped = before.filter((id) => !after.includes(id));
    expect(dropped).toHaveLength(1);
    expect(fake.row(uid, dropped[0]!)?.deleted).toBe(false); // still in the account
    expect(fake.row(uid, 'c10')).toBeDefined();

    // An old chat from elsewhere, older than all ten kept: not downloaded.
    fake.put(uid, 'ancient', 1, { ...newChat(false, 'ancient'), updatedAt: 1, createdAt: 1, items: [{ kind: 'user', id: 'u', at: 1, text: 'hi', selections: [] }] });
    await s.now();
    expect(await getChat('ancient')).toBeNull();
  });

  it('"Delete all chats" empties the account too, including chats this computer no longer keeps', async () => {
    await chatWith('one', true);
    const uid = await ready();
    fake.put(uid, 'elsewhere', 5, { ...newChat(false, 'elsewhere'), items: [] });
    const s = startSync();
    await s.now();
    await deleteAllChats();
    await s.deleteAll();
    await s.now();
    expect(fake.chats.every((r) => r.deleted)).toBe(true);
    expect(fake.objects.size).toBe(0);
  });

  it('another account signing in here gets its own chats, not the first one’s', async () => {
    await chatWith('a-chat');
    await ready('a@example.com');
    const s = startSync();
    await s.now();
    await signOut();

    const b = await ready('b@example.com');
    await s.now();
    expect(fake.chats.filter((r) => r.user_id === b)).toEqual([]);

    // Not even once B opens the first account's chat and changes it, or deletes it.
    await renameChat('a-chat', 'Changed by B');
    await settle();
    await s.now();
    await deleteChat('a-chat');
    await settle();
    await s.now();
    expect(fake.chats.filter((r) => r.user_id === b)).toEqual([]);

    // B's own new chat does go to B.
    await chatWith('b-chat');
    await settle();
    await s.now();
    expect(fake.chats.filter((r) => r.user_id === b).map((r) => r.id)).toEqual(['b-chat']);
  });

  it('an account signing back in after another gets its own chats sent again', async () => {
    await chatWith('a-chat');
    const a = await ready('a@example.com');
    const s = startSync();
    await s.now();
    await signOut();
    await ready('b@example.com');
    await s.now();
    await signOut();

    await ready('a@example.com');
    await s.now(); // pulls a-chat: A's own again
    await renameChat('a-chat', 'A again');
    await settle();
    await s.now();
    expect((fake.row(a, 'a-chat')?.data as Chat).title).toBe('A again');
  });

  it('a failed upload keeps the chat marked, so it goes next time', async () => {
    await chatWith('one');
    const uid = await ready();
    const s = startSync();
    fake.entitle('a@example.com', { cloud: false }); // the server now refuses
    await entitlementItem.setValue({ plan: 'free', planName: 'Free', cloud: true, quota: 0, used: 0, billing: null, customer: false, checkedAt: Date.now() }); // we do not know yet
    await s.now();
    expect((await syncStatusItem.getValue()).state).toBe('error');
    fake.entitle('a@example.com', { cloud: true });
    await s.now();
    expect(fake.row(uid, 'one')).toBeDefined();
  });

  it('deleting the account removes its screenshots and the account; chats here stay', async () => {
    await chatWith('one', true);
    const uid = await ready();
    await startSync().now();
    expect(fake.objects.size).toBe(1);
    await deleteAccount(uid);
    expect(fake.objects.size).toBe(0);
    expect(fake.users.has(uid)).toBe(false);
    expect(fake.chats).toEqual([]);
    expect(await sessionItem.getValue()).toBeNull();
    expect(await getChat('one')).not.toBeNull();
  });
});
