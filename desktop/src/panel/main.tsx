/**
 * The panel window: the chat (ui/Panel.tsx), as a card (card.ts) as tall
 * as its chat (fit.ts). It is made when the app starts and kept, hidden
 * between chats, so a selection shows it at once (core/main.ts).
 */
import { browser } from '../platform/install';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BRAND } from '@/brand';
import { Panel } from '@/ui/Panel';
import '@/ui/panel.css';
import 'katex/dist/katex.min.css';
import '../app.css';
import { cardWindow } from '../card';
import { MAC } from '../os';
import { fitToChat } from './fit';
import { followTheme } from '../theme';

document.title = BRAND.name;
followTheme();
// The system's own text sizes (app.css).
document.documentElement.dataset.system = MAC ? 'mac' : /Windows/.test(navigator.userAgent) ? 'windows' : 'linux';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>,
);

const fit = fitToChat();
cardWindow({
  drag: '.topbar',
  // ✕ finishes the chat, as the bar's does; the core then hides the panel.
  onClose: () => void browser.runtime.sendMessage({ type: 'chat:finish' }).catch(() => {}),
  onEnter: fit.reset,
});
