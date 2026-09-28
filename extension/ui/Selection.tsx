/**
 * What was selected, shown the way a chat app shows an attachment: above the
 * composer while it waits to be sent, then inside the student's first message.
 *
 * A box shows its crop. A text selection shows the text itself — before this,
 * a text selection produced a one-line chip and an otherwise empty panel,
 * which read as "nothing happened" even though it had worked.
 */
import { useState } from 'react';
import type { Part, Plan } from '@shared/payload';
import { Tray } from './Tray';

/** Lines of captured text shown before "Show all". */
const COLLAPSED_LINES = 5;

export function SelectionCard({ plan, variant }: { plan: Plan; variant: 'pending' | 'sent' }) {
  return (
    <div className={`selection ${variant}`} data-testid="selection">
      {variant === 'pending' && <div className="selection-label">Attached selection</div>}
      <Tray plan={plan} />
      <div className="selection-body">
        {plan.parts.map((part, i) => (
          <PartPreview key={i} part={part} />
        ))}
      </div>
    </div>
  );
}

function PartPreview({ part }: { part: Part }) {
  switch (part.kind) {
    case 'image':
      return <img className="selection-image" src={part.dataUrl} alt="Selected region" width={part.width} height={part.height} />;
    case 'text':
      return <TextPreview text={part.text} />;
    case 'latex':
      return <pre className="selection-mono">{part.latex}</pre>;
    case 'table':
      return <pre className="selection-mono">{part.markdown}</pre>;
    case 'code':
      return <pre className="selection-mono">{part.code}</pre>;
  }
}

function TextPreview({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // Only offer "Show all" when there is actually more than fits.
  const long = text.split('\n').length > COLLAPSED_LINES || text.length > COLLAPSED_LINES * 70;
  return (
    <div className="selection-text-wrap">
      <blockquote className={`selection-text${open || !long ? ' open' : ''}`} data-testid="selection-text">
        {text}
      </blockquote>
      {long && (
        <button type="button" className="link" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}
