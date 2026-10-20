/**
 * Settings → Appearance: the colour themes (lib/themes.ts), each a small
 * preview in the page's current scheme, light or dark: the window, a
 * question, an answer line and the accent. `themes`: which (with the extras
 * locked, Options.tsx shows the others apart, greyed).
 */
import type { CSSProperties } from 'react';
import { THEMES, type Palette, type Theme } from '@/lib/themes';
import { usePageDark } from '../theme';

export function ThemePicker({ value, themes = THEMES, onChange }: { value: string; themes?: readonly Theme[]; onChange: (id: string) => void }) {
  const isDark = usePageDark();
  return (
    <div className="themes" role="radiogroup" aria-label="Theme" data-testid="themes">
      {themes.map((t) => {
        const p: Palette = isDark ? t.dark : t.light;
        return (
          <button key={t.id} type="button" role="radio" aria-checked={value === t.id} className="theme" data-theme={t.id} onClick={() => onChange(t.id)}>
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
