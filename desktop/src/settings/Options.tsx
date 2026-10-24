/**
 * Settings, as a dashboard first (until the first-run setup is done,
 * Setup.tsx instead): the account and this month's answers at the top
 * (Dashboard.tsx), then the settings, the most used first, with a menu of
 * them at the side once they are reached:
 *
 *  1. Answers: who answers (your API key, hosted or a local model), and
 *     only what that choice needs below it.
 *  2. Asking: whether a selection is asked about straight away, and the
 *     default prompt.
 *  3. Macros: the buttons above the question box.
 *  4. Appearance: light or dark, and the colour theme.
 *  5. Selecting: the shortcut, adjusting a box, where the bar and panel go,
 *     notices.
 *  6. Chats & privacy: how many chats are kept, deleting them, what is sent.
 *  7. Account (signed in: cloud storage, deleting it), Permissions (macOS),
 *     and Juno (version, updates, login, the privacy policy and terms, Quit).
 *
 * Text is kept short: a label, and a line of help only where the choice
 * isn't clear without it. Every change saves as it is made, and a small
 * "Saved" confirms it. Writes read the latest stored settings first, so a
 * model picked in the panel meanwhile is never overwritten.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_MACROS, DEFAULT_PROMPT } from '@shared/prompts';
import { BRAND } from '@/brand';
import { ACCOUNTS } from '@/lib/account/config';
import { listChats } from '@/lib/chats';
import { UNLOCK } from '@/lib/account/unlock';
import { FREE_MACROS, withinPlan } from '@/lib/extras';
import type { KeyModel } from '@/lib/providers/byok';
import type { KeyStatus, KeyVendor as Vendor } from '@/lib/providers/types';
import {
  CHAT_LIMITS,
  getSettings,
  panelSizeItem,
  sanitizeMacros,
  settingsItem,
  type Macro,
  type PanelSize,
  type Scheme,
  type SendBehavior,
  type Settings,
} from '@/lib/storage';
import { Icon } from '@/ui/icons';
import { DEFAULT_THEME, THEMES } from '@/lib/themes';
import { hasHosted, useAccount, useExtrasOpen, type AccountState } from '@/ui/useAccount';
import { ModelSelect } from '@/ui/ModelPicker';
import { useKeyStatus } from '@/ui/useKeyStatus';
import { MAC } from '../os';
import { AppSection } from './AppSection';
import { choiceOf, keyPatch, patchFor, type Choice } from './choices';
import { Dashboard } from './Dashboard';
import { Intro } from './Intro';
import { KeyField } from './KeyField';
import { LocalServer } from './LocalServer';
import { Permissions } from './Permissions';
import { PlacePicker } from './PlacePicker';
import { Setup } from './Setup';
import { ShortcutField } from './ShortcutField';
import { ThemePicker } from './ThemePicker';
import { useDebounced } from './useDebounced';
import { AccountSection, SyncLine } from './Account';
import type { SyncStatus } from '@/lib/account/session';

/** Who can answer, the plan first (in a build with accounts: lib/account/config.ts). */
const CHOICES: { id: Choice; name: string; sub: string }[] = [
  ...(ACCOUNTS ? [{ id: 'hosted' as const, name: 'Your plan', sub: 'Hosted answers' }] : []),
  { id: 'key', name: 'API key', sub: 'Claude or ChatGPT' },
  { id: 'local', name: 'Local model', sub: 'This computer' },
];

const SCHEME_LABELS: { id: Scheme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];


const SEND: { id: SendBehavior; label: string; help?: string }[] = [
  { id: 'prefill', label: 'Wait for me' },
  { id: 'auto', label: 'Ask right away', help: 'With the default prompt, or the first macro.' },
];

/** The settings, the most used first; the side menu lists them. */
const SECTIONS = (signedIn: boolean) => [
  { id: 'answers', title: 'Answers' },
  { id: 'selecting', title: 'Selecting' },
  { id: 'asking', title: 'Asking' },
  { id: 'macros', title: 'Macros' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'privacy', title: 'Chats & privacy' },
  ...(ACCOUNTS && signedIn ? [{ id: 'account-settings', title: 'Account' }] : []),
  ...(MAC ? [{ id: 'permissions', title: 'Permissions' }] : []),
  { id: 'app', title: BRAND.name },
];

export function Options() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const keys = useKeyStatus();
  const [models, setModels] = useState<Partial<Record<Vendor, KeyModel[]>>>({});
  const [saved, setSaved] = useState(0);
  const account = useAccount();
  const extras = useExtrasOpen();

  useEffect(() => {
    void Promise.all([getSettings(), browser.storage.local.get('models')]).then(([s, m]) => {
      setSettings(s);
      setModels((m.models as Partial<Record<Vendor, KeyModel[]>> | undefined) ?? {});
    });
    // The panel's model picker writes the same settings; follow it.
    const unwatch = settingsItem.watch(() => void getSettings().then(setSettings));
    return unwatch;
  }, []);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(0), 1600);
    return () => clearTimeout(t);
  }, [saved]);

  // Writes go one at a time, each on top of the latest stored settings, so
  // two quick changes (a radio, then a debounced text field) never undo each
  // other. The screen updates at once rather than waiting for storage.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback((task: () => Promise<void>) => {
    const run = queue.current.then(task, task);
    queue.current = run.catch(() => {});
    return run;
  }, []);

  const save = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((s) => (s ? { ...s, ...patch } : s));
      return enqueue(async () => {
        await settingsItem.setValue({ ...(await getSettings()), ...patch });
        setSaved(Date.now());
      });
    },
    [enqueue],
  );

  const rememberModels = useCallback(async (vendor: Vendor, list: KeyModel[]) => {
    setModels((m) => ({ ...m, [vendor]: list }));
    const stored = ((await browser.storage.local.get('models')).models as Partial<Record<Vendor, KeyModel[]>> | undefined) ?? {};
    await browser.storage.local.set({ models: { ...stored, [vendor]: list } });
  }, []);

  if (!settings || !keys) return <main className="options" />;
  if (!settings.introSeen) return <Intro account={account} onDone={() => void save({ introSeen: true })} />;
  if (!settings.setupDone) return <Setup settings={settings} keys={keys} account={account} save={save} />;

  const sections = SECTIONS(!!account.user);
  return (
    <div className="page">
      <header className="top">
        <div className="top-inner">
          <h1>{BRAND.name}</h1>
          <span className="spacer" />
          <span className={`saved${saved ? ' on' : ''}`} data-testid="saved" aria-live="polite">
            {saved ? 'Saved' : ''}
          </span>
          <button type="button" className="close" title="Close" aria-label="Close" data-testid="close" onClick={() => window.close()}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      <main className="options">
        <Dashboard settings={settings} account={account} />
        <div className="layout">
          <SideMenu sections={sections} />
          <div className="sections">
            <AnswersSection
              settings={settings}
              keys={keys}
              models={models}
              account={account}
              save={save}
              onKeySaved={() => setSaved(Date.now())}
              rememberModels={rememberModels}
            />
            <SelectingSection settings={settings} save={save} locked={extras ? null : unlockLabel(account)} />
            <AskingSection settings={settings} save={save} />
            <MacrosSection settings={settings} save={save} locked={extras ? null : unlockLabel(account)} />
            <Section id="appearance" title="Appearance" sub="Light or dark, and Juno's colours.">
              <div className="field">
                <span className="field-label">Light or dark</span>
                <div className="segments" role="radiogroup" aria-label="Light or dark" data-testid="scheme">
                  {SCHEME_LABELS.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={settings.scheme === o.id}
                      data-scheme-choice={o.id}
                      onClick={() => void save({ scheme: o.id })}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              {extras ? (
                <ThemePicker value={settings.theme} onChange={(theme) => void save({ theme })} />
              ) : (
                <div className="themes-split">
                  <ThemePicker value={DEFAULT_THEME} themes={THEMES.filter((t) => t.id === DEFAULT_THEME)} onChange={() => {}} />
                  <Locked label={unlockLabel(account)} what="Every other theme">
                    <ThemePicker value={DEFAULT_THEME} themes={THEMES.filter((t) => t.id !== DEFAULT_THEME)} onChange={() => {}} />
                  </Locked>
                </div>
              )}
            </Section>
            <PrivacySection settings={settings} save={save} account={account} />
            <AccountSection account={account} />
            {MAC && (
              <Section id="permissions" title="Permissions" sub="What macOS lets Juno do.">
                <Permissions />
              </Section>
            )}
            <Section id="app" title={BRAND.name} sub="Version, updates, opening at login, and quitting.">
              <AppSection settings={settings} save={save} />
            </Section>
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * The settings, at the side: it fades in once the dashboard has scrolled
 * away (the settings are reached), and marks the one being read.
 */
function SideMenu({ sections }: { sections: { id: string; title: string }[] }) {
  const [shown, setShown] = useState(false);
  const [here, setHere] = useState(sections[0]?.id ?? '');
  const ids = sections.map((s) => s.id).join(' ');
  useEffect(() => {
    const page = document.querySelector('.page');
    const dashboard = document.getElementById('dashboard');
    if (!page || !dashboard) return;
    // Shown once less than a third of the dashboard is left on screen.
    const away = new IntersectionObserver(([e]) => setShown(!!e && e.intersectionRatio < 0.34), { root: page, threshold: [0, 0.34, 1] });
    away.observe(dashboard);
    // The section crossing the upper part of the window is the one being read.
    const reading = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setHere(top.target.id);
      },
      { root: page, rootMargin: '-15% 0px -70% 0px' },
    );
    for (const id of ids.split(' ')) {
      const el = document.getElementById(id);
      if (el) reading.observe(el);
    }
    return () => {
      away.disconnect();
      reading.disconnect();
    };
  }, [ids]);
  return (
    <nav className={`side${shown ? ' on' : ''}`} aria-label="Settings" aria-hidden={!shown} data-testid="side-menu">
      {sections.map((s) => (
        <a key={s.id} href={`#${s.id}`} className={here === s.id ? 'here' : undefined} tabIndex={shown ? 0 : -1}>
          {s.title}
        </a>
      ))}
    </nav>
  );
}

/** What a locked extra's button says: a guest can unlock this computer (where the build sells it), a signed-in account gets Plus (lib/extras.ts). */
const unlockLabel = (account: AccountState) => (account.user || !UNLOCK ? 'Get Plus' : 'Unlock');

/** A locked extra's way to it: why, and a white button to the plan (at the top, under who you are). */
function ToPlan({ label, what }: { label: string; what: string }) {
  return (
    <div className="to-plan" data-testid="to-plan">
      <span>
        {what}, with {label === 'Unlock' ? 'the unlock or Plus' : 'Plus'}.
      </span>
      <button type="button" className="unlock-btn" onClick={() => document.getElementById('account')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
        {label}
      </button>
    </div>
  );
}

/** A locked extra: greyed and out of reach, its way to the plan laid over it (`fit`: only as wide as it). */
function Locked({ label, what, fit = false, children }: { label: string; what: string; fit?: boolean; children: ReactNode }) {
  return (
    <div className={`locked-area${fit ? ' fit' : ''}`}>
      <div className="locked" inert>
        {children}
      </div>
      <ToPlan label={label} what={what} />
    </div>
  );
}

/** A section of settings: its title, a sentence on what it is for, and its fields. */
function Section({ id, title, sub, children }: { id: string; title: string; sub: string; children: ReactNode }) {
  return (
    <section id={id} data-testid={`section-${id}`}>
      <h2>{title}</h2>
      <p className="section-sub">{sub}</p>
      {children}
    </section>
  );
}

/** A group of radio buttons, each with an optional line under it. */
function Radios<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: { id: T; label: string; help?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="radios" role="radiogroup">
      {options.map((o, i) => (
        <label key={o.id} className="radio">
          <input type="radio" name={name} checked={value === o.id} onChange={() => onChange(o.id)} />
          <span>
            <b>
              {o.label}
              {i === 0 && <span className="default"> · default</span>}
            </b>
            {o.help && <small>{o.help}</small>}
          </span>
        </label>
      ))}
    </div>
  );
}

// ── 1. Answers ───────────────────────────────────────────────────────────

function AnswersSection({
  settings,
  keys,
  models,
  account,
  save,
  onKeySaved,
  rememberModels,
}: {
  settings: Settings;
  keys: KeyStatus;
  models: Partial<Record<Vendor, KeyModel[]>>;
  account: AccountState;
  save: (patch: Partial<Settings>) => Promise<void>;
  onKeySaved: () => void;
  rememberModels: (vendor: Vendor, list: KeyModel[]) => Promise<void>;
}) {
  const choice = choiceOf(settings);

  const choose = (next: Choice) => void save(patchFor(next, settings, keys));
  const hosted = hasHosted(account);

  return (
    <Section
      id="answers"
      title="Answers"
      sub={`Who answers: ${ACCOUNTS ? 'your plan, ' : ''}your own API key, or a model on this computer.`}
    >
      <div className="cards" role="radiogroup" aria-label="Who answers">
        {CHOICES.map((c) => (
          <label key={c.id} className={`card${choice === c.id ? ' on' : ''}`} data-testid={`answer-${c.id}`}>
            <input type="radio" name="answers" checked={choice === c.id} onChange={() => choose(c.id)} />
            <b>{c.name}</b>
            <small>{c.sub}</small>
          </label>
        ))}
      </div>
      <ModelSelect settings={settings} keys={keys} account={account} listed={models} />
      {choice === 'hosted' && !hosted && (
        <p className="help warn" data-testid="hosted-help">
          {account.user ? "Your plan doesn't include hosted answers yet: Plus does (at the top)." : 'Sign up or sign in at the top first.'}
        </p>
      )}

      {choice === 'key' && (
        <KeyAndModel
          settings={settings}
          keys={keys}
          save={save}
          onKeySaved={onKeySaved}
          rememberModels={rememberModels}
        />
      )}
      {choice === 'local' && <LocalServer settings={settings} save={save} />}
    </Section>
  );
}

/** Your own key, Anthropic's or OpenAI's (the model is picked above, with the rest). */
function KeyAndModel({
  settings,
  keys,
  save,
  onKeySaved,
  rememberModels,
}: {
  settings: Settings;
  keys: KeyStatus;
  save: (patch: Partial<Settings>) => Promise<void>;
  onKeySaved: () => void;
  rememberModels: (vendor: Vendor, list: KeyModel[]) => Promise<void>;
}) {
  return (
    <div className="sub" data-testid="keys">
      <KeyField
        keys={keys}
        current={settings.vendor}
        onUse={(v) => void save(keyPatch(v, settings))}
        onSaved={onKeySaved}
        onChecked={(v, models) => void rememberModels(v, models)}
      />
    </div>
  );
}

// ── 3. Asking ────────────────────────────────────────────────────────────

function AskingSection({ settings, save }: { settings: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const [prompt, setPrompt] = useState(settings.defaultPrompt);
  const savePrompt = useDebounced((v: string) => void save({ defaultPrompt: v.trim() ? v : DEFAULT_PROMPT }));
  return (
    <Section id="asking" title="Asking" sub="What happens once a selection is made.">
      <div className="field">
        <span className="field-label">After you select</span>
        <Radios name="send" value={settings.sendBehavior} options={SEND} onChange={(v) => void save({ sendBehavior: v })} />
      </div>

      <label className="field">
        <span className="field-label">Default prompt</span>
        <small className="help">Fills the question box after each selection.</small>
        <input
          value={prompt}
          maxLength={120}
          data-testid="default-prompt"
          placeholder="Empty"
          onChange={(e) => {
            setPrompt(e.target.value);
            savePrompt(e.target.value);
          }}
        />
      </label>
    </Section>
  );
}

/** The macros: each a card with its button name, its content and ✕; past the free ones, greyed while the extras are locked. */
function MacrosSection({ settings, save, locked }: { settings: Settings; save: (patch: Partial<Settings>) => Promise<void>; locked: string | null }) {
  const [macros, setMacros] = useState<Macro[]>(settings.macros);
  // Blank cards are drafts nobody finished; they are kept on screen, not saved.
  const saveMacros = useDebounced((ms: Macro[]) => void save({ macros: sanitizeMacros(ms.filter((m) => m.name.trim() && m.prompt.trim())) }));
  const update = (next: Macro[]) => {
    setMacros(next);
    saveMacros(next);
  };
  const changed = JSON.stringify(macros.map(({ name, prompt: p }) => ({ name, p }))) !== JSON.stringify(DEFAULT_MACROS.map(({ name, prompt: p }) => ({ name, p })));
  // While the extras are locked, the macros past the free ones are greyed, under the way to the plan.
  const cut = locked ? Math.min(FREE_MACROS, macros.length) : macros.length;
  const row = (m: Macro, i: number) => (
    <li key={m.id} className="macro-row" data-testid="macro-row">
      <input
        className="macro-name"
        value={m.name}
        placeholder="Button name"
        aria-label="Button name"
        maxLength={24}
        onChange={(e) => update(macros.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
      />
      <textarea
        className="macro-prompt"
        rows={2}
        value={m.prompt}
        placeholder="Content"
        aria-label="Content"
        onChange={(e) => update(macros.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)))}
      />
      <button type="button" className="tool" title="Remove" aria-label={`Remove ${m.name || 'macro'}`} onClick={() => update(macros.filter((_, j) => j !== i))}>
        ✕
      </button>
    </li>
  );
  const what = `More than ${FREE_MACROS} macros`;

  return (
    <Section id="macros" title="Macros" sub="Saved questions, one click each, above the question box.">
      <div className="field" data-testid="asking">
        {changed && (
          <button type="button" className="link" onClick={() => update(DEFAULT_MACROS.map((m) => ({ ...m })))}>
            Reset to the defaults
          </button>
        )}
        <ol className="macro-list">{macros.slice(0, cut).map(row)}</ol>
        {locked && cut < macros.length && (
          <Locked label={locked} what={what}>
            <ol className="macro-list">{macros.slice(cut).map((m, i) => row(m, cut + i))}</ol>
          </Locked>
        )}
        <button
          type="button"
          className="secondary"
          data-testid="add-macro"
          disabled={macros.length >= (locked ? FREE_MACROS : 8)}
          onClick={() => setMacros([...macros, { id: `macro-${Date.now().toString(36)}`, name: '', prompt: '' }])}
        >
          Add macro
        </button>
        {locked && cut === macros.length && <ToPlan label={locked} what={what} />}
      </div>
    </Section>
  );
}

// ── 2. Selecting ─────────────────────────────────────────────────────────

/** The bar's place and the panel's (lib/extras.ts says which, while the extras are locked). */
function Places({ place, save }: { place: Pick<Settings, 'barPlace' | 'panelPlace'>; save: (patch: Partial<Settings>) => Promise<void> }) {
  return (
    <div className="places">
      <PlacePicker label="Bar" value={place.barPlace} onChange={(v) => void save({ barPlace: v })} />
      <PlacePicker label="Panel" value={place.panelPlace} onChange={(v) => void save({ panelPlace: v })} />
    </div>
  );
}

function SelectingSection({ settings, save, locked }: { settings: Settings; save: (patch: Partial<Settings>) => Promise<void>; locked: string | null }) {
  const place = withinPlan(settings, !locked);
  return (
    <Section id="selecting" title="Selecting" sub="How a selection starts, and where the bar and the panel appear.">
      <ShortcutField />

      <div className="field">
        <span className="field-label">After drawing a selection</span>
        <Radios
          name="adjust"
          value={settings.adjustBox ? 'adjust' : 'send'}
          options={[
            { id: 'send', label: 'Send right away' },
            { id: 'adjust', label: 'Let me adjust it first', help: 'Then press Enter to send.' },
          ]}
          onChange={(v) => void save({ adjustBox: v === 'adjust' })}
        />
      </div>

      <div className="field" data-testid="places">
        <span className="field-label">Where the bar and the panel go</span>
        {locked ? (
          <Locked label={locked} what="Your own place for them" fit>
            <Places place={place} save={save} />
          </Locked>
        ) : (
          <Places place={place} save={save} />
        )}
        <PanelSizeNote />
      </div>
    </Section>
  );
}

/** The size the student gave the panel by hand (panel/fit.ts), which it opens at; it can be forgotten here. */
function PanelSizeNote() {
  const [size, setSize] = useState<PanelSize | null>(null);
  useEffect(() => {
    void panelSizeItem.getValue().then(setSize, () => {});
    return panelSizeItem.watch(setSize);
  }, []);
  if (!size) return null;
  return (
    <small className="help" data-testid="panel-size">
      Panel size kept at {Math.round(size.width)} × {Math.round(size.height)}.{' '}
      <button type="button" className="link" onClick={() => void panelSizeItem.setValue(null)}>
        Reset
      </button>
    </small>
  );
}

// ── 4. Chats & privacy ───────────────────────────────────────────────────

/** Chats (where, how many, temporary or not), then what is sent, then the panel's notices. */
function PrivacySection({
  settings,
  save,
  account,
}: {
  settings: Settings;
  save: (patch: Partial<Settings>) => Promise<void>;
  account: AccountState;
}) {
  // Chats go to the cloud only for an account that has cloud storage and keeps them there (the default).
  const offered = !!account.user && !!account.entitlement?.cloud;
  const cloud = offered && settings.cloudSync;

  return (
    <Section id="privacy" title="Chats & privacy" sub="Where your chats are kept, what Juno sends, and its notices.">
      <ChatsField settings={settings} offered={offered} sync={account.sync} save={save} />

      <div className="field" data-testid="what-is-sent">
        <span className="field-label">What's sent</span>
        <p className="help">
          Each question goes to whoever answers it with the rest of its chat, screenshots included; keys and chats are kept on this computer
          {cloud ? ', chats in your account too' : ''}.
        </p>
        <ul className="help facts">
          <li>
            <b>Claude, ChatGPT</b>: not used for training; deleted within 30 days.
          </li>
          {hasHosted(account) && (
            <li>
              <b>Hosted</b>: through our server, which keeps no copy.
            </li>
          )}
          <li>
            <b>Local model</b>: nothing leaves this computer.
          </li>
          <li>
            <b>Temporary chats</b>: never saved{ACCOUNTS ? ' or synced' : ''}.
          </li>
          {ACCOUNTS && (
            <li>
              <b>Account</b>: your email, and your chats unless you keep them on this computer.
            </li>
          )}
        </ul>
      </div>

      <div className="field" id="notices">
        <span className="field-label">Notices</span>
        <label className="check">
          <input type="checkbox" checked={settings.panelNotices} data-testid="panel-notices" onChange={(e) => void save({ panelNotices: e.target.checked })} />
          Notices in the panel
        </label>
        <small className="help">Problems like a missing key, gone after 5 seconds.</small>
      </div>
    </Section>
  );
}

/**
 * Where chats are kept: in the account (the default, for a plan with cloud
 * storage; signing out takes them off this computer) or on this computer
 * only, which says what that means.
 */
function StorageField({ settings, offered, sync, save }: { settings: Settings; offered: boolean; sync: SyncStatus; save: (patch: Partial<Settings>) => Promise<void> }) {
  const cloud = offered && settings.cloudSync;
  const options = [
    { id: 'cloud', label: 'Your account', on: cloud, disabled: !offered, patch: { cloudSync: true } },
    { id: 'local', label: 'This computer', on: !cloud, disabled: false, patch: { cloudSync: false } },
  ];
  return (
    <div className="storage">
      <div className="segments" role="radiogroup" aria-label="Where chats are kept" data-testid="storage">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={o.on}
            disabled={o.disabled}
            data-storage={o.id}
            onClick={() => void save(o.patch)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {cloud ? (
        <>
          <small className="help">On every computer you sign in on, and off this one when you sign out.</small>
          <SyncLine status={sync} />
        </>
      ) : offered ? (
        <p className="help warn" data-testid="local-notice">
          Only on this computer, where they stay after you sign out: anyone who uses it can open them in Juno.
        </p>
      ) : (
        <small className="help">Your account keeps them with Plus.</small>
      )}
    </div>
  );
}

/**
 * The chats: where they are kept, how many, whether new ones are temporary,
 * and a way to clear them. Keeping fewer than there are, or deleting them
 * all, asks first, since neither can be undone.
 */
function ChatsField({ settings, offered, sync, save }: { settings: Settings; offered: boolean; sync: SyncStatus; save: (patch: Partial<Settings>) => Promise<void> }) {
  const limit = settings.chatLimit;
  const cloud = offered && settings.cloudSync;
  const [count, setCount] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<{ kind: 'all' } | { kind: 'limit'; to: number } | null>(null);
  useEffect(() => {
    const refresh = () => void listChats().then((l) => setCount(l.length));
    refresh();
    const onChanged = (changes: Record<string, unknown>, area: string) => area === 'local' && 'chatIndex' in changes && refresh();
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);
  const pickLimit = (to: number) => {
    if (count !== null && to < count) setConfirming({ kind: 'limit', to });
    else {
      setConfirming(null);
      void save({ chatLimit: to });
    }
  };
  return (
    <div className="field" data-testid="chats">
      <span className="field-label">Chats</span>
      {ACCOUNTS && <StorageField settings={settings} offered={offered} sync={sync} save={save} />}
      <label className="key-row limit-row">
        <span>Keep my</span>
        <select
          value={confirming?.kind === 'limit' ? confirming.to : limit}
          data-testid="chat-limit-select"
          // Until the chats are counted there is no telling whether a lower limit deletes any.
          disabled={count === null}
          onChange={(e) => pickLimit(Number(e.target.value))}
        >
          {CHAT_LIMITS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span>{(confirming?.kind === 'limit' ? confirming.to : limit) === 1 ? 'most recent chat' : 'most recent chats'}</span>
      </label>
      <small className="help">
        {cloud ? 'Past the limit, the oldest leaves this computer but stays in your account.' : 'Past the limit, the oldest is deleted.'}
      </small>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.temporaryByDefault}
          data-testid="temporary-default"
          onChange={(e) => void save({ temporaryByDefault: e.target.checked })}
        />
        Start every chat as temporary
      </label>
      <small className="help">Never saved{ACCOUNTS ? ' or synced' : ''}; the ghost turns it off for one chat.</small>
      {confirming?.kind === 'limit' ? (
        <div className="confirm-row">
          <span>
            Keep only your {confirming.to} most recent chats? The other {(count ?? 0) - confirming.to} will be deleted
            {cloud ? ' from this computer (your account keeps them).' : ". This can't be undone."}
          </span>
          <button
            type="button"
            className="danger"
            data-testid="confirm-chat-limit"
            onClick={() => {
              void save({ chatLimit: confirming.to });
              setConfirming(null);
            }}
          >
            Delete {(count ?? 0) - confirming.to}
          </button>
          <button type="button" className="secondary" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      ) : confirming?.kind === 'all' ? (
        <div className="confirm-row">
          <span>
            Delete all {count} saved chats{cloud ? ', here and in your account' : ''}? This can't be undone.
          </span>
          <button
            type="button"
            className="danger"
            data-testid="confirm-delete-chats"
            onClick={() => void browser.runtime.sendMessage({ type: 'chats:delete-all' }).then(() => setConfirming(null))}
          >
            Delete all
          </button>
          <button type="button" className="secondary" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="danger" data-testid="delete-chats" disabled={!count} onClick={() => setConfirming({ kind: 'all' })}>
          {count ? `Delete all chats (${count})` : 'No saved chats'}
        </button>
      )}
    </div>
  );
}
