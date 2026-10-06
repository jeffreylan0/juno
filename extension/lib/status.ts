/**
 * Is the AI the student picked actually reachable?
 *
 * The panel shows a notice above the macros whenever the answer would fail or
 * be fake: placeholder answers, no key, a key the vendor rejects, or a vendor
 * (or local server) that cannot be reached — "disconnected". Checking costs
 * nothing: the vendors' model lists are free, and a local server answers
 * /models. The background runs the check (it holds the keys and makes every
 * network call), keeps the result in storage.session for a minute, and
 * updates it from real answers too: an answer that arrives proves the
 * connection, one that fails to connect disproves it.
 */
import { testKey } from './providers/byok';
import { GATEWAY_URL, answerChoiceOf, type Keys, type Settings } from './storage';

export type AiState = 'ok' | 'placeholder' | 'no-key' | 'bad-key' | 'disconnected' | 'error' | 'unavailable';

export interface AiStatus {
  state: AiState;
  /** The answer choice this was checked for (storage.ts AnswerChoice). */
  choice: string;
  /** Who answers, as the student knows it: "Claude", "ChatGPT", "the local model". */
  who: string;
  /** One sentence for the notice. */
  message?: string;
  checkedAt: number;
}

export const STATUS_KEY = 'aiStatus';
/** A check is reused for this long unless the student asks again. */
export const STATUS_TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;

const WHO = { anthropic: 'Claude', openai: 'ChatGPT' } as const;
const VENDOR = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;

export function whoAnswers(settings: Pick<Settings, 'provider' | 'vendor'>): string {
  switch (settings.provider) {
    case 'byok':
      return WHO[settings.vendor];
    case 'local':
      return 'the local model';
    case 'gateway':
      return 'hosted answers';
    case 'mock':
      return 'placeholder answers';
  }
}

function withTimeout(fetchImpl: typeof fetch, ms: number): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(ms) });
}

export async function checkStatus(fetchImpl: typeof fetch, settings: Settings, keys: Keys): Promise<AiStatus> {
  const base = { choice: answerChoiceOf(settings), who: whoAnswers(settings), checkedAt: Date.now() };
  const f = withTimeout(fetchImpl, TIMEOUT_MS);

  switch (settings.provider) {
    case 'mock':
      return { ...base, state: 'placeholder', message: 'Placeholder answers — no AI is connected.' };

    case 'gateway': {
      if (!keys.session) return { ...base, state: 'no-key', message: 'Sign in to use hosted answers.' };
      try {
        const res = await f(`${GATEWAY_URL.replace(/\/$/, '')}/me`, { headers: { authorization: `Bearer ${keys.session}` } });
        if (res.status === 401) return { ...base, state: 'bad-key', message: 'Your sign-in ran out. Sign in again.' };
        if (!res.ok) return { ...base, state: 'disconnected', message: "The hosted service isn't responding right now." };
        const me = (await res.json()) as { quota?: number; used?: number };
        if (!me.quota) return { ...base, state: 'unavailable', message: "Your account doesn't include hosted answers." };
        if ((me.used ?? 0) >= me.quota) return { ...base, state: 'error', message: `You've used all ${me.quota} hosted answers this month.` };
        return { ...base, state: 'ok' };
      } catch {
        return { ...base, state: 'disconnected', message: "Can't reach the hosted service. Check your internet connection." };
      }
    }

    case 'local': {
      const url = settings.localBaseUrl.replace(/\/$/, '');
      try {
        const res = await f(`${url}/models`);
        if (res.ok) return { ...base, state: 'ok' };
        return { ...base, state: 'error', message: `The local server at ${host(url)} returned an error (${res.status}).` };
      } catch {
        return { ...base, state: 'disconnected', message: `No local model is answering at ${host(url)}. Start it, or pick another.` };
      }
    }

    case 'byok': {
      const vendor = settings.vendor;
      const key = keys[vendor].trim();
      if (!key) return { ...base, state: 'no-key', message: `No ${WHO[vendor]} API key yet.` };
      const result = await testKey(f, vendor, key);
      if (result.ok) return { ...base, state: 'ok' };
      return { ...base, ...fromErrorCode(vendor, result.code, result.error) };
    }
  }
}

/** What a failed check or answer says about the connection. */
export function fromErrorCode(
  vendor: 'anthropic' | 'openai',
  code: string | undefined,
  message: string,
): Pick<AiStatus, 'state' | 'message'> {
  switch (code) {
    case 'bad-key':
      return { state: 'bad-key', message: `${VENDOR[vendor]} rejected your API key.` };
    case 'no-key':
      return { state: 'no-key', message: `No ${WHO[vendor]} API key yet.` };
    case 'network':
      return { state: 'disconnected', message: `Can't reach ${VENDOR[vendor]}. Check your internet connection.` };
    case 'overloaded':
    case 'http':
      return { state: 'disconnected', message: `${VENDOR[vendor]} isn't responding right now.` };
    default:
      return { state: 'error', message };
  }
}

/**
 * Whether a finished answer changes what we know. Success means connected;
 * a connection or key failure means not. Anything else (a refused request, a
 * rate limit, an overload) says nothing about the connection and leaves the
 * status alone.
 */
export function statusFromAnswer(
  settings: Settings,
  outcome: { ok: true } | { ok: false; code?: string; message: string },
): AiStatus | null {
  const base = { choice: answerChoiceOf(settings), who: whoAnswers(settings), checkedAt: Date.now() };
  if (settings.provider === 'mock') return null;
  if (outcome.ok) return { ...base, state: 'ok' };
  if (settings.provider === 'local') {
    return outcome.code === 'network' ? { ...base, state: 'disconnected', message: `No local model is answering at ${host(settings.localBaseUrl)}. Start it, or pick another.` } : null;
  }
  if (settings.provider !== 'byok') return null;
  // An overloaded vendor is up, just busy: the answer's own error says so.
  if (!['bad-key', 'no-key', 'network'].includes(outcome.code ?? '')) return null;
  return { ...base, ...fromErrorCode(settings.vendor, outcome.code, outcome.message) };
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
