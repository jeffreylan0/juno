/**
 * Settings, in the order a student meets them:
 *
 *  1. Answers: who answers (Claude, ChatGPT, hosted, a local model or
 *     placeholder answers), and only what that choice needs below it.
 *  2. Asking: the macros, the default prompt, and whether a selection is
 *     asked about straight away.
 *  3. Selecting: the shortcut, adjusting a box, where the bar and panel go.
 *  4. Appearance: the colour theme.
 *  5. Chats & privacy: how many chats are kept, deleting them, what is sent.
 *  6. Permissions (macOS), Juno (version, updates, login, Quit), and
 *     Account in builds with accounts (Account.tsx).
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
import { COMPANY, MAJOR_MODELS, MODEL_NAMES, MODEL_TABLE } from '@/lib/router';
import type { KeyModel, KeyTestResult } from '@/lib/providers/byok';
import {
  CHAT_LIMITS,
  getKeys,
  getSettings,
  keysItem,
  panelSizeItem,
  sanitizeMacros,
  settingsItem,
  type Keys,
  type Macro,
  type PanelSize,
  type SendBehavior,
  type Settings,
} from '@/lib/storage';
import type { AiStatus } from '@/lib/status';
import { Icon } from '@/ui/icons';
import { hasHosted, useAccount, type AccountState } from '@/ui/useAccount';
import { MAC } from '../os';
import { AppSection } from './AppSection';
import { Permissions } from './Permissions';
import { PlacePicker } from './PlacePicker';
import { ShortcutField } from './ShortcutField';
import { ThemePicker } from './ThemePicker';
import { AccountSection } from './Account';

type Vendor = 'anthropic' | 'openai';
type Choice = 'claude' | 'chatgpt' | 'hosted' | 'local' | 'placeholder';

const CHOICES: { id: Choice; name: string; sub: string }[] = [
  { id: 'claude', name: 'Claude', sub: 'Your key' },
  { id: 'chatgpt', name: 'ChatGPT', sub: 'Your key' },
  { id: 'hosted', name: 'Hosted', sub: 'Your plan' },
  { id: 'local', name: 'Local model', sub: 'This computer' },
  { id: 'placeholder', name: 'Placeholder', sub: 'No AI' },
];

const VENDOR_OF: Partial<Record<Choice, Vendor>> = { claude: 'anthropic', chatgpt: 'openai' };
const KEY_HINT: Record<Vendor, string> = { anthropic: 'sk-ant-…', openai: 'sk-…' };
const KEY_PAGE: Record<Vendor, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
};

const SEND: { id: SendBehavior; label: string; help?: string }[] = [
  { id: 'prefill', label: 'Wait for me' },
  { id: 'auto', label: 'Ask right away', help: 'With the default prompt, or the first macro.' },
];

const SECTIONS = [
  { id: 'answers', title: 'Answers' },
  { id: 'asking', title: 'Asking' },
  { id: 'selecting', title: 'Selecting' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'privacy', title: 'Chats & privacy' },
  ...(MAC ? [{ id: 'permissions', title: 'Permissions' }] : []),
  { id: 'app', title: BRAND.name },
  ...(ACCOUNTS ? [{ id: 'account', title: 'Account' }] : []),
];

type Check = { state: 'idle' } | { state: 'checking' } | KeyTestResult;

function choiceOf(s: Settings): Choice | null {
  if (s.provider === 'mock') return 'placeholder';
  if (s.provider === 'local') return 'local';
  if (s.provider === 'byok') return s.vendor === 'openai' ? 'chatgpt' : 'claude';
  return 'hosted';
}

/**
 * Calls `fn` once typing pauses. A change still waiting when the field goes
 * away (another choice picked) or the page is left is saved right then, not
 * dropped.
 */
function useDebounced<T>(fn: (value: T) => void, ms = 450): (value: T) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<{ value: T } | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const flush = () => {
      clearTimeout(timer.current);
      if (!pending.current) return;
      const { value } = pending.current;
      pending.current = null;
      latest.current(value);
    };
    addEventListener('pagehide', flush);
    return () => {
      removeEventListener('pagehide', flush);
      flush();
    };
  }, []);
  return useCallback(
    (value: T) => {
      clearTimeout(timer.current);
      pending.current = { value };
      timer.current = setTimeout(() => {
        pending.current = null;
        latest.current(value);
      }, ms);
    },
    [ms],
  );
}

export function Options() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keys, setKeys] = useState<Keys>({ anthropic: '', openai: '', session: '' });
  const [models, setModels] = useState<Partial<Record<Vendor, KeyModel[]>>>({});
  const [saved, setSaved] = useState(0);
  const account = useAccount();

  useEffect(() => {
    void Promise.all([getSettings(), getKeys(), browser.storage.local.get('models')]).then(([s, k, m]) => {
      setSettings(s);
      setKeys(k);
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

  const saveKey = useCallback(
    (vendor: Vendor, key: string) => {
      setKeys((k) => ({ ...k, [vendor]: key.trim() }));
      return enqueue(async () => {
        await keysItem.setValue({ ...(await getKeys()), [vendor]: key.trim() });
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

  if (!settings) return <main className="options" />;

  return (
    <div className="page">
      <header className="top">
        <div className="top-inner">
          <h1>{BRAND.name}</h1>
          <nav className="tabs" aria-label="Sections">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`}>
                {s.title}
              </a>
            ))}
          </nav>
          <span className={`saved${saved ? ' on' : ''}`} data-testid="saved" aria-live="polite">
            {saved ? 'Saved' : ''}
          </span>
          <button type="button" className="close" title="Close" aria-label="Close" data-testid="close" onClick={() => window.close()}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      <main className="options">
        <AnswersSection
          settings={settings}
          keys={keys}
          models={models}
          account={account}
          save={save}
          saveKey={saveKey}
          rememberModels={rememberModels}
        />
        <AskingSection settings={settings} save={save} />
        <SelectingSection settings={settings} save={save} />
        <Section id="appearance" title="Appearance">
          <ThemePicker value={settings.theme} onChange={(theme) => void save({ theme })} />
        </Section>
        <PrivacySection settings={settings} save={save} account={account} />
        {MAC && (
          <Section id="permissions" title="Permissions">
            <Permissions />
          </Section>
        )}
        <Section id="app" title={BRAND.name}>
          <AppSection settings={settings} save={save} />
        </Section>
        <AccountSection account={account} settings={settings} save={save} />
      </main>
    </div>
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
  saveKey,
  rememberModels,
}: {
  settings: Settings;
  keys: Keys;
  models: Partial<Record<Vendor, KeyModel[]>>;
  account: AccountState;
  save: (patch: Partial<Settings>) => Promise<void>;
  saveKey: (vendor: Vendor, key: string) => Promise<void>;
  rememberModels: (vendor: Vendor, list: KeyModel[]) => Promise<void>;
}) {
  const choice = choiceOf(settings);
  const vendor = choice ? VENDOR_OF[choice] : undefined;

  const choose = (next: Choice) => {
    const v = VENDOR_OF[next];
    if (v) {
      // Coming back to a vendor keeps the model picked for it before.
      const keep = settings.modelOverride?.vendor === v ? settings.modelOverride : null;
      void save({ provider: 'byok', vendor: v, modelOverride: keep });
    } else if (next === 'hosted') {
      // Hosted answers use Claude's fast model (shared/models.ts).
      void save({ provider: 'gateway', vendor: 'anthropic', modelOverride: null });
    } else void save({ provider: next === 'local' ? 'local' : 'mock' });
  };
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

      {vendor && (
        <KeyAndModel
          key={vendor}
          vendor={vendor}
          settings={settings}
          savedKey={keys[vendor]}
          listed={models[vendor]}
          save={save}
          saveKey={saveKey}
          rememberModels={rememberModels}
        />
      )}
      {choice === 'local' && <LocalServer settings={settings} save={save} />}
      {choice === 'placeholder' && (
        <p className="help" data-testid="placeholder-help">
          Made-up answers for trying it out. Nothing is sent.
        </p>
      )}
    </Section>
  );
}

function KeyAndModel({
  vendor,
  settings,
  savedKey,
  listed,
  save,
  saveKey,
  rememberModels,
}: {
  vendor: Vendor;
  settings: Settings;
  savedKey: string;
  listed: KeyModel[] | undefined;
  save: (patch: Partial<Settings>) => Promise<void>;
  saveKey: (vendor: Vendor, key: string) => Promise<void>;
  rememberModels: (vendor: Vendor, list: KeyModel[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState(savedKey);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const lastChecked = useRef('');
  const table = MODEL_TABLE[vendor];
  const override = settings.modelOverride?.vendor === vendor ? settings.modelOverride.model : '';
  // Selections are screenshots: only models that read images are offered (one picked before stays, marked).
  const choices: KeyModel[] = (listed ?? MAJOR_MODELS[vendor].map((id) => ({ id, name: MODEL_NAMES[id] ?? id, vision: true }))).filter(
    (m) => m.vision || m.id === override,
  );
  const checking = 'state' in check && check.state === 'checking';

  const run = async (key: string) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    lastChecked.current = trimmed;
    setCheck({ state: 'checking' });
    await saveKey(vendor, trimmed);
    let result: KeyTestResult;
    try {
      result = (await browser.runtime.sendMessage({ type: 'keys:test', vendor, key: trimmed })) as KeyTestResult;
    } catch (err) {
      result = { ok: false, error: `Couldn't check it: ${(err as Error).message}`, code: 'http' };
    }
    setCheck(result);
    if (result.ok) await rememberModels(vendor, result.models);
  };

  return (
    <div className="sub" data-testid="keys">
      <div className="field">
        <span className="field-label">
          {COMPANY[vendor]} API key ·{' '}
          <a className="link" href={KEY_PAGE[vendor]} target="_blank" rel="noopener noreferrer">
            get one
          </a>
        </span>
        <span className="key-row">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${COMPANY[vendor]} API key`}
            placeholder={KEY_HINT[vendor]}
            value={draft}
            data-testid="key-input"
            onChange={(e) => {
              setDraft(e.target.value);
              setCheck({ state: 'idle' });
            }}
            // A pasted or edited key is checked (free) as soon as you leave the
            // field; an emptied one is removed from this browser.
            onBlur={() => {
              const trimmed = draft.trim();
              if (!trimmed) {
                if (savedKey) void saveKey(vendor, '');
                lastChecked.current = '';
                return;
              }
              if (trimmed !== lastChecked.current) void run(draft);
            }}
          />
          <button type="button" className="secondary" data-testid="test-key" disabled={!draft.trim() || checking} onClick={() => void run(draft)}>
            {checking ? 'Checking…' : 'Check key'}
          </button>
        </span>
        <KeyStatus check={check} hasKey={!!savedKey} />
        <p className="help">Kept privately on this computer, and sent only to {COMPANY[vendor]}.</p>
      </div>

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
    </div>
  );
}

function KeyStatus({ check, hasKey }: { check: Check; hasKey: boolean }) {
  if ('state' in check && check.state === 'checking') return <p className="help">Checking…</p>;
  if (!('ok' in check)) return hasKey ? null : <p className="help warn">Needed to ask anything.</p>;
  if (check.ok) {
    const vision = check.models.filter((m) => m.vision).length;
    return (
      <p className="help ok" data-testid="key-status">
        ✓ Works. {check.models.length} models{vision !== check.models.length ? `, ${vision} read images` : ''}.
      </p>
    );
  }
  return (
    <p className="help bad" data-testid="key-status">
      {check.error}
    </p>
  );
}

/** Whether a local-model address is somewhere else: 'plain' over unencrypted HTTP, 'remote' over HTTPS, null on this computer. */
function offComputer(address: string): 'plain' | 'remote' | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (/^(localhost|127(\.\d+){3}|\[::1\])$/i.test(url.hostname)) return null;
  return url.protocol === 'https:' ? 'remote' : 'plain';
}

function LocalServer({ settings, save }: { settings: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const [url, setUrl] = useState(settings.localBaseUrl);
  const [model, setModel] = useState(settings.localModel);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const saveUrl = useDebounced((v: string) => void save({ localBaseUrl: v.trim() }));
  const saveModel = useDebounced((v: string) => void save({ localModel: v.trim() }));

  const check = async () => {
    setChecking(true);
    await save({ localBaseUrl: url.trim(), localModel: model.trim() });
    const s = (await browser.runtime.sendMessage({ type: 'ai:check', force: true }).catch(() => null)) as AiStatus | null;
    setStatus(s);
    setChecking(false);
  };

  return (
    <div className="sub" data-testid="local">
      <label className="field">
        <span className="field-label">Server address</span>
        <input
          value={url}
          spellCheck={false}
          onChange={(e) => {
            setUrl(e.target.value);
            saveUrl(e.target.value);
          }}
        />
        {offComputer(url) && (
          <small className="help warn" data-testid="local-remote">
            {offComputer(url) === 'plain'
              ? 'Not on this computer, and not https: your selections would travel unencrypted.'
              : 'Not on this computer: your selections are sent there.'}
          </small>
        )}
      </label>
      <label className="field">
        <span className="field-label">Model</span>
        <input
          value={model}
          spellCheck={false}
          onChange={(e) => {
            setModel(e.target.value);
            saveModel(e.target.value);
          }}
        />
        <small className="help">Any OpenAI-compatible server (like Ollama), with a model that reads images.</small>
      </label>
      <span className="key-row">
        <button type="button" className="secondary" disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check connection'}
        </button>
        {status && (
          <span className={`help ${status.state === 'ok' ? 'ok' : 'bad'}`}>
            {status.state === 'ok' ? '✓ Connected.' : status.message}
          </span>
        )}
      </span>
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
