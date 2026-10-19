/**
 * Settings, as a dashboard first (until the first-run setup is done,
 * Setup.tsx instead): the account and this month's answers at the top
 * (Dashboard.tsx), then the settings, the most used first, with a menu of
 * them at the side once they are reached:
 *
 *  1. Answers: who answers (your API key, hosted or a local model), and
 *     only what that choice needs below it.
 *  2. Asking: the macros, the default prompt, and whether a selection is
 *     asked about straight away.
 *  3. Appearance: light or dark, and the colour theme.
 *  4. Selecting: the shortcut, adjusting a box, where the bar and panel go.
 *  5. Chats & privacy: how many chats are kept, deleting them, what is sent.
 *  6. Account (signed in: cloud storage, deleting it), Permissions (macOS),
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
import { MAJOR_MODELS, MODEL_NAMES, MODEL_TABLE } from '@/lib/router';
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
import { hasHosted, useAccount, type AccountState } from '@/ui/useAccount';
import { useKeyStatus } from '@/ui/useKeyStatus';
import { MAC } from '../os';
import { AppSection } from './AppSection';
import { choiceOf, keyPatch, patchFor, type Choice } from './choices';
import { Dashboard } from './Dashboard';
import { KeyField } from './KeyField';
import { LocalServer } from './LocalServer';
import { Permissions } from './Permissions';
import { PlacePicker } from './PlacePicker';
import { Setup } from './Setup';
import { ShortcutField } from './ShortcutField';
import { ThemePicker } from './ThemePicker';
import { useDebounced } from './useDebounced';
import { AccountSection } from './Account';

const CHOICES: { id: Choice; name: string; sub: string }[] = [
  { id: 'key', name: 'API key', sub: 'Claude or ChatGPT' },
  { id: 'hosted', name: 'Hosted', sub: 'Your plan' },
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
  { id: 'asking', title: 'Asking' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'selecting', title: 'Selecting' },
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
        <Dashboard settings={settings} keys={keys} account={account} />
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
            <AskingSection settings={settings} save={save} />
            <Section id="appearance" title="Appearance">
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
              <ThemePicker value={settings.theme} onChange={(theme) => void save({ theme })} />
            </Section>
            <SelectingSection settings={settings} save={save} />
            <PrivacySection settings={settings} save={save} account={account} />
            <AccountSection account={account} settings={settings} save={save} />
            {MAC && (
              <Section id="permissions" title="Permissions">
                <Permissions />
              </Section>
            )}
            <Section id="app" title={BRAND.name}>
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

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} data-testid={`section-${id}`}>
      <h2>{title}</h2>
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
  // Offered once the account's plan includes hosted answers (or already picked).
  const hosted = hasHosted(account);
  const offered = CHOICES.filter((c) => c.id !== 'hosted' || hosted || choice === 'hosted');
  const ent = account.entitlement;

  return (
    <Section id="answers" title="Answers">
      <div className="cards" role="radiogroup" aria-label="Who answers">
        {offered.map((c) => (
          <label key={c.id} className={`card${choice === c.id ? ' on' : ''}`} data-testid={`answer-${c.id}`}>
            <input type="radio" name="answers" checked={choice === c.id} onChange={() => choose(c.id)} />
            <b>{c.name}</b>
            <small>{c.sub}</small>
          </label>
        ))}
      </div>
      {choice === 'hosted' &&
        (hosted && ent ? (
          <p className="help" data-testid="hosted-help">
            {Math.max(0, ent.quota - ent.used)} of {ent.quota} left this month.
          </p>
        ) : (
          <p className="help warn" data-testid="hosted-help">
            {account.user ? "Your plan doesn't include hosted answers." : 'Sign in under Account first.'}
          </p>
        ))}

      {choice === 'key' && (
        <KeyAndModel
          settings={settings}
          keys={keys}
          listed={models[settings.vendor]}
          save={save}
          onKeySaved={onKeySaved}
          rememberModels={rememberModels}
        />
      )}
      {choice === 'local' && <LocalServer settings={settings} save={save} />}
    </Section>
  );
}

function KeyAndModel({
  settings,
  keys,
  listed,
  save,
  onKeySaved,
  rememberModels,
}: {
  settings: Settings;
  keys: KeyStatus;
  listed: KeyModel[] | undefined;
  save: (patch: Partial<Settings>) => Promise<void>;
  onKeySaved: () => void;
  rememberModels: (vendor: Vendor, list: KeyModel[]) => Promise<void>;
}) {
  const vendor = settings.vendor;
  const table = MODEL_TABLE[vendor];
  const override = settings.modelOverride?.vendor === vendor ? settings.modelOverride.model : '';
  // Selections are screenshots: only models that read images are offered (one picked before stays, marked).
  const choices: KeyModel[] = (listed ?? MAJOR_MODELS[vendor].map((id) => ({ id, name: MODEL_NAMES[id] ?? id, vision: true }))).filter(
    (m) => m.vision || m.id === override,
  );

  return (
    <div className="sub" data-testid="keys">
      <KeyField
        keys={keys}
        current={vendor}
        onUse={(v) => void save(keyPatch(v, settings))}
        onSaved={onKeySaved}
        onChecked={(v, models) => void rememberModels(v, models)}
      />

      {keys[vendor] && (
      <label className="field">
        <span className="field-label">Model</span>
        <select
          value={override}
          data-testid="model-select"
          onChange={(e) => void save({ modelOverride: e.target.value ? { vendor, model: e.target.value } : null })}
        >
          <option value="">
            Automatic — {MODEL_NAMES[table.large]}
          </option>
          {choices.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.vision ? '' : " (can't read screenshots)"}
            </option>
          ))}
          {override && !choices.some((m) => m.id === override) && <option value={override}>{override}</option>}
        </select>
        {!listed && <small className="help">Check your key to see every model.</small>}
      </label>
      )}
    </div>
  );
}

// ── 2. Asking ────────────────────────────────────────────────────────────

function AskingSection({ settings, save }: { settings: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const [macros, setMacros] = useState<Macro[]>(settings.macros);
  const [prompt, setPrompt] = useState(settings.defaultPrompt);
  // Blank rows are drafts nobody finished; they are kept on screen, not saved.
  const saveMacros = useDebounced((ms: Macro[]) => void save({ macros: sanitizeMacros(ms.filter((m) => m.name.trim() && m.prompt.trim())) }));
  const savePrompt = useDebounced((v: string) => void save({ defaultPrompt: v.trim() ? v : DEFAULT_PROMPT }));

  const update = (next: Macro[]) => {
    setMacros(next);
    saveMacros(next);
  };
  const changed = JSON.stringify(macros.map(({ name, prompt: p }) => ({ name, p }))) !== JSON.stringify(DEFAULT_MACROS.map(({ name, prompt: p }) => ({ name, p })));

  return (
    <Section id="asking" title="Asking">
      <div className="field" data-testid="asking">
        <div className="head">
          <span className="field-label">Macros</span>
          {changed && (
            <button type="button" className="link" onClick={() => update(DEFAULT_MACROS.map((m) => ({ ...m })))}>
              Reset
            </button>
          )}
        </div>
        <ol className="macro-list">
          {macros.map((m, i) => (
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
                placeholder="What it asks"
                aria-label="Prompt"
                onChange={(e) => update(macros.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)))}
              />
              <button type="button" className="tool" title="Remove" aria-label={`Remove ${m.name || 'macro'}`} onClick={() => update(macros.filter((_, j) => j !== i))}>
                ✕
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="secondary"
          data-testid="add-macro"
          disabled={macros.length >= 8}
          onClick={() => setMacros([...macros, { id: `macro-${Date.now().toString(36)}`, name: '', prompt: '' }])}
        >
          Add macro
        </button>
      </div>

      <label className="field">
        <span className="field-label">Default prompt</span>
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
        <small className="help">Fills the question box after each selection.</small>
      </label>

      <div className="field">
        <span className="field-label">After you select</span>
        <Radios name="send" value={settings.sendBehavior} options={SEND} onChange={(v) => void save({ sendBehavior: v })} />
      </div>
    </Section>
  );
}

// ── 3. Selecting ─────────────────────────────────────────────────────────

function SelectingSection({ settings, save }: { settings: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  return (
    <Section id="selecting" title="Selecting">
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
        <div className="places">
          <PlacePicker label="Bar" value={settings.barPlace} onChange={(v) => void save({ barPlace: v })} />
          <PlacePicker label="Panel" value={settings.panelPlace} onChange={(v) => void save({ panelPlace: v })} />
        </div>
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

function PrivacySection({
  settings,
  save,
  account,
}: {
  settings: Settings;
  save: (patch: Partial<Settings>) => Promise<void>;
  account: AccountState;
}) {
  // Chats go to the cloud only for an account that has cloud storage and turned it on.
  const cloud = !!account.user && !!account.entitlement?.cloud && settings.cloudSync;

  return (
    <Section id="privacy" title="Chats & privacy">
      <ChatsField limit={settings.chatLimit} cloud={cloud} save={save} />

      <div className="field" data-testid="what-is-sent">
        <span className="field-label">What's sent</span>
        <p className="help">
          Only your selection and its window's title, to the AI you picked. Keys and chats stay on this computer
          {cloud ? ' (chats also in your account)' : ''}, in files only your account can read.
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
              <b>Account</b>: your email; chats sync only if you turn it on.
            </li>
          )}
        </ul>
      </div>
    </Section>
  );
}

/**
 * How many chats are kept, and a way to clear them. Keeping fewer than there
 * are, or deleting them all, asks first, since neither can be undone.
 */
function ChatsField({ limit, cloud, save }: { limit: number; cloud: boolean; save: (patch: Partial<Settings>) => Promise<void> }) {
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
      <p className="help">
        {cloud ? 'Past the limit, the oldest leaves this computer but stays in your account.' : 'Past the limit, the oldest is deleted.'}
      </p>
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
        <button type="button" className="secondary" data-testid="delete-chats" disabled={!count} onClick={() => setConfirming({ kind: 'all' })}>
          {count ? `Delete all chats (${count})` : 'No saved chats'}
        </button>
      )}
    </div>
  );
}
