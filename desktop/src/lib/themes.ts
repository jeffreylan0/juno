/**
 * Colour themes. A theme is only data, a light and a dark palette of a few
 * colours, so more can be added later (a marketplace theme is the same
 * shape). The page shows the palette for the system's appearance; the rest
 * of its colours (the accent's tint, the text on the accent, the drawer) are
 * worked out from those few. The bar is dark in every theme, in the dark
 * palette's colours.
 *
 * Claude, the default, is the stylesheets' own palette: choosing it sets
 * nothing, so it looks exactly as the stylesheets say. Each page follows the
 * setting with followTheme (theme.ts).
 */
export interface Palette {
  /** The window. */
  bg: string;
  /** Cards and fields on it. */
  surface: string;
  fg: string;
  /** Secondary text. */
  muted: string;
  line: string;
  /** What acts: Send, links, the chosen option. */
  accent: string;
  /** The student's questions. */
  user: string;
}

export interface Theme {
  id: string;
  name: string;
  light: Palette;
  dark: Palette;
}

export const DEFAULT_THEME = 'claude';

export const THEMES: readonly Theme[] = [
  {
    id: 'claude',
    name: 'Claude',
    light: { bg: '#faf9f5', surface: '#ffffff', fg: '#141413', muted: '#73726c', line: '#e6e4dc', accent: '#c96442', user: '#f0eee6' },
    dark: { bg: '#262624', surface: '#30302e', fg: '#f5f4ef', muted: '#a6a39b', line: '#3d3d3a', accent: '#d97757', user: '#141413' },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    light: { bg: '#f7f7f8', surface: '#ffffff', fg: '#18181b', muted: '#62626b', line: '#e4e4e7', accent: '#2563eb', user: '#ececef' },
    dark: { bg: '#1c1c1f', surface: '#27272a', fg: '#f4f4f5', muted: '#a1a1aa', line: '#3a3a40', accent: '#60a5fa', user: '#111113' },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    light: { bg: '#f4f8fa', surface: '#ffffff', fg: '#0f1c24', muted: '#526570', line: '#dbe5ea', accent: '#0e7490', user: '#e6eff3' },
    dark: { bg: '#0f1a20', surface: '#16252d', fg: '#e8f1f5', muted: '#93a7b2', line: '#24363f', accent: '#22b8cf', user: '#0a1317' },
  },
  {
    id: 'forest',
    name: 'Forest',
    light: { bg: '#f6f8f4', surface: '#ffffff', fg: '#172016', muted: '#56634f', line: '#dfe6db', accent: '#3b7535', user: '#eaf0e6' },
    dark: { bg: '#161c15', surface: '#1f271e', fg: '#eef3ea', muted: '#9aa896', line: '#2f3a2d', accent: '#7fbf6a', user: '#10150f' },
  },
  {
    id: 'rose',
    name: 'Rose',
    light: { bg: '#fbf7f8', surface: '#ffffff', fg: '#22161a', muted: '#735c62', line: '#eedfe3', accent: '#b8365f', user: '#f5e9ec' },
    dark: { bg: '#211719', surface: '#2c1f22', fg: '#f8eef0', muted: '#b39ba1', line: '#3f2d31', accent: '#f07ea0', user: '#170f11' },
  },
  {
    id: 'lavender',
    name: 'Lavender',
    light: { bg: '#f8f7fc', surface: '#ffffff', fg: '#1b1830', muted: '#635f7a', line: '#e5e2f0', accent: '#6d4fd8', user: '#eeebf8' },
    dark: { bg: '#1b1a26', surface: '#252333', fg: '#f1f0f8', muted: '#a6a2bd', line: '#363349', accent: '#a08cf5', user: '#121119' },
  },
  {
    id: 'contrast',
    name: 'High contrast',
    light: { bg: '#ffffff', surface: '#ffffff', fg: '#000000', muted: '#3a3a3a', line: '#767676', accent: '#0047b3', user: '#ececec' },
    dark: { bg: '#000000', surface: '#0d0d0d', fg: '#ffffff', muted: '#c8c8c8', line: '#767676', accent: '#7fb2ff', user: '#1f1f1f' },
  },
];

export const themeById = (id: string): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0]!;
export const isThemeId = (id: unknown): id is string => typeof id === 'string' && THEMES.some((t) => t.id === id);

// ── Colour arithmetic ────────────────────────────────────────────────────

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** `a` laid over `b` at `t` (0: all `b`, 1: all `a`). */
export const mix = (a: string, b: string, t: number): string => {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((v, i) => v * t + y[i]! * (1 - t)));
};

const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** WCAG contrast ratio between two colours, 1 to 21. */
export const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

// ── Applying one ─────────────────────────────────────────────────────────

/** The page's colour variables for `p`, the stylesheets' names. */
export function tokens(p: Palette, dark: boolean): Record<string, string> {
  return {
    '--bg': p.bg,
    '--surface': p.surface,
    '--fg': p.fg,
    '--muted': p.muted,
    '--line': p.line,
    '--accent': p.accent,
    '--accent-bg': mix(p.accent, p.bg, dark ? 0.2 : 0.12),
    '--on-accent': contrast('#ffffff', p.accent) >= contrast('#141413', p.accent) ? '#ffffff' : '#141413',
    '--user-bg': p.user,
    '--hover': mix(p.fg, dark ? p.surface : p.bg, dark ? 0.08 : 0.06),
    '--drawer-bg': mix('#000000', p.bg, dark ? 0.2 : 0.03),
  };
}

/** The bar's: always the dark palette. */
export function barTokens(p: Palette): Record<string, string> {
  return {
    '--sai-bar-bg': p.surface,
    '--sai-bar-fg': p.fg,
    '--sai-bar-muted': p.muted,
    '--sai-bar-line': mix(p.fg, p.surface, 0.14),
    '--sai-accent': p.accent,
    '--sai-accent-hover': mix('#000000', p.accent, 0.12),
  };
}

const NAMES = [...Object.keys(tokens(THEMES[0]!.light, false)), ...Object.keys(barTokens(THEMES[0]!.dark))];

/** Puts `theme` on `root`; the default theme leaves the stylesheets' own colours. */
export function applyTheme(root: HTMLElement, theme: Theme, dark: boolean, bar = false): void {
  for (const name of NAMES) root.style.removeProperty(name);
  if (theme.id === DEFAULT_THEME) return;
  const vars = bar ? barTokens(theme.dark) : tokens(dark ? theme.dark : theme.light, dark);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}
