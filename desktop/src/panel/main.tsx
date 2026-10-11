/** The panel window: the extension's side panel, as a card (card.ts) as tall as its chat (fit.ts). */
import '../platform/install';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BRAND } from '@/brand';
import { Panel } from '@/ui/Panel';
import '@/ui/panel.css';
import 'katex/dist/katex.min.css';
import '../app.css';
import { cardWindow } from '../card';
import { fitToChat } from './fit';

document.title = BRAND.name;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>,
);

// Shown once connected and showing its chat, so it never opens empty.
cardWindow({ drag: '.topbar', ready: () => !!document.querySelector('.panel[data-chat]:not([data-chat=""])') });
fitToChat();
