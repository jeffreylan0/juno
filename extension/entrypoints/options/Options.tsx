/**
 * Settings, in the order a student meets them:
 *
 *  1. Answers — who answers. One choice (Claude, ChatGPT, a local model or
 *     placeholder answers), and below it only what that choice needs: a key
 *     and a model, or a server address. Nothing else is on screen.
 *  2. Asking — the macros above the question box, the default prompt, and
 *     whether a selection is asked about straight away.
 *  3. Selecting — the shortcut, and what happens after drawing a box (which
 *     the bar's gear offers too).
 *  4. Chats & privacy — how many chats are kept and how to delete them,
 *     blocked sites, and what is ever sent and kept.
 *  5. Account (builds with accounts only) — sign in, cloud storage, hosted
 *     answers (Account.tsx).
 *
 * Every change saves as it is made — there is no Save button to forget — and
 * a small "Saved" confirms it. Writes read the latest stored settings first,
 * so a model picked in the panel meanwhile is never overwritten.
 *
 * Every colour is a token in options.css, so the real theme drops in without
 * touching this file.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_MACROS, DEFAULT_PROMPT } from '@shared/prompts';
import { BRAND } from '@/brand';
import { ACCOUNTS } from '@/lib/account/config';
import { listChats } from '@/lib/chats';
import { MAJOR_MODELS, MODEL_NAMES, MODEL_TABLE } from '@/lib/router';
import { SURFACE } from '@/lib/surface';
import type { KeyModel, KeyTestResult } from '@/lib/providers/byok';
import {
  CHAT_LIMITS,
  getKeys,
  getSettings,
  keysItem,
  sanitizeMacros,
  settingsItem,
  type Keys,
  type Macro,
  type SendBehavior,
  type Settings,
} from '@/lib/storage';
import type { AiStatus } from '@/lib/status';
import { hasHosted, useAccount, type AccountState } from '@/ui/useAccount';
import { formatShortcut, openShortcutSettings, useShortcut } from '@/ui/useShortcut';
import { AccountSection } from './Account';

type Vendor = 'anthropic' | 'openai';
type Choice = 'claude' | 'chatgpt' | 'hosted' | 'local' | 'placeholder';

const CHOICES: { id: Choice; name: string; sub: string }[] = [
  { id: 'claude', name: 'Claude', sub: 'Anthropic · your key' },
  { id: 'chatgpt', name: 'ChatGPT', sub: 'OpenAI · your key' },
  { id: 'hosted', name: 'Hosted', sub: 'Your plan · no key' },
  { id: 'local', name: 'Local model', sub: 'On this computer' },
  { id: 'placeholder', name: 'Placeholder', sub: 'No AI · for trying it out' },
];

const VENDOR_OF: Partial<Record<Choice, Vendor>> = { claude: 'anthropic', chatgpt: 'openai' };
const VENDOR_NAME: Record<Vendor, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };
const KEY_HINT: Record<Vendor, string> = { anthropic: 'sk-ant-…', openai: 'sk-…' };
const KEY_PAGE: Record<Vendor, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
};

const SEND: { id: SendBehavior; label: string; help: string }[] = [
  { id: 'prefill', label: 'Wait for me', help: 'Nothing is asked until you press Enter or a macro.' },
  { id: 'auto', label: 'Ask right away', help: 'Asks the default prompt, or the first macro. Each selection costs a question.' },
  { id: 'auto-box', label: 'Ask right away, screenshots only', help: 'Text selections still wait for you.' },
];

const SECTIONS = [
  { id: 'answers', title: 'Answers' },
  { id: 'asking', title: 'Asking' },
  { id: 'selecting', title: 'Selecting' },
  { id: 'privacy', title: 'Chats & privacy' },
  ...SURFACE.sections.map(({ id, title }) => ({ id, title })),
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
  const shortcut = formatShortcut(useShortcut());
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
        </div>
      </header>

      <main className="options">
        <p className="lede">
          Click {BRAND.iconName}
          {shortcut ? (
            <>
              {' '}or use <kbd>{shortcut}</kbd>
            </>
          ) : null}{' '}
          to select what you want to ask about. Changes here save on their own.
        </p>

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
        <SelectingSection settings={settings} save={save} shortcut={shortcut} />
        <PrivacySection settings={settings} save={save} account={account} />
        {SURFACE.sections.map(({ id, title, render }) => (
          <Section key={id} id={id} title={title}>
            {render()}
          </Section>
        ))}
        <AccountSection account={account} settings={settings} save={save} />
      </main>
    </div>
  );
}

function Section({ id, title, lede, children }: { id: string; title: string; lede?: string; children: ReactNode }) {
  return (
    <section id={id} data-testid={`section-${id}`}>
      <h2>{title}</h2>
      {lede && <p className="help section-lede">{lede}</p>}
      {children}
    </section>
  );
}

/** A group of radio buttons, each with a short explanation under it. */
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
      // Hosted answers use Claude, with the automatic model choice.
      void save({ provider: 'gateway', vendor: 'anthropic', modelOverride: null });
    } else void save({ provider: next === 'local' ? 'local' : 'mock' });
  };
  // Offered once the account's plan includes hosted answers (or already picked).
  const hosted = hasHosted(account);
  const offered = CHOICES.filter((c) => c.id !== 'hosted' || hosted || choice === 'hosted');
  const ent = account.entitlement;

  return (
    <Section id="answers" title="Answers" lede="Who answers your questions.">
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
            Answers come through our server with our key; it keeps no copy. {Math.max(0, ent.quota - ent.used)} of {ent.quota} left
            this month.
          </p>
        ) : (
          <p className="help warn" data-testid="hosted-help">
            {account.user ? "Your account doesn't include hosted answers. Pick another above." : 'Sign in under Account to use it.'}
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
          Made-up answers, so you can try it without a key. Nothing is sent.
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
  const choices: KeyModel[] =
    listed ?? MAJOR_MODELS[vendor].map((id) => ({ id, name: MODEL_NAMES[id] ?? id, vision: true }));
  const override = settings.modelOverride?.vendor === vendor ? settings.modelOverride.model : '';
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
          {VENDOR_NAME[vendor]} API key ·{' '}
          <a className="link" href={KEY_PAGE[vendor]} target="_blank" rel="noopener noreferrer">
            get one
          </a>
        </span>
        <span className="key-row">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${VENDOR_NAME[vendor]} API key`}
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
        <p className="help">
          Stays in this browser and only goes to {VENDOR_NAME[vendor]}. Clear the field to remove it. Tip: set a monthly
          spend limit in {VENDOR_NAME[vendor]}'s console.
        </p>
      </div>

      <label className="field">
        <span className="field-label">Model</span>
        <select
          value={override}
          data-testid="model-select"
          onChange={(e) => void save({ modelOverride: e.target.value ? { vendor, model: e.target.value } : null })}
        >
          <option value="">
            Automatic — {MODEL_NAMES[table.small]} for text, {MODEL_NAMES[table.large]} for screenshots
          </option>
          {choices.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.vision ? '' : ' (text only)'}
            </option>
          ))}
          {override && !choices.some((m) => m.id === override) && <option value={override}>{override}</option>}
        </select>
        <small className="help">You can also change it in the panel.{listed ? '' : ' Check your key to see every model.'}</small>
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
        <small className="help">Any OpenAI-compatible server, like Ollama. For screenshots, use a model that reads images.</small>
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
          <span className="field-label">Answer macros</span>
          {changed && (
            <button type="button" className="link" onClick={() => update(DEFAULT_MACROS.map((m) => ({ ...m })))}>
              Reset to Explain, Hint, Check
            </button>
          )}
        </div>
        <p className="help">Buttons above the question box. Click one to ask it.</p>
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
        <small className="help">Put in the question box after each selection.</small>
      </label>

      <div className="field">
        <span className="field-label">After you select</span>
        <Radios name="send" value={settings.sendBehavior} options={SEND} onChange={(v) => void save({ sendBehavior: v })} />
      </div>
    </Section>
  );
}

// ── 3. Selecting ─────────────────────────────────────────────────────────

function SelectingSection({ settings, save, shortcut }: { settings: Settings; save: (patch: Partial<Settings>) => Promise<void>; shortcut: string }) {
  return (
    <Section id="selecting" title="Selecting">
      {SURFACE.shortcutField ? (
        SURFACE.shortcutField()
      ) : (
        <div className="field" data-testid="shortcuts">
          <span className="field-label">Keyboard shortcut</span>
          <span className="key-row shortcut-row">
            <span>
              Start selecting: <kbd>{shortcut || 'not set'}</kbd>
            </span>
            <button type="button" className="secondary" onClick={openShortcutSettings}>
              Change…
            </button>
          </span>
          <small className="help">Same as clicking {BRAND.iconName}. It's changed on the browser's shortcuts page.</small>
        </div>
      )}

      <div className="field">
        <span className="field-label">After drawing a box</span>
        <Radios
          name="adjust"
          value={settings.adjustBox ? 'adjust' : 'send'}
          options={[
            { id: 'send', label: 'Send right away' },
            { id: 'adjust', label: 'Let me adjust it first', help: 'Drag the edges, then press Enter.' },
          ]}
          onChange={(v) => void save({ adjustBox: v === 'adjust' })}
        />
        <small className="help">Also in the gear on the selection bar.</small>
      </div>

      {SURFACE.pdfViewer && (
        <p className="help">
          In the browser's PDF viewer, only Box and Freeform work. {BRAND.name} can reopen the PDF in its own reader, where
          everything works.
        </p>
      )}
    </Section>
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
  const [blocked, setBlocked] = useState(settings.blockedSites.join('\n'));
  const saveBlocked = useDebounced((v: string) =>
    void save({
      blockedSites: v
        .split(/\n|,/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    }),
  );
  // Chats go to the cloud only for an account that has cloud storage and turned it on.
  const cloud = !!account.user && !!account.entitlement?.cloud && settings.cloudSync;

  return (
    <Section id="privacy" title="Chats & privacy">
      <ChatsField limit={settings.chatLimit} cloud={cloud} save={save} />

      {SURFACE.blockedSites && (
        <label className="field">
          <span className="field-label">Blocked sites</span>
          <textarea
            rows={3}
            value={blocked}
            placeholder="exam.example.edu"
            data-testid="blocked-sites"
            onChange={(e) => {
              setBlocked(e.target.value);
              saveBlocked(e.target.value);
            }}
          />
          <small className="help">One site per line, like exam sites. {BRAND.name} stays off on them.</small>
        </label>
      )}

      <div className="field" data-testid="what-is-sent">
        <span className="field-label">What's sent and kept</span>
        <p className="help">
          Only what you select (a screenshot or text) and the {SURFACE.source}'s title go to the AI you picked.{' '}
          {SURFACE.keysKept} Your chats stay on this computer{cloud ? ' and in your account' : ''}.
        </p>
        <ul className="help facts">
          <li>
            <b>Claude</b>: not used for training. Anthropic deletes it within 30 days, unless it's flagged for breaking their
            rules.
          </li>
          <li>
            <b>ChatGPT</b>: not used for training, unless your OpenAI organization opted in to sharing. OpenAI keeps abuse
            logs for up to 30 days. Answers aren't stored.
          </li>
          {hasHosted(account) && (
            <li>
              <b>Hosted answers</b> go to Claude through our server, which counts them but keeps no copy.
            </li>
          )}
          <li>
            <b>A local model</b>: nothing leaves this computer.
          </li>
          <li>
            <b>Temporary chats</b> are never saved{ACCOUNTS ? ' or synced' : ''}, and are deleted when you're done.
          </li>
          {ACCOUNTS && (
            <li>
              <b>Your account</b>, if you sign in, holds your email address. Chats go to the cloud only if your account has
              cloud storage and you turn it on.
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
        {cloud
          ? 'Saved on this computer and in your account, with their screenshots. Past the limit, the oldest leaves this computer but stays in your account.'
          : 'Saved on this computer with their screenshots. Past the limit, the oldest is deleted.'}{' '}
        Temporary chats are never saved.
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
        <span>most recent chats</span>
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
