/**
 * The settings window (Options.tsx), as a card (card.ts). It is made hidden
 * at start and kept (src-tauri/src/wm.rs), so opening it only shows it:
 * each opening goes to the section asked for (or the top), and each closing
 * starts the page afresh for the next.
 */
import { transport } from '../platform/install';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BRAND } from '@/brand';
import { Options } from '@/settings/Options';
import '@/settings/options.css';
import '../app.css';
import { cardWindow, playEntrance } from '../card';
import { followTheme } from '../theme';

document.title = `${BRAND.name} Settings`;
followTheme();

/** Opening: shows `#section`, or the top. */
function opened(section: string): void {
  playEntrance();
  history.replaceState(null, '', section ? `#${section}` : location.pathname);
  const at = section ? document.getElementById(section) : null;
  if (at) at.scrollIntoView({ behavior: 'instant' });
  else document.querySelector('.page')?.scrollTo({ top: 0, behavior: 'instant' });
}

function SettingsPage() {
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    const off = [transport.listen('settings:closed', () => setTurn((t) => t + 1)), transport.listen<string>('settings:open', opened)];
    return () => off.forEach((o) => void o.then((f) => f()));
  }, []);
  return <Options key={turn} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsPage />
  </React.StrictMode>,
);

cardWindow({ drag: '.top', ready: () => !!document.querySelector('.options section') });
