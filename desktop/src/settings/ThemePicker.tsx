/**
 * Settings → Appearance: the colour themes (lib/themes.ts), each a small
 * preview in the page's current scheme, light or dark: the window, a
 * question, an answer line and the accent. `locked` (the extras closed:
 * lib/extras.ts): only the default can be picked.
 */
import type { CSSProperties } from 'react';
import { DEFAULT_THEME, THEMES, type Palette } from '@/lib/themes';
import { usePageDark } from '../theme';

export function ThemePicker({ value, locked = false, onChange }: { value: string; locked?: boolean; onChange: (id: string) => void }) {
  const isDark = usePageDark();
  return (
    <div className="themes" role="radiogroup" aria-label="Theme" data-testid="themes">
      {THEMES.map((t) => {
        const p: Palette = isDark ? t.dark : t.light;
        const off = locked && t.id !== DEFAULT_THEME;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={value === t.id}
            className={`theme${off ? ' locked' : ''}`}
            data-theme={t.id}
            disabled={off}
            onClick={() => onChange(t.id)}
          >
            <span className="theme-preview" style={{ background: p.bg, borderColor: p.line } as CSSProperties}>
              <span className="theme-bubble" style={{ background: p.user }} />
              <span className="theme-line" style={{ background: p.fg }} />
              <span className="theme-line short" style={{ background: p.muted }} />
              <span className="theme-dot" style={{ background: p.accent }} />
            </span>
            <span className="theme-name">{t.name}</span>
          </button>
        );
      })}
    </div>
  );
}
