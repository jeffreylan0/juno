import React from 'react';
import ReactDOM from 'react-dom/client';
import { BRAND } from '@/brand';
import { Options } from './Options';
import './options.css';

document.title = `${BRAND.name} – Settings`;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Options />
  </React.StrictMode>,
);
