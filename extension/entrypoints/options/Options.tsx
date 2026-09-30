/**
 * Settings, in the order a student meets them:
 *
 *  1. Answers — who answers. One choice (Claude, ChatGPT, a local model or
 *     placeholder answers), and below it only what that choice needs: a key
 *     and a model, or a server address. Nothing else is on screen.
 *  2. Asking — the macros above the question box, the default prompt, and
 *     whether a selection is asked about straight away.
 *  3. Selecting — the shortcut, what happens after drawing a box, and when
 *     the answer panel opens (the same two the bar's gear offers).
 *  4. Chats & privacy — where chats are kept and how to delete them, blocked
 *     sites, and what is ever sent.
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
import { MAX_SAVED_CHATS, listChats } from '@/lib/chats';
import { MAJOR_MODELS, MODEL_NAMES, MODEL_TABLE } from '@/lib/router';
import type { KeyModel, KeyTestResult } from '@/lib/providers/byok';
import {
  getKeys,
  getSettings,
  keysItem,
  sanitizeMacros,
  settingsItem,
  type Keys,
  type Macro,
  type PanelOpen,
  type SendBehavior,
  type Settings,
} from '@/lib/storage';
import type { AiStatus } from '@/lib/status';
import { openShortcutSettings, useShortcut } from '@/ui/useShortcut';

type Vendor = 'anthropic' | 'openai';
type Choice = 'claude' | 'chatgpt' | 'local' | 'placeholder';

const CHOICES: { id: Choice; name: string; sub: string }[] = [
  { id: 'claude', name: 'Claude', sub: 'Anthropic · your key' },
  { id: 'chatgpt', name: 'ChatGPT', sub: 'OpenAI · your key' },
  { id: 'local', name: 'Local model', sub: 'On this computer' },
  { id: 'placeholder', name: 'Placeholder', sub: 'No AI · free' },
];

const VENDOR_OF: Partial<Record<Choice, Vendor>> = { claude: 'anthropic', chatgpt: 'openai' };
const VENDOR_NAME: Record<Vendor, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };
const KEY_HINT: Record<Vendor, string> = { anthropic: 'sk-ant-…', openai: 'sk-…' };
const KEY_PAGE: Record<Vendor, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
};

const SEND: { id: SendBehavior; label: string; help: string }[] = [
  { id: 'prefill', label: 'Wait for me', help: 'The default prompt goes in the box; nothing is asked (or spent) until you press Enter or a macro.' },
  { id: 'auto', label: 'Ask straight away', help: 'Asks the default prompt, or the first macro when that is empty. Every selection is a paid question.' },
  { id: 'auto-box', label: 'Ask straight away for screenshots only', help: 'Box, Freeform and Element are asked about at once; Text waits for you.' },
];

const PANEL: { id: PanelOpen; label: string; help: string }[] = [
  { id: 'on-selection', label: 'When a selection is made', help: 'The page stays full width while you choose what to select.' },
  { id: 'on-click', label: `When I click ${BRAND.iconName}`, help: 'Already open while you select, at the cost of a narrower page.' },
];

const SECTIONS = [
  { id: 'answers', title: 'Answers' },
  { id: 'asking', title: 'Asking' },
  { id: 'selecting', title: 'Selecting' },
  { id: 'privacy', title: 'Chats & privacy' },
] as const;

type Check = { state: 'idle' } | { state: 'checking' } | KeyTestResult;

function choiceOf(s: Settings): Choice | null {
  if (s.provider === 'mock') return 'placeholder';
  if (s.provider === 'local') return 'local';
  if (s.provider === 'byok') return s.vendor === 'openai' ? 'chatgpt' : 'claude';
  return null; // the hosted plan, which is not offered yet
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
  const shortcut = useShortcut();

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
              {' '}or press <kbd>{shortcut}</kbd>
            </>
          ) : null}{' '}
          to bring up the selection bar; it follows you from tab to tab, and everything you select goes into one chat until
          you close it (✕ or Escape). Changes here save as you make them.
        </p>

        <AnswersSection settings={settings} keys={keys} models={models} save={save} saveKey={saveKey} rememberModels={rememberModels} />
        <AskingSection settings={settings} save={save} />
        <SelectingSection settings={settings} save={save} shortcut={shortcut} />
        <PrivacySection settings={settings} save={save} />
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
  save,
  saveKey,
  rememberModels,
}: {
  settings: Settings;
  keys: Keys;
  models: Partial<Record<Vendor, KeyModel[]>>;
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
    } else void save({ provider: next === 'local' ? 'local' : 'mock' });
  };

  return (
    <Section id="answers" title="Answers" lede="Who answers your questions. Only what your choice needs is shown below it.">
      <div className="cards" role="radiogroup" aria-label="Who answers">
        {CHOICES.map((c) => (
          <label key={c.id} className={`card${choice === c.id ? ' on' : ''}`} data-testid={`answer-${c.id}`}>
            <input type="radio" name="answers" checked={choice === c.id} onChange={() => choose(c.id)} />
            <b>{c.name}</b>
            <small>{c.sub}</small>
          </label>
        ))}
      </div>
      {settings.provider === 'gateway' && <p className="help">Hosted plans are not available yet. Pick one of the above.</p>}

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
          Answers are made up on this computer, so you can try the shortcut without an account or a key. Nothing is sent
          anywhere.
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
      result = { ok: false, error: `Could not run the check: ${(err as Error).message}`, code: 'http' };
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
          Kept in this browser only and sent only to {VENDOR_NAME[vendor]}; empty the field to remove it. Checking costs
          nothing. Set a monthly spend limit in {VENDOR_NAME[vendor]}'s console so a busy week can't surprise you.
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
              {m.vision ? '' : ' (text only — cannot read screenshots)'}
            </option>
          ))}
          {override && !choices.some((m) => m.id === override) && <option value={override}>{override}</option>}
        </select>
        <small className="help">Also on the panel, beside the macros. {listed ? '' : 'Check your key to list every model it can use.'}</small>
      </label>
    </div>
  );
}

function KeyStatus({ check, hasKey }: { check: Check; hasKey: boolean }) {
  if ('state' in check && check.state === 'checking') return <p className="help">Checking…</p>;
  if (!('ok' in check)) return hasKey ? null : <p className="help warn">Needed before anything can be asked.</p>;
  if (check.ok) {
    const vision = check.models.filter((m) => m.vision).length;
    return (
      <p className="help ok" data-testid="key-status">
        ✓ Key works. {check.models.length} models available{vision !== check.models.length ? `, ${vision} of them read images` : ''}.
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
        <small className="help">Any OpenAI-compatible server works; Ollama is the usual one. The model must read images for screenshots.</small>
      </label>
      <span className="key-row">
        <button type="button" className="secondary" disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check connection'}
        </button>
        {status && (
          <span className={`help ${status.state === 'ok' ? 'ok' : 'bad'}`}>
            {status.state === 'ok' ? '✓ The server answers.' : status.message}
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
        <p className="help">Buttons above the question box. A click puts the prompt in the box and asks it.</p>
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
          placeholder="Empty — the box starts blank"
          onChange={(e) => {
            setPrompt(e.target.value);
            savePrompt(e.target.value);
          }}
        />
        <small className="help">Waiting in the box when a selection lands. Empty by default: the macros do the asking.</small>
      </label>

      <div className="field">
        <span className="field-label">When a selection lands</span>
        <Radios name="send" value={settings.sendBehavior} options={SEND} onChange={(v) => void save({ sendBehavior: v })} />
      </div>
    </Section>
  );
}

// ── 3. Selecting ─────────────────────────────────────────────────────────

function SelectingSection({ settings, save, shortcut }: { settings: Settings; save: (patch: Partial<Settings>) => Promise<void>; shortcut: string }) {
  return (
    <Section id="selecting" title="Selecting" lede="The bar's gear changes the last two as well.">
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
        <small className="help">Does the same as clicking {BRAND.iconName}. The browser owns shortcuts, so they are changed on its own page.</small>
      </div>

      <AllSitesField />

      <div className="field">
        <span className="field-label">After drawing a box</span>
        <Radios
          name="adjust"
          value={settings.adjustBox ? 'adjust' : 'send'}
          options={[
            { id: 'send', label: 'Send it as soon as I let go' },
            { id: 'adjust', label: 'Let me adjust it first', help: 'Handles to resize or move it; Enter or Ask sends it.' },
          ]}
          onChange={(v) => void save({ adjustBox: v === 'adjust' })}
        />
      </div>

      <div className="field">
        <span className="field-label">Open the answer panel</span>
        <Radios name="panel" value={settings.panelOpen} options={PANEL} onChange={(v) => void save({ panelOpen: v })} />
      </div>

      <p className="help">
        On a PDF in the browser's own viewer only Box and Freeform work; {BRAND.name} offers to reopen it in its own reader,
        where every mode does.
      </p>
    </Section>
  );
}

/**
 * The bar follows the student from tab to tab only where the extension may
 * go. Chrome grants that per tab when the icon is clicked; this lets it onto
 * every site at once (asked once by Chrome, and removable here).
 */
function AllSitesField() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    const refresh = () => void browser.permissions.contains({ origins: ['<all_urls>'] }).then(setAllowed, () => setAllowed(false));
    refresh();
    browser.permissions.onAdded.addListener(refresh);
    browser.permissions.onRemoved.addListener(refresh);
    return () => {
      browser.permissions.onAdded.removeListener(refresh);
      browser.permissions.onRemoved.removeListener(refresh);
    };
  }, []);
  if (allowed === null) return null;
  return (
    <div className="field" data-testid="all-sites">
      <span className="field-label">The bar on every tab</span>
      <span className="key-row shortcut-row">
        <span className={allowed ? 'help ok' : 'help'}>
          {allowed ? '✓ The bar follows you to every tab.' : 'Off: the bar goes only to tabs where you click the shortcut icon.'}
        </span>
        {allowed ? (
          <button type="button" className="secondary" onClick={() => void browser.permissions.remove({ origins: ['<all_urls>'] })}>
            Turn off
          </button>
        ) : (
          <button type="button" className="secondary" data-testid="allow-all-sites" onClick={() => void browser.permissions.request({ origins: ['<all_urls>'] })}>
            Allow
          </button>
        )}
      </span>
      <small className="help">
        Chrome asks once. {BRAND.name} still touches a page only while the bar is up, and sends nothing until you select.
      </small>
    </div>
  );
}

// ── 4. Chats & privacy ───────────────────────────────────────────────────

function PrivacySection({ settings, save }: { settings: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const [blocked, setBlocked] = useState(settings.blockedSites.join('\n'));
  const saveBlocked = useDebounced((v: string) =>
    void save({
      blockedSites: v
        .split(/\n|,/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    }),
  );

  return (
    <Section id="privacy" title="Chats & privacy">
      <ChatsField />

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
        <small className="help">One hostname per line. The shortcut does nothing on these sites — for exams and private portals.</small>
      </label>

      <div className="field">
        <span className="field-label">What is sent</span>
        <p className="help">
          Nothing leaves the page until you select something, and then only the selection — the screenshot of what you
          selected, or the text — goes to the AI you chose, never the rest of the page. Keys and chats stay in this browser.
        </p>
      </div>
    </Section>
  );
}

/** Where chats live, and a way to clear them. Asks first, since it cannot be undone. */
function ChatsField() {
  const [count, setCount] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    const refresh = () => void listChats().then((l) => setCount(l.length));
    refresh();
    const onChanged = (changes: Record<string, unknown>, area: string) => area === 'local' && 'chatIndex' in changes && refresh();
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);
  return (
    <div className="field" data-testid="chats">
      <span className="field-label">Chats</span>
      <p className="help">
        Saved on this computer only, with their screenshots. The free plan keeps your {MAX_SAVED_CHATS} most recent; the
        oldest goes when you start another. Temporary chats are never saved.
      </p>
      {confirming ? (
        <div className="confirm-row">
          <span>Delete all {count} saved chats? This cannot be undone.</span>
          <button
            type="button"
            className="danger"
            data-testid="confirm-delete-chats"
            onClick={() => void browser.runtime.sendMessage({ type: 'chats:delete-all' }).then(() => setConfirming(false))}
          >
            Delete all
          </button>
          <button type="button" className="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="secondary" data-testid="delete-chats" disabled={!count} onClick={() => setConfirming(true)}>
          {count ? `Delete all chats (${count})` : 'No saved chats'}
        </button>
      )}
    </div>
  );
}
