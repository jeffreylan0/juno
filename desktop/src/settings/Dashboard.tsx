/**
 * The top of settings, in the manner of a profile page: who you are (your
 * picture, name and plan; or Guest, with signing in or up a click away but
 * never pressed on you), then your plan. Signed in to a plan with hosted
 * answers, the answers left this month, in a badge. Otherwise this month's
 * answers, what they cost on your own key, who answers, and for a guest the
 * unlock (lib/account/unlock.ts). The settings follow, the most used first
 * (Options.tsx).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ACCOUNTS } from '@/lib/account/config';
import { signOut, type AccountUser } from '@/lib/account/session';
import { buyUnlock, restoreUnlock, unlockOffer } from '@/lib/account/unlock';
import type { KeyStatus } from '@/lib/providers/types';
import { ASSISTANT, COMPANY, MODEL_NAMES, MODEL_TABLE } from '@/lib/router';
import type { Settings } from '@/lib/storage';
import { thisMonth, usageItem, type MonthUsage } from '@/lib/usage';
import { useExtrasOpen, useUnlock, type AccountState } from '@/ui/useAccount';
import { PlanDetails, SignIn, useAccountRefresh } from './Account';

export function Dashboard({ settings, keys, account }: { settings: Settings; keys: KeyStatus; account: AccountState }) {
  return (
    <section id="dashboard" className="dashboard" data-testid="dashboard">
      <Profile account={account} />
      <span className="profile-rule" aria-hidden="true" />
      <Plan settings={settings} keys={keys} account={account} />
    </section>
  );
}

// ── Who ──────────────────────────────────────────────────────────────────

function Profile({ account }: { account: AccountState }) {
  const user = account.user;
  const [signing, setSigning] = useState(false);
  return (
    <div id="account" className="profile" data-testid="profile">
      <div className="profile-row">
        <Avatar picture={user?.picture} />
        <div className="profile-who">
          <span className="profile-name" data-testid="profile-name">
            {user ? nameOf(user) : 'Guest'}
          </span>
          {user && (
            <span className="help" data-testid="account-email">
              {user.email}
            </span>
          )}
        </div>
      </div>
      {user ? (
        <button type="button" className="link" data-testid="sign-out" onClick={() => void signOut()}>
          Sign out
        </button>
      ) : (
        ACCOUNTS &&
        account.ready &&
        (signing ? (
          <SignIn onCancel={() => setSigning(false)} />
        ) : (
          <div className="profile-actions">
            <button type="button" className="primary" data-testid="sign-up" onClick={() => setSigning(true)}>
              Sign up
            </button>
            <button type="button" className="secondary" data-testid="sign-in-open" onClick={() => setSigning(true)}>
              Sign in
            </button>
          </div>
        ))
      )}
    </div>
  );
}

/** The name Google gave, or the part of the email address before the @. */
function nameOf(user: AccountUser): string {
  return user.name || user.email.split('@')[0] || 'You';
}

/**
 * Google's picture of the account, fetched once (the page shows no remote
 * images: the app's own fetch brings it, and it is shown from memory); a
 * blank one for a guest, or while it comes.
 */
function Avatar({ picture }: { picture?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!picture) return;
    let url: string | null = null;
    void fetch(picture, { signal: AbortSignal.timeout(8000) })
      .then((res) => (res.ok && res.headers.get('content-type')?.startsWith('image/') ? res.blob() : null))
      .then((blob) => blob && setSrc((url = URL.createObjectURL(blob))))
      .catch(() => {});
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [picture]);
  return (
    <span className="avatar" data-testid="avatar">
      {src ? (
        <img src={src} alt="" />
      ) : (
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="25" r="12" />
          <path d="M10 56c2.5-11 11.5-17 22-17s19.5 6 22 17" />
        </svg>
      )}
    </span>
  );
}

// ── The plan ─────────────────────────────────────────────────────────────

function Plan({ settings, keys, account }: { settings: Settings; keys: KeyStatus; account: AccountState }) {
  const usage = useMonthUsage();
  const checkError = useAccountRefresh(account.user?.id);
  const ent = account.user ? account.entitlement : null;
  const hosted = (ent?.quota ?? 0) > 0;
  return (
    <div id="plan" className="plan" data-testid="plan">
      <span className="plan-label">Plan</span>
      {ent ? (
        <PlanDetails ent={ent} />
      ) : account.user ? (
        <p className={`help${checkError ? ' bad' : ''}`} data-testid="account-checking">
          {checkError ? `Couldn't check your account: ${checkError}` : 'Checking…'}
        </p>
      ) : (
        <GuestPlan />
      )}
      {!hosted && (
        <div className="month" data-testid="dash-usage">
          <p className="dash-big" data-testid="answers-this-month">
            {usage.answers} {usage.answers === 1 ? 'answer' : 'answers'}
          </p>
          <small className="help">this month</small>
          {usage.costUsd >= 0.005 && (
            <p className="help" data-testid="spend-this-month">
              About ${usage.costUsd.toFixed(2)} on your API key
            </p>
          )}
        </div>
      )}
      <p className="help dash-who" data-testid="who-answers">
        {whoAnswers(settings, keys)} ·{' '}
        <a className="link" href="#answers">
          Change
        </a>
      </p>
    </div>
  );
}

/** A guest's plan: free, or unlocked (and the code, for another computer); the unlock offered, quietly. */
function GuestPlan() {
  const unlock = useUnlock();
  const open = useExtrasOpen();
  // A build without accounts sells nothing: no plan to name.
  if (!ACCOUNTS) return null;
  return (
    <>
      <span className="plan-name" data-testid="plan-name">
        {unlock ? 'Unlocked' : 'Free'}
      </span>
      {unlock ? (
        <p className="help" data-testid="unlock-code">
          On another computer, enter <code className="code">{unlock.code}</code> to unlock it too.
        </p>
      ) : (
        !open && <UnlockOffer />
      )}
    </>
  );
}

function UnlockOffer() {
  const [price, setPrice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'buy' | 'code' | null>(null);
  const [entering, setEntering] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const stop = useRef<AbortController | null>(null);
  useEffect(() => {
    void unlockOffer().then((p) => p && setPrice(new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency.toUpperCase() }).format(p.amount / 100)));
    return () => stop.current?.abort();
  }, []);
  if (!price) return null;

  const run = async (what: 'buy' | 'code', fn: () => Promise<unknown>) => {
    setBusy(what);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const buy = () => {
    stop.current = new AbortController();
    void run('buy', () => buyUnlock(stop.current!.signal));
  };
  const restore = (e: FormEvent) => {
    e.preventDefault();
    void run('code', () => restoreUnlock(code));
  };

  return (
    <div className="unlock" data-testid="unlock">
      <p className="help">Every theme, your own place for the bar and the panel, and more macros: {price} once, no account needed.</p>
      <span className="key-row">
        <button type="button" className="unlock-btn" disabled={!!busy} data-testid="unlock-buy" onClick={buy}>
          {busy === 'buy' ? 'Waiting for checkout…' : `Unlock for ${price}`}
        </button>
        {!entering && (
          <button type="button" className="link" onClick={() => setEntering(true)}>
            I have a code
          </button>
        )}
      </span>
      {entering && (
        <form className="key-row" onSubmit={restore}>
          <input value={code} placeholder="JUNO-XXXX-XXXX-XXXX" aria-label="Unlock code" spellCheck={false} data-testid="unlock-code-input" onChange={(e) => setCode(e.target.value)} />
          <button type="submit" className="secondary" disabled={!code.trim() || !!busy}>
            {busy === 'code' ? 'Checking…' : 'Use code'}
          </button>
        </form>
      )}
      {error && <p className="help bad">{error}</p>}
    </div>
  );
}

/** Who answers, as one line. */
function whoAnswers(s: Settings, keys: KeyStatus): string {
  switch (s.provider) {
    case 'byok': {
      const model = s.modelOverride?.vendor === s.vendor ? s.modelOverride.model : MODEL_TABLE[s.vendor].large;
      const key = keys[s.vendor] ? `your ${COMPANY[s.vendor]} key ${keys[s.vendor]}` : `no ${COMPANY[s.vendor]} key yet`;
      return `${ASSISTANT[s.vendor]}, ${MODEL_NAMES[model] ?? model}, with ${key}`;
    }
    case 'local':
      return `The local model ${s.localModel}`;
    case 'gateway':
      return 'Hosted answers, with your plan';
    default:
      return 'No one yet';
  }
}

function useMonthUsage(): MonthUsage {
  const [usage, setUsage] = useState<MonthUsage>(() => thisMonth(null));
  useEffect(() => {
    void usageItem.getValue().then((u) => setUsage(thisMonth(u)), () => {});
    return usageItem.watch((u) => setUsage(thisMonth(u)));
  }, []);
  return usage;
}
