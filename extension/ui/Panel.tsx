/**
 * The panel: mode picker, tray of selection chips, question box, chat thread
 * with streaming answers. Runs in the Chrome/Edge side panel, the Firefox
 * sidebar, and (from week 12) inside the Safari in-page overlay.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskChunk, AskRequest, ChatTurn, Mode, ModelRef, Plan, Usage } from '@shared/payload';
import { MODES } from '@shared/payload';
import { PORT_ASK, type AskPortIn } from '@/lib/messages';
import { getSettings, settingsItem, type Settings } from '@/lib/storage';
import { Answer } from './Answer';
import { Preview } from './Preview';
import { Tray } from './Tray';

interface Turn extends ChatTurn {
  id: string;
  streaming?: boolean;
  usage?: Usage;
  model?: ModelRef;
  cached?: boolean;
  error?: string;
}

const MODE_LABEL: Record<Mode, string> = { explain: 'Explain', hint: 'Hint', check: 'Check' };

export function Panel() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [mode, setMode] = useState<Mode>('explain');
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  // Load settings and any plan that arrived before the panel opened.
  useEffect(() => {
    // Clears the toolbar badge the background sets when it could not open us.
    void browser.runtime.sendMessage({ type: 'panel:ready' });
    void getSettings().then((s) => {
      setSettings(s);
      setMode(s.defaultMode);
    });
    const unwatch = settingsItem.watch((s) => s && setSettings(s));
    void browser.runtime.sendMessage({ type: 'plan:get' }).then((p: Plan | null) => {
      if (p) {
        setPlan(p);
        setMode(p.mode);
      }
    });
    const onMessage = (raw: unknown) => {
      const msg = raw as { type?: string; plan?: Plan };
      if (msg?.type === 'plan:ready' && msg.plan) {
        setPlan(msg.plan);
        setTurns([]);
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      unwatch();
    };
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [turns]);

  const changeMode = useCallback((m: Mode) => {
    setMode(m);
    void browser.runtime.sendMessage({ type: 'plan:setMode', mode: m });
  }, []);

  const abort = useCallback(() => {
    const msg: AskPortIn = { type: 'ask:abort' };
    portRef.current?.postMessage(msg);
    setBusy(false);
    setTurns((t) => t.map((x) => (x.streaming ? { ...x, streaming: false } : x)));
  }, []);

  const ask = useCallback(() => {
    if (!plan || busy) return;
    const q = question.trim();
    const history: ChatTurn[] = turns.filter((t) => !t.error).map(({ role, text }) => ({ role, text }));
    const request: AskRequest = { plan: { ...plan, mode, question: q || undefined }, history };
    const userTurn: Turn = { id: crypto.randomUUID(), role: 'user', text: q || `(${MODE_LABEL[mode]} the selection)` };
    const answerId = crypto.randomUUID();
    setTurns((t) => [...t, userTurn, { id: answerId, role: 'assistant', text: '', streaming: true }]);
    setQuestion('');
    setBusy(true);

    portRef.current?.disconnect();
    const port = browser.runtime.connect({ name: PORT_ASK });
    portRef.current = port;
    port.onMessage.addListener((chunk: AskChunk) => {
      setTurns((t) =>
        t.map((x) => {
          if (x.id !== answerId) return x;
          switch (chunk.type) {
            case 'delta':
              return { ...x, text: x.text + chunk.text };
            case 'done':
              return { ...x, streaming: false, usage: chunk.usage, model: chunk.model, cached: chunk.cached };
            case 'error':
              return { ...x, streaming: false, error: chunk.message };
          }
        }),
      );
      if (chunk.type !== 'delta') setBusy(false);
    });
    port.onDisconnect.addListener(() => setBusy(false));
    const start: AskPortIn = { type: 'ask:start', request };
    port.postMessage(start);
  }, [plan, busy, question, turns, mode]);

  return (
    <div className="panel">
      <header className="bar">
        <div className="modes" role="tablist">
          {MODES.map((m) => (
            <button key={m} role="tab" aria-selected={m === mode} className={m === mode ? 'on' : ''} onClick={() => changeMode(m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <ModelPicker settings={settings} />
      </header>

      <Tray plan={plan} />
      <Preview plan={plan} />

      <div className="thread" ref={threadRef}>
        {turns.map((t) =>
          t.role === 'user' ? (
            <div key={t.id} className="turn user">{t.text}</div>
          ) : (
            <div key={t.id} className="turn assistant">
              {t.error ? <div className="error">{t.error}</div> : <Answer text={t.text} streaming={!!t.streaming} />}
              {!t.streaming && !t.error && (
                <div className="usage">
                  {t.model ? `${t.model.vendor}/${t.model.model}` : ''}
                  {t.cached ? ' · replayed' : ''}
                  {t.usage ? ` · ${t.usage.inputTokens}→${t.usage.outputTokens} tok` : ''}
                  {t.usage?.costUsd !== undefined ? ` · $${t.usage.costUsd.toFixed(4)}` : ''}
                </div>
              )}
            </div>
          ),
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <textarea
          value={question}
          placeholder={plan ? `Ask about the selection (optional), then ${MODE_LABEL[mode]}` : 'Select something on the page first'}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
          rows={2}
          disabled={!plan}
        />
        {busy ? (
          <button type="button" onClick={abort}>Stop</button>
        ) : (
          <button type="submit" disabled={!plan}>{MODE_LABEL[mode]}</button>
        )}
      </form>
    </div>
  );
}

function ModelPicker({ settings }: { settings: Settings | null }) {
  if (!settings) return null;
  const label =
    settings.provider === 'mock'
      ? 'mock'
      : settings.provider === 'local'
        ? `local · ${settings.localModel}`
        : settings.modelOverride
          ? settings.modelOverride.model
          : `${settings.vendor} · auto`;
  return (
    <button type="button" className="model" title="Change in Options" onClick={() => browser.runtime.openOptionsPage()}>
      {label}
    </button>
  );
}
