/**
 * Turns vendor HTTP failures into something a student can act on.
 *
 * "Anthropic returned HTTP 401: {…json…}" tells nobody what to do. Each case
 * here says what went wrong in one sentence and, through its code, lets the
 * panel offer the right button: Settings for a key or model problem, Try
 * again for anything transient.
 */
import { ProviderError, type ProviderErrorCode } from './types';

export type VendorName = 'Anthropic' | 'OpenAI' | 'the local server' | 'the hosted service';

interface ParsedBody {
  type?: string;
  code?: string;
  message?: string;
  requestId?: string;
}

/** Anthropic: {type:"error", error:{type,message}, request_id}. OpenAI: {error:{message,type,code}}. */
export function parseErrorBody(text: string): ParsedBody {
  try {
    const j = JSON.parse(text) as {
      error?: { type?: string; code?: string | null; message?: string } | string;
      request_id?: string;
      message?: string;
    };
    if (typeof j.error === 'string') return { message: j.error };
    return {
      type: j.error?.type,
      code: j.error?.code ?? undefined,
      message: j.error?.message ?? j.message,
      requestId: j.request_id,
    };
  } catch {
    return { message: text.trim().slice(0, 200) || undefined };
  }
}

const CONSOLE: Record<string, string> = {
  Anthropic: 'the Anthropic Console (console.anthropic.com) under Billing',
  OpenAI: 'the OpenAI dashboard (platform.openai.com) under Billing',
};

/** Why a request failed, as a ProviderError with a student-facing message. */
export function describeHttpError(
  vendor: VendorName,
  status: number,
  bodyText: string,
  opts: { model?: string; retryAfter?: string | null } = {},
): ProviderError {
  const body = parseErrorBody(bodyText);
  const detail = `${body.type ?? ''} ${body.code ?? ''} ${body.message ?? ''}`;
  const make = (code: ProviderErrorCode, message: string) => {
    const e = new ProviderError(message, code, status);
    e.requestId = body.requestId;
    e.detail = body.message;
    return e;
  };

  if (status === 401 || /authentication_error|invalid_api_key/.test(detail)) {
    return make('bad-key', `${vendor} rejected the API key. Check it in Settings.`);
  }
  if (status === 402 || /billing_error|insufficient_quota|credit balance|billing|spend(ing)? limit/i.test(detail)) {
    return make(
      'no-credit',
      `Your ${vendor} account is out of credit or at its spend limit. Add credit in ${CONSOLE[vendor] ?? 'the billing page'}.`,
    );
  }
  if (status === 403 || /permission_error/.test(detail)) {
    return make('permission', `This ${vendor} key is not allowed to use ${opts.model ? `"${opts.model}"` : 'that model'}.`);
  }
  if (status === 404 || /not_found_error|model_not_found|does not exist/.test(detail)) {
    return make(
      'model',
      `${vendor} has no model ${opts.model ? `"${opts.model}"` : 'by that name'} for this key. Pick another model in Settings.`,
    );
  }
  if (status === 413 || /request_too_large|too large|maximum.*size/i.test(detail)) {
    return make('too-large', 'That selection is too large to send. Try a smaller box.');
  }
  if (status === 429 || /rate_limit/.test(detail)) {
    const secs = Number(opts.retryAfter);
    const when = Number.isFinite(secs) && secs > 0 ? ` in ${Math.ceil(secs)} s` : ' in a moment';
    return make('rate-limit', `${vendor} is limiting how fast this key can ask. Try again${when}.`);
  }
  if (status === 529 || status === 503 || /overloaded/.test(detail)) {
    return make('overloaded', `${vendor} is overloaded right now. Try again in a minute.`);
  }
  if (status >= 500) {
    return make('http', `${vendor} had a server error (${status}). Try again.`);
  }
  // A 400 we did not anticipate: the vendor's own words are the best we have.
  return make('http', `${vendor} refused the request${body.message ? `: ${body.message}` : ` (HTTP ${status})`}.`);
}

/** A mid-stream `error` event (Anthropic sends these after a 200). */
export function describeStreamError(vendor: VendorName, error: { type?: string; message?: string } | undefined): ProviderError {
  const type = error?.type ?? '';
  if (/overloaded/.test(type)) return new ProviderError(`${vendor} is overloaded right now. Try again in a minute.`, 'overloaded');
  if (/rate_limit/.test(type)) return new ProviderError(`${vendor} is limiting how fast this key can ask. Try again in a moment.`, 'rate-limit');
  return new ProviderError(`${vendor} stopped partway: ${error?.message ?? 'unknown error'}. Try again.`, 'http');
}

/**
 * fetch, but a network failure (offline, DNS, CORS, a blocker extension)
 * becomes a sentence instead of "TypeError: Failed to fetch".
 */
export async function vendorFetch(
  fetchImpl: typeof fetch,
  vendor: VendorName,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    const host = safeHost(url);
    throw new ProviderError(
      `Could not reach ${vendor}. Check your connection (or a blocker stopping ${host}).`,
      'network',
    );
  }
}

/** Throws a described error unless the response is OK. */
export async function ensureVendorOk(res: Response, vendor: VendorName, model?: string): Promise<void> {
  if (res.ok) return;
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  throw describeHttpError(vendor, res.status, text, { model, retryAfter: res.headers.get('retry-after') });
}

/** Codes where the fix is in Settings rather than trying again. */
export function needsSettings(code: string | undefined): boolean {
  return code === 'no-key' || code === 'bad-key' || code === 'model' || code === 'permission' || code === 'no-credit';
}

/** Codes worth a plain retry. */
export function isTransient(code: string | undefined): boolean {
  return code === 'rate-limit' || code === 'overloaded' || code === 'network' || code === 'http' || code === 'empty';
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
