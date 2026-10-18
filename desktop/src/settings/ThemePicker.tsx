/**
 * Settings → Appearance: the colour themes (lib/themes.ts), each a small
 * preview in the system's current appearance: the window, a question, an
 * answer line and the accent.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { THEMES, type Palette } from '@/lib/themes';

const dark = () => matchMedia('(prefers-color-scheme: dark)');

export function ThemePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [isDark, setDark] = useState(() => dark().matches);
  useEffect(() => {
    const scheme = dark();
    const follow = () => setDark(scheme.matches);
    scheme.addEventListener('change', follow);
    return () => scheme.removeEventListener('change', follow);
  }, []);
  return (
    <div className="themes" role="radiogroup" aria-label="Theme" data-testid="themes">
      {THEMES.map((t) => {
        const p: Palette = isDark ? t.dark : t.light;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={value === t.id}
            className="theme"
            data-theme={t.id}
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
