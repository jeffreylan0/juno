/**
 * The top of settings, in the manner of a profile page. On the left, who you
 * are: your picture beside your name and email, under them your plan in
 * bold and what is next for it, then buying or managing it and signing out
 * (or, as a guest, signing up or in a click away but never pressed on you,
 * and the unlock for this computer: lib/account/unlock.ts). On the right,
 * usage: a horseshoe of the month's hosted answers left, with how many the
 * model you picked has left in its middle; without hosted answers, this
 * month's answers. Then who answers, by the model's name. The settings
 * follow, the most used first (Options.tsx).
 */
import { useEffect, useRef, useState } from 'react';
import { HOSTED_MODEL, answersLeft } from '@shared/models';
import { ACCOUNTS } from '@/lib/account/config';
import type { AccountUser } from '@/lib/account/session';
import { buyUnlock, restoreUnlock, unlockOffer } from '@/lib/account/unlock';
import { MODEL_NAMES, MODEL_TABLE } from '@/lib/router';
import { hostedModelOf, type Settings } from '@/lib/storage';
import { thisMonth, usageItem, type MonthUsage } from '@/lib/usage';
import { unitsLeft } from '@/ui/ModelPicker';
import { useExtrasOpen, type AccountState } from '@/ui/useAccount';
import { PlanActions, PlanLine, SignUpOrIn, useAccountRefresh } from './Account';

export function Dashboard({ settings, account }: { settings: Settings; account: AccountState }) {
  return (
    <section id="dashboard" className="dashboard" data-testid="dashboard">
      <Profile account={account} />
      <span className="profile-rule" aria-hidden="true" />
      <Usage settings={settings} account={account} />
    </section>
  );
}

// ── Who ──────────────────────────────────────────────────────────────────

function Profile({ account }: { account: AccountState }) {
  const user = account.user;
  const ent = user ? account.entitlement : null;
  const checkError = useAccountRefresh(user?.id);
  // What signing out left to say, shown once signed out.
  const [leftHere, setLeftHere] = useState('');
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
      {(user || ACCOUNTS) && (
        <div className="profile-plan">
          {ent ? (
            <PlanLine ent={ent} />
          ) : user ? (
            <span className={`help${checkError ? ' bad' : ''}`} data-testid="account-checking">
              {checkError ? `Couldn't check your account: ${checkError}` : 'Checking…'}
            </span>
          ) : (
            <GuestPlanLine />
          )}
        </div>
      )}
      {user ? (
        <>
          {ent && <PlanActions ent={ent} />}
          <SignOut onDone={setLeftHere} />
        </>
      ) : (
        <>
          {leftHere && (
            <p className="help warn" data-testid="sign-out-note">
              {leftHere}
            </p>
          )}
          <GuestUnlock />
          {ACCOUNTS && account.ready && <SignUpOrIn why="Unlock hosted answers and cloud storage." />}
        </>
      )}
    </div>
  );
}

/**
 * Signing out, through the core: chats kept in the account leave this
 * computer first (lib/account/sync.ts). `onDone` is told of any that had to
 * stay, not having reached the account.
 */
function SignOut({ onDone }: { onDone: (note: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    const reply = (await browser.runtime.sendMessage({ type: 'account:sign-out' }).catch((e: Error) => ({ error: e.message }))) as
      | { ok: true; kept: number }
      | { error: string }
      | null;
    setBusy(false);
    if (!reply || 'error' in reply) return setError(`Couldn't sign out: ${reply?.error ?? 'try again'}.`);
    const n = reply.kept;
    onDone(n ? `${n === 1 ? 'A chat' : `${n} chats`} couldn't reach your account, so ${n === 1 ? 'it stays' : 'they stay'} on this computer.` : '');
  };
  return (
    <>
      <button type="button" className="secondary" disabled={busy} data-testid="sign-out" onClick={() => void go()}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
      {error && <p className="help bad">{error}</p>}
    </>
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

/** A guest's plan: free, or Plus by the unlock bought on this computer. */
function GuestPlanLine() {
  const open = useExtrasOpen();
  return (
    <span className="plan-line" data-testid="plan-name">
      <b>{open ? 'Plus' : 'Free'}</b>
      {open && ' on this computer'}
    </span>
  );
}

/** The unlock, offered to a guest, quietly. */
function GuestUnlock() {
  const open = useExtrasOpen();
  const [price, setPrice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'buy' | 'restore' | null>(null);
  const [error, setError] = useState('');
  const stop = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!ACCOUNTS || open) return;
    void unlockOffer().then((p) => p && setPrice(new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency.toUpperCase() }).format(p.amount / 100)));
    return () => stop.current?.abort();
  }, [open]);
  if (open || !price) return null;

  const run = async (what: 'buy' | 'restore', fn: () => Promise<unknown>) => {
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

  return (
    <div className="unlock" data-testid="unlock">
      <p className="help">Every theme, your own place for the bar and the panel, and more macros, on this computer: {price} once, no account needed.</p>
      <span className="key-row">
        <button type="button" className="unlock-btn" disabled={!!busy} data-testid="unlock-buy" onClick={buy}>
          {busy === 'buy' ? 'Waiting for checkout…' : `Unlock for ${price}`}
        </button>
        <button type="button" className="link" disabled={!!busy} data-testid="unlock-restore" onClick={() => void run('restore', restoreUnlock)}>
          {busy === 'restore' ? 'Checking…' : 'Bought it here before? Restore'}
        </button>
      </span>
      {error && <p className="help bad">{error}</p>}
    </div>
  );
}

// ── Usage ────────────────────────────────────────────────────────────────

function Usage({ settings, account }: { settings: Settings; account: AccountState }) {
  const usage = useMonthUsage();
  const ent = account.user ? account.entitlement : null;
  const units = unitsLeft(account);
  // The plan's answers are counted for the model picked for them (or the fast one).
  const model = settings.provider === 'gateway' ? hostedModelOf(settings) : HOSTED_MODEL.anthropic;
  return (
    <div id="usage" className="usage" data-testid="usage">
      <span className="plan-label">Usage</span>
      {units !== null && ent ? (
        <Gauge part={units / ent.quota} count={answersLeft(units, model)} label="answers left" />
      ) : (
        <Gauge part={0} count={usage.answers} label={usage.answers === 1 ? 'answer this month' : 'answers this month'} />
      )}
      <p className="help usage-who" data-testid="who-answers">
        {using(settings)}
      </p>
    </div>
  );
}

/**
 * Who answers, by the model's name. A local model's name is only what was
 * typed in settings, not what the server says it runs, so it goes unnamed.
 * Auto on a key answers every chat (each has a screenshot) with the larger model.
 */
export function using(settings: Settings): string {
  switch (settings.provider) {
    case 'gateway':
      return `You're using ${MODEL_NAMES[hostedModelOf(settings)]} with your plan.`;
    case 'byok': {
      const model = settings.modelOverride?.vendor === settings.vendor ? settings.modelOverride.model : MODEL_TABLE[settings.vendor].large;
      return `You're using ${MODEL_NAMES[model] ?? model} with your API key.`;
    }
    case 'local':
      return "You're using your local model.";
    case 'mock':
      return 'Pick who answers below.';
  }
}

/** The horseshoe: a 270° arc open at the bottom, from bottom left round to bottom right (pathLength 100). */
const ARC = 'M 43.43 156.57 A 80 80 0 1 1 156.57 156.57';

/**
 * How much of the month is left (`part`, 0 to 1), filling in when it shows
 * and following any change; `count` and `label` in its middle.
 */
function Gauge({ part, count, label }: { part: number; count: number; label: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(Math.min(1, Math.max(0, part))));
    return () => cancelAnimationFrame(frame);
  }, [part]);
  return (
    <div className="gauge" data-testid="gauge" data-part={Math.round(part * 1000) / 1000} role="img" aria-label={`${count.toLocaleString()} ${label}`}>
      <svg viewBox="0 0 200 172" aria-hidden="true">
        <path className="gauge-track" d={ARC} pathLength={100} />
        {part > 0 && <path className="gauge-fill" d={ARC} pathLength={100} style={{ strokeDashoffset: 100 - shown * 100 }} />}
      </svg>
      <span className="gauge-center" aria-hidden="true">
        <span className="gauge-count" data-testid="gauge-count">
          {count.toLocaleString()}
        </span>
        <span className="gauge-label">{label}</span>
      </span>
    </div>
  );
}

function useMonthUsage(): MonthUsage {
  const [usage, setUsage] = useState<MonthUsage>(() => thisMonth(null));
  useEffect(() => {
    void usageItem.getValue().then((u) => setUsage(thisMonth(u)), () => {});
    return usageItem.watch((u) => setUsage(thisMonth(u)));
  }, []);
  return usage;
}
