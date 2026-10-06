/**
 * Account: optional. Signing in (Google, or a code sent by email) is what
 * cloud storage and hosted answers hang on; both are given per account (see
 * supabase/migrations). Without a Supabase project in the build there is no
 * section at all.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { ACCOUNTS } from '@/lib/account/config';
import {
  AccountError,
  askAccountConsent,
  refreshEntitlement,
  sendEmailCode,
  signInWithGoogle,
  signOut,
  verifyEmailCode,
  type SyncStatus,
} from '@/lib/account/session';
import type { Settings } from '@/lib/storage';
import type { AccountState } from '@/ui/useAccount';

type Save = (patch: Partial<Settings>) => Promise<void>;

/** Google sign-in needs the identity API, which Safari does not have. */
const GOOGLE = typeof browser !== 'undefined' && !!(browser as { identity?: { launchWebAuthFlow?: unknown } }).identity?.launchWebAuthFlow;

export function AccountSection({ account, settings, save }: { account: AccountState; settings: Settings; save: Save }) {
  if (!ACCOUNTS || !account.ready) return null;
  return (
    <section id="account" data-testid="section-account">
      <h2>Account</h2>
      {account.user ? <SignedIn account={account} settings={settings} save={save} /> : <SignIn />}
    </section>
  );
}

const NEEDS_CONSENT = "Signing in needs your OK to send your email address.";

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

  // Firefox asks for consent only from the click itself, so it is asked first.
  const google = () => {
    const consent = askAccountConsent();
    void run('google', async () => {
      if (!(await consent)) throw new Error(NEEDS_CONSENT);
      await signInWithGoogle();
    });
  };
  const send = (to: string) => {
    const consent = askAccountConsent();
    void run('send', async () => {
      if (!(await consent)) throw new Error(NEEDS_CONSENT);
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
      <p className="help">Optional. Sign in to keep your chats in the cloud, if your account has it.</p>
      {!sentTo ? (
        <>
          {GOOGLE && (
            <button type="button" className="secondary" disabled={!!busy} onClick={google} data-testid="google-sign-in">
              {busy === 'google' ? 'Waiting for Google…' : 'Continue with Google'}
            </button>
          )}
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

  // What the account may use can change on the server (you flag an account):
  // read it again whenever this page opens, and catch up the cloud copy.
  useEffect(() => {
    setCheckError('');
    void refreshEntitlement().catch((err: Error) => setCheckError(err.message));
    void browser.runtime.sendMessage({ type: 'sync:now' }).catch(() => {});
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

      <div className="field" data-testid="cloud">
        <span className="field-label">Cloud storage</span>
        {!ent ? (
          <p className={`help${checkError ? ' bad' : ''}`} data-testid="cloud-checking">
            {checkError ? `Couldn't check your account: ${checkError}` : 'Checking…'}
          </p>
        ) : ent.cloud ? (
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
            Not on for this account.
          </p>
        )}
      </div>

      {ent && ent.quota > 0 && (
        <div className="field">
          <span className="field-label">Hosted answers</span>
          <p className="help" data-testid="hosted-left">
            {Math.max(0, ent.quota - ent.used)} of {ent.quota} left this month.
          </p>
        </div>
      )}

      <div className="field">
        {!confirming ? (
          <button type="button" className="secondary" onClick={() => setConfirming(true)} data-testid="delete-account">
            Delete account
          </button>
        ) : (
          <div className="confirm-row">
            <span>Delete your account and everything in the cloud? Chats on this computer stay.</span>
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
