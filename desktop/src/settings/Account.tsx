/**
 * Account: optional. Signing in (Google, or a code sent by email) is what
 * plans hang on: hosted answers and cloud storage, bought with Stripe
 * (lib/account/billing.ts) or given by hand (supabase/README.md). The top
 * of settings (Dashboard.tsx) shows who is signed in and the plan
 * (PlanDetails); further down are the account's settings: cloud storage,
 * deleting the account. Without a Supabase project in the build there is
 * no account at all.
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
import type { Settings } from '@/lib/storage';
import type { AccountState } from '@/ui/useAccount';

type Save = (patch: Partial<Settings>) => Promise<void>;


/** The first-run setup's account step: signing in, or who is signed in and the plan. */
export function AccountCard({ account }: { account: AccountState }) {
  useAccountRefresh(account.user?.id);
  if (!ACCOUNTS || !account.ready) return null;
  if (!account.user) return <SignIn />;
  return (
    <div className="field" data-testid="signed-in">
      <span className="help">
        Signed in as <b>{account.user.email}</b>
      </span>
      {account.entitlement && <PlanDetails ent={account.entitlement} />}
    </div>
  );
}

/** Settings → Account: cloud storage and deleting the account, once signed in. */
export function AccountSection({ account, settings, save }: { account: AccountState; settings: Settings; save: Save }) {
  if (!ACCOUNTS || !account.user) return null;
  return (
    <section id="account-settings" data-testid="section-account">
      <h2>Account</h2>
      <AccountSettings account={account} settings={settings} save={save} />
    </section>
  );
}


/** Signing in or up: one and the same (an account is made the first time). `onCancel`: a way back. */
export function SignIn({ onCancel }: { onCancel?: () => void } = {}) {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'google' | 'send' | 'verify' | null>(null);
  const [error, setError] = useState('');

  const run = async (what: NonNullable<typeof busy>, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError('');
    try {
      await fn();
    } catch (err) {
      if ((err as AccountError).code !== 'cancelled' || what !== 'google') setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const google = () => void run('google', signInWithGoogle);
  const send = (to: string) => {
    void run('send', async () => {
      await sendEmailCode(to);
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
    if (sentTo) void run('verify', () => verifyEmailCode(sentTo, code));
  };

  return (
    <div className="field" data-testid="sign-in">
      <p className="help">Optional: for hosted answers and cloud sync.</p>
      {!sentTo ? (
        <>
          <button type="button" className="secondary" disabled={!!busy} onClick={google} data-testid="google-sign-in">
            {busy === 'google' ? 'Waiting for Google…' : 'Continue with Google'}
          </button>
          <form className="key-row" onSubmit={onSend}>
            <input
              type="email"
              autoComplete="email"
              placeholder="you@school.edu"
              aria-label="Email"
              value={email}
              data-testid="email-input"
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" className="secondary" disabled={!email.trim() || !!busy} data-testid="send-code">
              {busy === 'send' ? 'Sending…' : 'Email me a code'}
            </button>
          </form>
        </>
      ) : (
        <>
          <p className="help" data-testid="code-sent">
            We sent a code to <b>{sentTo}</b>. It can take a minute.
          </p>
          <form className="key-row" onSubmit={onVerify}>
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
              {busy === 'verify' ? 'Checking…' : 'Sign in'}
            </button>
          </form>
          <span className="key-row">
            <button type="button" className="link" disabled={!!busy} onClick={() => send(sentTo)}>
              Send a new code
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setSentTo(null);
                setError('');
              }}
            >
              Use another email
            </button>
          </span>
        </>
      )}
      {error && (
        <p className="help bad" data-testid="account-error">
          {error}
        </p>
      )}
      {onCancel && !busy && (
        <button type="button" className="link" onClick={onCancel}>
          Not now
        </button>
      )}
      <small className="help">
        By signing in, you agree to the{' '}
        <a className="link" href={BRAND.terms} target="_blank" rel="noopener noreferrer">
          terms
        </a>{' '}
        and the{' '}
        <a className="link" href={BRAND.privacy} target="_blank" rel="noopener noreferrer">
          privacy policy
        </a>
        .
      </small>
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

/** Cloud storage (if the plan has it) and deleting the account. */
function AccountSettings({ account, settings, save }: { account: AccountState; settings: Settings; save: Save }) {
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
    <>
      {ent && (
        <div className="field" data-testid="cloud">
          <span className="field-label">Cloud storage</span>
          {ent.cloud ? (
            <>
              <label className="check">
                <input type="checkbox" checked={settings.cloudSync} data-testid="cloud-sync" onChange={(e) => void save({ cloudSync: e.target.checked })} />
                Keep my chats in the cloud too
              </label>
              <small className="help">On every computer you sign in on.</small>
              {settings.cloudSync && <SyncLine status={account.sync} />}
            </>
          ) : (
            <p className="help" data-testid="no-cloud">
              Not included in your plan.
            </p>
          )}
        </div>
      )}

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
    </>
  );
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

/** The plan line: which plan, and what is next for it. */
function planStatus(ent: Entitlement): string {
  const b = ent.billing;
  if (!b?.active) return b && (b.status === 'incomplete' || b.status === 'unpaid') ? "Your last payment didn't go through." : '';
  if (b.kind === 'pass') return b.periodEnd ? `Until ${day(b.periodEnd)}.` : '';
  if (b.status === 'past_due') return "Your last payment didn't go through. Update your card to keep it.";
  if (!b.periodEnd) return '';
  return b.cancelAtPeriodEnd ? `Ends on ${day(b.periodEnd)}.` : `Renews on ${day(b.periodEnd)}.`;
}

/** The plan, with the hosted answers left this month in a badge, and buying or managing it. */
export function PlanDetails({ ent }: { ent: Entitlement }) {
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

  // Upgrades are offered to accounts that pay for nothing yet.
  const upgrades = !ent.billing?.active ? (list ?? []).filter((o) => o.plan.id !== ent.plan) : [];
  const plan = upgrades[0]?.plan;
  const status = planStatus(ent);
  const left = Math.max(0, ent.quota - ent.used);

  return (
    <>
      <div className="plan-head">
        <span className="plan-name" data-testid="plan-name">
          {ent.planName || 'Free'}
        </span>
        {ent.quota > 0 && (
          <span className="answers-left" data-testid="hosted-left" title={`${left} of ${ent.quota} hosted answers left this month`}>
            {left.toLocaleString()}
          </span>
        )}
      </div>
      {ent.quota > 0 && <small className="help">Hosted answers left this month</small>}
      {status && (
        <p className="help" data-testid="plan-status">
          {status}
        </p>
      )}
      {plan && (
        <div className="upgrade" data-testid="upgrade">
          <p className="help">
            <b>{plan.name}</b>: up to {plan.monthly_questions.toLocaleString()} hosted answers a month, no key needed
            {plan.cloud ? ', and cloud sync' : ''}.{upgrades.every((o) => !o.interval) ? ' Paid once; nothing renews.' : ' Renews until you cancel, any time.'}
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
        <button type="button" className="secondary" disabled={!!busy} data-testid="manage-billing" onClick={() => void go('portal', openPortal)}>
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

function SyncLine({ status }: { status: SyncStatus }) {
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
