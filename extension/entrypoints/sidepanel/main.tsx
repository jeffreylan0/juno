import React from 'react';
import ReactDOM from 'react-dom/client';
import { Panel } from '@/ui/Panel';
import '@/ui/panel.css';
import 'katex/dist/katex.min.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>,
);
