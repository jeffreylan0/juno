/** The settings window (Options.tsx), as a card (card.ts). */
import '../platform/install';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BRAND } from '@/brand';
import { Options } from '@/settings/Options';
import '@/settings/options.css';
import '../app.css';
import { cardWindow } from '../card';
import { followTheme } from '../theme';

document.title = `${BRAND.name} Settings`;
followTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Options />
  </React.StrictMode>,
);

cardWindow({ drag: '.top', ready: () => !!document.querySelector('.options section') });
