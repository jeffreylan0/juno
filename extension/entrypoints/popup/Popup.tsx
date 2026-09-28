/**
 * Toolbar popup: pick a selection mode, then select on the page.
 *
 * Opening the popup arms the default mode straight away, so the common case is
 * click the icon and drag. Choosing a different mode re-arms and closes the
 * popup, which hands focus back to the page — that is what makes Escape work,
 * since a popup holding focus swallows the key.
 *
 * Deliberately barebones: every colour is a token in popup.css, so the real
 * theme can be dropped in without touching this file.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { SelectionKind } from '@shared/payload';
import { getSettings } from '@/lib/storage';

interface ModeDef {
  kind: SelectionKind;
  label: string;
  hint: string;
  icon: ReactElement;
  ready: boolean;
}

const MODES: ModeDef[] = [
  {
    kind: 'box',
    label: 'Box',
    hint: 'Drag a box around anything',
    ready: true,
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" strokeDasharray="3 2.4" />
        <rect x="1.8" y="3.8" width="3.4" height="3.4" rx="0.8" className="handle" />
        <rect x="18.8" y="3.8" width="3.4" height="3.4" rx="0.8" className="handle" />
        <rect x="1.8" y="16.8" width="3.4" height="3.4" rx="0.8" className="handle" />
        <rect x="18.8" y="16.8" width="3.4" height="3.4" rx="0.8" className="handle" />
      </svg>
    ),
  },
  {
    kind: 'text',
    label: 'Text',
    hint: 'Select text on the page',
    ready: true,
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 6.5V5h14v1.5" />
        <path d="M12 5v14" />
        <path d="M9 19h6" />
      </svg>
    ),
  },
  {
    kind: 'element',
    label: 'Element',
    hint: 'Click a table, figure or block — week 4',
    ready: false,
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 4h16v6H4z" />
        <path d="M4 14h7v6H4z" />
        <path d="M14 14h6v6h-6z" />
      </svg>
    ),
  },
];

export function Popup() {
  const [armed, setArmed] = useState<SelectionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasPlan, setHasPlan] = useState(false);

  const arm = useCallback(async (kind: SelectionKind, close: boolean) => {
    try {
      await browser.runtime.sendMessage({ type: 'selection:arm', kind });
      setArmed(kind);
      if (close) window.close();
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // Arm the default mode as soon as the popup opens.
  useEffect(() => {
    void (async () => {
      const settings = await getSettings();
      void arm(settings.defaultSelectionKind, false);
    })();
    void browser.runtime.sendMessage({ type: 'plan:get' }).then((plan: unknown) => setHasPlan(!!plan));
  }, [arm]);

  // Escape here has to cancel the page selection too: while the popup is open
  // it holds focus, so the content script never sees the key. The close waits
  // for the message — closing the popup first drops it on the floor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      void browser.runtime
        .sendMessage({ type: 'selection:abort' })
        .catch(() => {})
        .then(() => window.close());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const active = MODES.find((m) => m.kind === armed);

  return (
    <div className="popup">
      <div className="modes" role="group" aria-label="Selection mode">
        {MODES.map((m) => (
          <button
            key={m.kind}
            type="button"
            className={`mode${m.kind === armed ? ' on' : ''}`}
            aria-pressed={m.kind === armed}
            disabled={!m.ready}
            title={m.hint}
            onClick={() => void arm(m.kind, true)}
          >
            {m.icon}
            <span>{m.label}</span>
          </button>
        ))}
      </div>

      <p className="hint">
        {error ? (
          <span className="error">{error}</span>
        ) : active ? (
          <>
            {active.hint}. <kbd>Esc</kbd> to cancel.
          </>
        ) : (
          'Pick a selection mode.'
        )}
      </p>

      <div className="row">
        {hasPlan && (
          <button type="button" className="link" onClick={() => void browser.runtime.sendMessage({ type: 'panel:open' })}>
            Show answer panel
          </button>
        )}
        <button type="button" className="link" onClick={() => browser.runtime.openOptionsPage()}>
          Options
        </button>
      </div>
    </div>
  );
}
