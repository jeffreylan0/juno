import React from 'react';
import ReactDOM from 'react-dom/client';
import { BRAND } from '@/brand';
import { Panel } from '@/ui/Panel';
import '@/ui/panel.css';
import 'katex/dist/katex.min.css';

document.title = BRAND.name;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>,
);
