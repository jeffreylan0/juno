/**
 * Where this code is running: the browser extension (this file) or the
 * desktop app, whose build swaps in desktop/src/surface.tsx in its place.
 * The few sentences and settings that differ between the two read from here;
 * everything else is the same code.
 */
import type { ReactNode } from 'react';

export interface Surface {
  kind: 'extension' | 'desktop';
  /** Where selections can come from: "Selections from any tab go into this chat." */
  anywhere: string;
  /** What a selection's title comes from: "…and the page's title go to the AI you picked." */
  source: string;
  /** Where API keys are kept, as a sentence. */
  keysKept: string;
  /** The settings page's "Keyboard shortcut" field, when the surface has its own. */
  shortcutField: (() => ReactNode) | null;
  /** Settings sections only this surface has, after the others. */
  sections: { id: string; title: string; render: () => ReactNode }[];
  /** Whether "Blocked sites" applies. */
  blockedSites: boolean;
  /** Whether the browser's PDF viewer (and the reader it offers) is a thing here. */
  pdfViewer: boolean;
  /** Why a mode's chip is off, when it is. */
  unavailable: (label: string, kind: string) => string;
  /** The panel and settings are windows of their own, with their own ✕ (the app). */
  ownWindow: boolean;
  /** The bar's instruction for a mode, where it differs from the page's. */
  modeHints?: Partial<Record<'box' | 'freeform' | 'element' | 'text', string>>;
}

export const SURFACE: Surface = {
  kind: 'extension',
  anywhere: 'any tab',
  source: 'page',
  keysKept: 'Your keys stay in this browser.',
  shortcutField: null,
  sections: [],
  blockedSites: true,
  pdfViewer: true,
  ownWindow: false,
  // Only the browser's own PDF viewer takes modes away: it has no DOM to read.
  unavailable: (label, kind) => (kind === 'text' || kind === 'element' ? `${label} needs the PDF reader` : `${label} doesn't work here`),
};
