/**
 * The first launch, once (settings.introSeen): a selection is drawn in a
 * camera's frame, the shutter blinks, the frame closes into the mark, the
 * mark steps aside for the name, and both rise to show the way in: signing
 * up or in, or going on without an account. CSS alone (options.css,
 * "intro"); with reduced motion, only the last of it shows. The mark is a
 * placeholder for humanbn's.
 */
import { useEffect, useState } from 'react';
import { BRAND } from '@/brand';
import { ACCOUNTS } from '@/lib/account/config';
import type { AccountState } from '@/ui/useAccount';
import { SignUpOrIn } from './Account';

export function Intro({ account, onDone }: { account: AccountState; onDone: () => void }) {
  const [signing, setSigning] = useState(false);
  // Made while the window is hidden: played again, from the start, once it shows (settings/main.tsx).
  const [run, setRun] = useState(0);
  useEffect(() => {
    const again = () => setRun((n) => n + 1);
    addEventListener('settings:shown', again);
    return () => removeEventListener('settings:shown', again);
  }, []);
  // Signed in from here: on to the setup.
  useEffect(() => {
    if (account.user) onDone();
  }, [account.user]);
  return (
    <div className="page intro" data-testid="intro" key={run}>
      {/* Only to drag the window by. */}
      <header className="top intro-top" />
      <div className="intro-frame" aria-hidden="true">
        <svg viewBox="0 0 200 140">
          <path d="M8 34V8h26M166 8h26v26M192 106v26h-26M34 132H8v-26" />
          <rect className="intro-box" x="30" y="28" width="140" height="84" rx="3" pathLength={100} />
        </svg>
      </div>
      <span className="intro-flash" aria-hidden="true" />
      <main className="intro-main">
        <h1 className="intro-brand">
          <svg className="intro-mark" viewBox="0 0 56 56" aria-hidden="true">
            <circle cx="28" cy="28" r="28" />
            <circle cx="28" cy="28" r="10" />
          </svg>
          <span className="intro-name">{BRAND.name}</span>
        </h1>
        <div className="intro-actions">
          {ACCOUNTS && <SignUpOrIn why="Unlock hosted answers and cloud storage." onOpen={setSigning} />}
          {!signing && (
            <button type="button" className={ACCOUNTS ? 'link' : 'primary'} data-testid="intro-continue" onClick={onDone}>
              {ACCOUNTS ? 'Continue without an account' : 'Get started'}
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
