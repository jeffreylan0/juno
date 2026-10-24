/**
 * Account: optional. Signing up or in (a code sent by email, or Google) is
 * what plans hang on: hosted answers and cloud storage, bought with Stripe
 * (lib/account/billing.ts) or given by hand (supabase/README.md). The top
 * of settings (Dashboard.tsx) shows who is signed in and the plan
 * (PlanLine, PlanActions); further down, deleting the account. Without a
 * Supabase project in the build there is no account at all.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { BRAND } from '@/brand';
import { offers, openPortal, priceLabel, startCheckout, type Offer } from '@/lib/account/billing';
import { ACCOUNTS } from '@/lib/account/config';
import {
  AccountError,
  refreshEntitlement,
  sendEmailCode,
  signInWithGoogle,
  verifyEmailCode,
  type Entitlement,
  type SyncStatus,
} from '@/lib/account/session';
import type { AccountState } from '@/ui/useAccount';


/** The first-run setup's account step: signing up or in, or who is signed in and the plan. */
export function AccountCard({ account }: { account: AccountState }) {
  useAccountRefresh(account.user?.id);
  if (!ACCOUNTS || !account.ready) return null;
  if (!account.user) return <SignUpOrIn />;
  return (
    <div className="field" data-testid="signed-in">
      <span className="help">
        Signed in as <b>{account.user.email}</b>
      </span>
      {account.entitlement && (
        <>
          <PlanLine ent={account.entitlement} />
          <PlanActions ent={account.entitlement} />
        </>
      )}
    </div>
  );
}

/** Settings → Account: deleting the account, once signed in (where chats are kept: Chats & privacy). */
export function AccountSection({ account }: { account: AccountState }) {
  if (!ACCOUNTS || !account.user) return null;
  return (
    <section id="account-settings" data-testid="section-account">
      <h2>Account</h2>
      <p className="section-sub">Deleting your account, and everything in it.</p>
      <DeleteAccount account={account} />
    </section>
  );
}

/** Seconds between codes: Supabase's own least wait between emails to one address. */
const RESEND_S = 60;
/** When the next code may be sent (kept while this page is open, if signing in is put away and taken up again). */
let sendAfter = 0;

/** Seconds left until the next code may be sent, ticking down; and a way to start the wait. */
function useResendWait(): [number, (seconds: number) => void] {
  const [until, setUntil] = useState(sendAfter);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (until <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [until]);
  const start = (seconds: number) => setUntil((sendAfter = Date.now() + seconds * 1000));
  return [Math.max(0, Math.ceil((until - now) / 1000)), start];
}

export type SignMode = 'up' | 'in';

/**
 * The way into an account: Sign up and Sign in, each opening its own form.
 * `why`: a line under the two, until one is pressed. `onOpen`: told when a
 * form opens or closes.
 */
export function SignUpOrIn({ why, onOpen }: { why?: string; onOpen?: (open: boolean) => void }) {
  const [mode, setMode] = useState<SignMode | null>(null);
  const open = (next: SignMode | null) => {
    setMode(next);
    onOpen?.(!!next);
  };
  if (mode) return <SignIn mode={mode} onCancel={() => open(null)} />;
  return (
    <>
      <div className="sign-buttons">
        <button type="button" className="primary" data-testid="sign-up" onClick={() => open('up')}>
          Sign up
        </button>
        <button type="button" className="secondary" data-testid="sign-in" onClick={() => open('in')}>
          Sign in
        </button>
      </div>
      {why && (
        <small className="help" data-testid="account-why">
          {why}
        </small>
      )}
    </>
  );
}

/**
 * Signing up or in: the email address and its code, or Google. Signing up
 * offers a box for a name, which may stay empty (Google gives its own).
 * `onCancel`: a way back.
 */
export function SignIn({ mode: start, onCancel }: { mode: SignMode; onCancel?: () => void }) {
  const [mode, setMode] = useState(start);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'google' | 'send' | 'verify' | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [wait, startWait] = useResendWait();
  const up = mode === 'up';
  const words = up ? 'Sign up' : 'Sign in';

  const run = async (what: NonNullable<typeof busy>, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const e = err as AccountError;
      // Closing Google's page is no error worth showing.
      if (e.code !== 'cancelled' || what !== 'google') setError({ message: e.message, code: e.code });
      if (e.wait) startWait(e.wait);
    } finally {
      setBusy(null);
    }
  };

  const send = (to: string) => {
    void run('send', async () => {
      await sendEmailCode(to, up);
      startWait(RESEND_S);
      setSentTo(to.trim());
      setCode('');
    });
  };
  const onSend = (e: FormEvent) => {
    e.preventDefault();
    send(email);
  };
  const onVerify = (e: FormEvent) => {
    e.preventDefault();
    if (sentTo) void run('verify', () => verifyEmailCode(sentTo, code, up ? name : undefined));
  };
  /** A send button's words: counting down while another code can't go yet. */
  const sendLabel = (label: string) => (busy === 'send' ? 'Sending…' : wait ? `${label} (${wait})` : label);

  return (
    <div className="sign-in" data-testid="sign-in-form" data-mode={mode}>
      {!sentTo ? (
        <>
          {up && (
            <input
              autoComplete="name"
              placeholder="Name (optional)"
              aria-label="Name"
              maxLength={80}
              value={name}
              data-testid="name-input"
              onChange={(e) => setName(e.target.value)}
            />
          )}
          <form onSubmit={onSend}>
            <input
              type="email"
              autoComplete="email"
              placeholder="you@school.edu"
              aria-label="Email"
              value={email}
              data-testid="email-input"
              onChange={(e) => setEmail(e.target.value)}
            />
            <button
              type="submit"
              className="secondary"
              disabled={!email.trim() || !!busy || wait > 0}
              data-testid="send-code"
            >
              {sendLabel('Send code')}
            </button>
          </form>
          <span className="or" aria-hidden="true">
            or
          </span>
          <button type="button" className="secondary" disabled={!!busy} onClick={() => void run('google', signInWithGoogle)} data-testid="google-sign-in">
            {busy === 'google' ? 'Waiting for Google…' : 'Continue with Google'}
          </button>
        </>
      ) : (
        <>
          <p className="help" data-testid="code-sent">
            We sent a code to <b>{sentTo}</b>; it can take a minute.
          </p>
          <form onSubmit={onVerify}>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Code"
              aria-label="Code"
              maxLength={12}
              value={code}
              data-testid="code-input"
              onChange={(e) => setCode(e.target.value)}
            />
            <button type="submit" className="secondary" disabled={code.replace(/\D/g, '').length < 6 || !!busy} data-testid="verify-code">
              {busy === 'verify' ? 'Checking…' : words}
            </button>
          </form>
          <span className="key-row">
            <button type="button" className="link" disabled={!!busy || wait > 0} data-testid="resend-code" onClick={() => send(sentTo)}>
              {sendLabel('Send a new code')}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setSentTo(null);
                setError(null);
              }}
            >
              Use another email
            </button>
          </span>
        </>
      )}
      {error && (
        <p className="help bad" data-testid="account-error">
          {error.message}
          {error.code === 'no-account' && (
            <>
              {' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setMode('up');
                  setError(null);
                }}
              >
                Sign up instead
              </button>
            </>
          )}
        </p>
      )}
      <small className="help">
        By {up ? 'signing up' : 'signing in'}, you agree to the{' '}
        <a className="link" href={BRAND.terms} target="_blank" rel="noopener noreferrer">
          terms
        </a>{' '}
        and the{' '}
        <a className="link" href={BRAND.privacy} target="_blank" rel="noopener noreferrer">
          privacy policy
        </a>
        .
      </small>
      {onCancel && !busy && (
        <button type="button" className="link" onClick={onCancel}>
          Not now
        </button>
      )}
    </div>
  );
}

/**
 * What the account gets changes on the server (a payment, a cancellation, a
 * plan you give by hand): read it again when settings open, and when they
 * come back into view (from Stripe's pages, say). And catch up the cloud copy.
 */
export function useAccountRefresh(userId: string | undefined): string {
  const [error, setError] = useState('');
  useEffect(() => {
    if (!userId) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      setError('');
      void refreshEntitlement().catch((err: Error) => setError(err.message));
    };
    check();
    void browser.runtime.sendMessage({ type: 'sync:now' }).catch(() => {});
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [userId]);
  return error;
}

/** Deleting the account, after asking. */
function DeleteAccount({ account }: { account: AccountState }) {
  const ent = account.entitlement;
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const remove = async () => {
    setDeleting(true);
    setError('');
    const reply = (await browser.runtime.sendMessage({ type: 'account:delete' }).catch((e: Error) => ({ error: e.message }))) as
      | { ok: true }
      | { error: string };
    setDeleting(false);
    if ('error' in reply) setError(`Couldn't delete it: ${reply.error}`);
    else setConfirming(false);
  };

  return (
    <div className="field">
      {!confirming ? (
        <button type="button" className="secondary" onClick={() => setConfirming(true)} data-testid="delete-account">
          Delete account
        </button>
      ) : (
        <div className="confirm-row">
          <span>
            Delete your account and everything in the cloud?{ent?.billing?.active ? ' Your plan ends now, without a refund.' : ''} Chats on this
            computer stay.
          </span>
          <button type="button" className="danger" disabled={deleting} onClick={() => void remove()} data-testid="confirm-delete-account">
            {deleting ? 'Deleting…' : 'Delete account'}
          </button>
          <button type="button" className="secondary" disabled={deleting} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className="help bad">{error}</p>}
    </div>
  );
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

/** What is next for the plan, said after its name ("until February 15, 2027"), and a payment that failed. */
function planWhen(ent: Entitlement): { when: string; warn: string } {
  const b = ent.billing;
  if (!b?.active) return { when: '', warn: b && (b.status === 'incomplete' || b.status === 'unpaid') ? "Your last payment didn't go through." : '' };
  if (b.status === 'past_due') return { when: '', warn: "Your last payment didn't go through. Update your card to keep it." };
  if (!b.periodEnd) return { when: '', warn: '' };
  return { when: `${b.kind === 'subscription' && !b.cancelAtPeriodEnd ? 'renews' : 'until'} ${day(b.periodEnd)}`, warn: '' };
}

/** The plan, in bold, and what is next for it: under the account's email address. */
export function PlanLine({ ent }: { ent: Entitlement }) {
  const { when, warn } = planWhen(ent);
  return (
    <>
      <span className="plan-line" data-testid="plan-name">
        <b>{ent.planName || 'Free'}</b>
        {when && ` ${when}`}
      </span>
      {warn && (
        <span className="help bad" data-testid="plan-status">
          {warn}
        </span>
      )}
    </>
  );
}

/** Buying a plan (for an account that pays for nothing yet) or managing the one it has. */
export function PlanActions({ ent }: { ent: Entitlement }) {
  const [list, setList] = useState<Offer[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void offers().then(setList);
  }, []);

  const go = async (what: string, fn: () => Promise<void>) => {
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

  const upgrades = !ent.billing?.active ? (list ?? []).filter((o) => o.plan.id !== ent.plan) : [];
  const plan = upgrades[0]?.plan;

  return (
    <>
      {plan && (
        <div className="upgrade" data-testid="upgrade">
          <p className="help">
            <b>{plan.name}</b>: up to {plan.monthly_questions.toLocaleString()} hosted answers a month (fewer on larger models)
            {plan.cloud ? ' and your chats in the cloud' : ''}, {upgrades.every((o) => !o.interval) ? 'paid once' : 'renewing until you cancel'}.
          </p>
          <div className="key-row">
            {upgrades.map((o) => (
              <button
                key={o.key}
                type="button"
                className="secondary"
                disabled={!!busy}
                data-testid={`buy-${o.key}`}
                onClick={() => void go(o.key, () => startCheckout(o.key))}
              >
                {busy === o.key ? 'Opening…' : priceLabel(o)}
              </button>
            ))}
          </div>
          <small className="help">Payment opens in your browser, with Stripe.</small>
        </div>
      )}
      {ent.customer && (
        <button type="button" className="link" disabled={!!busy} data-testid="manage-billing" onClick={() => void go('portal', openPortal)}>
          {busy === 'portal' ? 'Opening…' : 'Manage billing'}
        </button>
      )}
      {error && (
        <p className="help bad" data-testid="billing-error">
          {error}
        </p>
      )}
    </>
  );
}

/** How the cloud copy of the chats is doing (Settings → Chats & privacy). */
export function SyncLine({ status }: { status: SyncStatus }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const again = () => void browser.runtime.sendMessage({ type: 'sync:now' }).catch(() => {});
  switch (status.state) {
    case 'syncing':
      return <p className="help" data-testid="sync-status">Syncing…</p>;
    case 'ok':
      return (
        <p className="help ok" data-testid="sync-status">
          ✓ Up to date ({ago(status.at)})
        </p>
      );
    case 'error':
      return (
        <p className="help bad" data-testid="sync-status">
          Couldn't sync: {status.message}{' '}
          <button type="button" className="link" onClick={again}>
            Try again
          </button>
        </p>
      );
    case 'not-allowed':
      return <p className="help" data-testid="sync-status">Not on for this account.</p>;
    default:
      return null;
  }
}

function ago(at: number): string {
  const min = Math.round((Date.now() - at) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : new Date(at).toLocaleDateString();
}
