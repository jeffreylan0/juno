/**
 * What was selected, pinned to the top of the conversation: Box, Freeform and
 * Element show their screenshot, Text shows the text itself. It is exactly
 * what the model receives — nothing extra is read off the page.
 *
 * No token counts or routing details here; those are for a super-user view
 * once plans and pricing settle (Settings.showUsage).
 */
import { useState } from 'react';
import type { Part, Plan } from '@shared/payload';
import { KIND_ICON, KIND_LABEL } from '@/lib/kinds';

/** Lines of captured text shown before "Show all". */
const COLLAPSED_LINES = 14;

export function SelectionCard({ plan, notice }: { plan: Plan; notice?: string }) {
  const kind = plan.selection.kind;
  return (
    <section className="selection" data-testid="selection" data-kind={kind}>
      <div className="selection-head">
        <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: KIND_ICON[kind] }} />
        <span data-testid="selection-kind">{KIND_LABEL[kind]}</span>
        {kind === 'element' && plan.selection.label && <span className="selection-sub">· {plan.selection.label}</span>}
      </div>
      {plan.parts.length > 0 && (
        <div className="selection-body">
          {plan.parts.map((part, i) => (
            <PartPreview key={i} part={part} />
          ))}
        </div>
      )}
      {plan.selection.clipped && (
        <div className="selection-note" data-testid="selection-clipped">
          Only the part on screen was captured. For all of it, zoom out or select it in pieces.
        </div>
      )}
      {notice && (
        <div className="error" role="alert" data-testid="selection-notice">
          {notice}
        </div>
      )}
    </section>
  );
}

function PartPreview({ part }: { part: Part }) {
  switch (part.kind) {
    case 'image':
      return <img className="selection-image" src={part.dataUrl} alt="The selected area" width={part.width} height={part.height} />;
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
  const long = text.split('\n').length > COLLAPSED_LINES || text.length > COLLAPSED_LINES * 60;
  return (
    <div className="selection-text-wrap">
      <blockquote
        className={`selection-text${open || !long ? ' open' : ''}`}
        style={{ WebkitLineClamp: COLLAPSED_LINES }}
        data-testid="selection-text"
      >
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
