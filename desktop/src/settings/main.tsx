/** The settings window: the extension's settings page, with the app's own sections (surface.tsx), as a card (card.ts). */
import '../platform/install';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BRAND } from '@/brand';
import { Options } from '@/entrypoints/options/Options';
import '@/entrypoints/options/options.css';
import '../app.css';
import { cardWindow } from '../card';

document.title = `${BRAND.name} Settings`;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Options />
  </React.StrictMode>,
);

cardWindow({ drag: '.top', ready: () => !!document.querySelector('.options section') });
