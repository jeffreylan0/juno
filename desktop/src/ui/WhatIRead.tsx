import { useState } from 'react';

/** The collapsed restatement line: what the model says it received. */
export function WhatIRead({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" className={`what-i-read${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)} title="What the model read">
      <span className="wir-label">Read</span>
      <span className="wir-text">{text}</span>
    </button>
  );
}
