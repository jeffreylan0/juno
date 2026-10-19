import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migrateSettings } from '@/lib/storage';
import { THEMES, applyTheme, barTokens, contrast, mix, themeById, tokens } from '@/lib/themes';
import { isDark } from '@/theme';

describe('colour themes', () => {
  it('are all readable: text on the window, quieter text, and what sits on the accent', () => {
    for (const t of THEMES) {
      for (const [scheme, p] of [['light', t.light], ['dark', t.dark]] as const) {
        const at = `${t.id} ${scheme}`;
        expect(contrast(p.fg, p.bg), at).toBeGreaterThanOrEqual(7);
        expect(contrast(p.fg, p.user), at).toBeGreaterThanOrEqual(7);
        expect(contrast(p.muted, p.bg), at).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.muted, p.surface), at).toBeGreaterThanOrEqual(4.5);
        const v = tokens(p, scheme === 'dark');
        expect(contrast(v['--on-accent']!, p.accent), at).toBeGreaterThanOrEqual(3);
        expect(contrast(p.accent, p.bg), at).toBeGreaterThanOrEqual(3);
      }
      // The bar, always dark.
      const bar = barTokens(t.dark);
      expect(contrast(bar['--sai-bar-fg']!, bar['--sai-bar-bg']!), t.id).toBeGreaterThanOrEqual(7);
    }
  });

  it('mixes colours', () => {
    expect(mix('#ffffff', '#000000', 0.5)).toBe('#808080');
    expect(mix('#c96442', '#faf9f5', 0)).toBe('#faf9f5');
  });

  it('put a theme on the page, and the default takes it off again', () => {
    const root = document.createElement('div');
    applyTheme(root, themeById('ocean'), false);
    expect(root.style.getPropertyValue('--accent')).toBe('#0e7490');
    expect(root.style.getPropertyValue('--sai-bar-bg')).toBe('');
    applyTheme(root, themeById('ocean'), true, true);
    expect(root.style.getPropertyValue('--sai-bar-bg')).toBe('#16252d');
    expect(root.style.getPropertyValue('--accent')).toBe('');
    applyTheme(root, themeById('claude'), false);
    expect(root.getAttribute('style') ?? '').toBe('');
  });

  it('is light or dark as chosen, or as the system is', () => {
    expect(DEFAULT_SETTINGS.scheme).toBe('system');
    expect([isDark('system', true), isDark('system', false)]).toEqual([true, false]);
    expect([isDark('dark', false), isDark('light', true)]).toEqual([true, false]);
    expect(migrateSettings({ scheme: 'dark' }).scheme).toBe('dark');
    expect(migrateSettings({ scheme: 'sepia' }).scheme).toBe('system');
  });

  it('is a setting: Claude to start, and an unknown theme falls back to it', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('claude');
    expect(migrateSettings({ theme: 'rose' }).theme).toBe('rose');
    expect(migrateSettings({ theme: 'from-the-marketplace' }).theme).toBe('claude');
    expect(themeById('nope').id).toBe('claude');
  });
});
