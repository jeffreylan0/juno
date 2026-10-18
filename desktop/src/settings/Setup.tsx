/**
 * The first-run setup: what settings show until it is done
 * (settings.setupDone; the core opens it when the app first starts). One
 * choice, who answers, and only what that needs: an API key (Claude,
 * ChatGPT), a local model's address, or an account with hosted answers.
 * Then, on a Mac, Screen Recording. Starting puts the bar up.
 */
import { BRAND } from '@/brand';
import { ACCOUNTS } from '@/lib/account/config';
import type { KeyStatus } from '@/lib/providers/types';
import type { Settings } from '@/lib/storage';
import { Icon } from '@/ui/icons';
import { hasHosted, type AccountState } from '@/ui/useAccount';
import { MAC } from '../os';
import { SignedIn, SignIn } from './Account';
import { VENDOR_OF, choiceOf, patchFor, type Choice } from './choices';
import { KeyField } from './KeyField';
import { LocalServer } from './LocalServer';
import { Permissions } from './Permissions';

const CHOICES: { id: Choice; name: string; sub: string }[] = [
  { id: 'claude', name: 'Claude', sub: 'Your Anthropic API key' },
  { id: 'chatgpt', name: 'ChatGPT', sub: 'Your OpenAI API key' },
  { id: 'local', name: 'Local model', sub: 'On this computer' },
  ...(ACCOUNTS ? [{ id: 'hosted' as const, name: `${BRAND.name} account`, sub: 'Hosted answers' }] : []),
];

export function Setup({
  settings,
  keys,
  account,
  save,
}: {
  settings: Settings;
  keys: KeyStatus;
  account: AccountState;
  save: (patch: Partial<Settings>) => Promise<void>;
}) {
  const choice = choiceOf(settings);
  const vendor = choice ? VENDOR_OF[choice] : undefined;
  const hosted = hasHosted(account);
  // Ready once the choice can answer: a key kept, an address given, or a plan with hosted answers.
  const ready = vendor ? !!keys[vendor] : choice === 'local' ? !!settings.localBaseUrl.trim() && !!settings.localModel.trim() : choice === 'hosted' && hosted;

  const start = async () => {
    await save({ setupDone: true });
    void browser.runtime.sendMessage({ type: 'setup:done' }).catch(() => {});
    window.close();
  };

  return (
    <div className="page setup">
      <header className="top">
        <div className="top-inner">
          <h1>Set up {BRAND.name}</h1>
          <span className="spacer" />
          <button type="button" className="close" title="Close" aria-label="Close" data-testid="close" onClick={() => window.close()}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      <main className="options">
        <section id="setup" data-testid="setup">
          <h2>Who answers?</h2>
          <div className="cards" role="radiogroup" aria-label="Who answers">
            {CHOICES.map((c) => (
              <label key={c.id} className={`card${choice === c.id ? ' on' : ''}`} data-testid={`setup-${c.id}`}>
                <input type="radio" name="setup" checked={choice === c.id} onChange={() => void save(patchFor(c.id, settings))} />
                <b>{c.name}</b>
                <small>{c.sub}</small>
              </label>
            ))}
          </div>

          {vendor && <KeyField key={vendor} vendor={vendor} hint={keys[vendor]} />}
          {choice === 'local' && <LocalServer settings={settings} save={save} />}
          {choice === 'hosted' && (
            <div className="sub" data-testid="setup-account">
              {account.user ? <SignedIn account={account} settings={settings} save={save} /> : <SignIn />}
            </div>
          )}
          {!choice && <p className="help">You can change this any time in Settings.</p>}
        </section>

        {MAC && (
          <section id="permissions" data-testid="setup-permissions">
            <h2>Seeing your screen</h2>
            <Permissions />
          </section>
        )}

        <div className="setup-end">
          <button type="button" className="primary" data-testid="setup-start" disabled={!ready} onClick={() => void start()}>
            Start using {BRAND.name}
          </button>
          <button type="button" className="link" data-testid="setup-skip" onClick={() => void save({ setupDone: true })}>
            Skip to all settings
          </button>
        </div>
      </main>
    </div>
  );
}
