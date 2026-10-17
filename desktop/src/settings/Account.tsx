/**
 * Account: optional. Signing in (Google, or a code sent by email) is what
 * plans hang on: hosted answers and cloud storage, bought with Stripe
 * (lib/account/billing.ts) or given by hand (supabase/README.md). The
 * section is the account's dashboard: the plan and what is next for it,
 * hosted answers used this month, buying or managing it, cloud storage,
 * deleting the account. Without a Supabase project in the build there is
 * no section at all.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { offers, openPortal, priceLabel, startCheckout, type Offer } from '@/lib/account/billing';
import { ACCOUNTS } from '@/lib/account/config';
import {
  AccountError,
  refreshEntitlement,
  sendEmailCode,
  signInWithGoogle,
  signOut,
  verifyEmailCode,
  type Entitlement,
  type SyncStatus,
} from '@/lib/account/session';
import type { Settings } from '@/lib/storage';
import type { AccountState } from '@/ui/useAccount';

type Save = (patch: Partial<Settings>) => Promise<void>;


export function AccountSection({ account, settings, save }: { account: AccountState; settings: Settings; save: Save }) {
  if (!ACCOUNTS || !account.ready) return null;
  return (
    <section id="account" data-testid="section-account">
      <h2>Account</h2>
      {account.user ? <SignedIn account={account} settings={settings} save={save} /> : <SignIn />}
    </section>
  );
}


function SignIn() {
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
      <p className="help">Optional. Sign in for a plan with hosted answers (no key needed) and your chats in the cloud.</p>
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
    </div>
  );
}

function SignedIn({ account, settings, save }: { account: AccountState; settings: Settings; save: Save }) {
  const user = account.user!;
  const ent = account.entitlement;
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [checkError, setCheckError] = useState('');

  // What the account gets changes on the server (a payment, a cancellation,
  // a plan you give by hand): read it again when this page opens, and when
  // it comes back into view (from Stripe's pages, say). And catch up the
  // cloud copy.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      setCheckError('');
      void refreshEntitlement().catch((err: Error) => setCheckError(err.message));
    };
    check();
    void browser.runtime.sendMessage({ type: 'sync:now' }).catch(() => {});
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [user.id]);

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
      <div className="field" data-testid="signed-in">
        <span className="key-row shortcut-row">
          <span>
            Signed in as <b data-testid="account-email">{user.email}</b>
          </span>
          <button type="button" className="secondary" onClick={() => void signOut()} data-testid="sign-out">
            Sign out
          </button>
        </span>
      </div>

      {!ent ? (
        <p className={`help${checkError ? ' bad' : ''}`} data-testid="account-checking">
          {checkError ? `Couldn't check your account: ${checkError}` : 'Checking…'}
        </p>
      ) : (
        <>
          <PlanField ent={ent} />

          <div className="field" data-testid="cloud">
            <span className="field-label">Cloud storage</span>
            {ent.cloud ? (
              <>
                <label className="check">
                  <input type="checkbox" checked={settings.cloudSync} data-testid="cloud-sync" onChange={(e) => void save({ cloudSync: e.target.checked })} />
                  Keep my chats in the cloud too
                </label>
                <small className="help">Your chats and screenshots, on every computer you sign in on. Temporary chats never go.</small>
                {settings.cloudSync && <SyncLine status={account.sync} />}
              </>
            ) : (
              <p className="help" data-testid="no-cloud">
                Not included in your plan.
              </p>
            )}
          </div>
        </>
      )}

      <div className="field">
        {!confirming ? (
          <button type="button" className="secondary" onClick={() => setConfirming(true)} data-testid="delete-account">
            Delete account
          </button>
        ) : (
          <div className="confirm-row">
            <span>
              Delete your account and everything in the cloud?{ent?.billing?.active ? ' Your subscription ends now, without a refund.' : ''} Chats on this
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

/** The plan, hosted answers used this month, and buying or managing it. */
function PlanField({ ent }: { ent: Entitlement }) {
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
    <div className="field" data-testid="plan">
      <span className="field-label">Plan</span>
      <p className="help" data-testid="plan-line">
        <b>{ent.planName || 'Free'}</b>
        {status && <> · {status}</>}
      </p>
      {ent.quota > 0 && (
        <div className="usage">
          <span className="help" data-testid="hosted-left">
            {left} of {ent.quota} hosted answers left this month.
          </span>
          <meter min={0} max={ent.quota} value={ent.used} aria-label="Hosted answers used this month" />
        </div>
      )}
      {plan && (
        <div className="upgrade" data-testid="upgrade">
          <p className="help">
            <b>{plan.name}</b>: {plan.monthly_questions.toLocaleString()} hosted answers a month, no key needed
            {plan.cloud ? ', and your chats in the cloud' : ''}.
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
          <small className="help">Payment opens in your browser, with Stripe. Cancel any time.</small>
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
    </div>
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
