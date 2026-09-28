import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/lib/storage';

describe('settings defaults', () => {
  it('arms a box selection and costs nothing out of the box', () => {
    expect(DEFAULT_SETTINGS.defaultSelectionKind).toBe('box');
    expect(DEFAULT_SETTINGS.provider).toBe('mock');
    expect(DEFAULT_SETTINGS.defaultMode).toBe('explain');
  });

  it('ships no keys and blocks no sites until the user says so', () => {
    expect(DEFAULT_SETTINGS.modelOverride).toBeNull();
    expect(DEFAULT_SETTINGS.blockedSites).toEqual([]);
  });
});
