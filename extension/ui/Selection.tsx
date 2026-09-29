/**
 * What was selected, pinned to the top of the conversation: a Box shows its
 * screenshot, Text shows the text itself. It is exactly what the model
 * receives — nothing extra is read off the page.
 *
 * No token counts or routing details here; those are for a super-user view
 * once plans and pricing settle (Settings.showUsage).
 */
import { useState } from 'react';
import type { Part, Plan, SelectionKind } from '@shared/payload';

/** Lines of captured text shown before "Show all". */
const COLLAPSED_LINES = 14;

const KIND_LABEL: Record<SelectionKind, string> = { box: 'Box', text: 'Text', element: 'Element' };

const KIND_ICON: Record<SelectionKind, string> = {
  box: '<rect x="3" y="5" width="18" height="14" rx="2" stroke-dasharray="3 2.4"/>',
  text: '<path d="M5 6.5V5h14v1.5"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  element: '<path d="M4 4h16v6H4z"/><path d="M4 14h7v6H4z"/><path d="M14 14h6v6h-6z"/>',
};

export function SelectionCard({ plan, notice }: { plan: Plan; notice?: string }) {
  const kind = plan.selection.kind;
  return (
    <section className="selection" data-testid="selection" data-kind={kind}>
      <div className="selection-head">
        <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: KIND_ICON[kind] }} />
        <span data-testid="selection-kind">{KIND_LABEL[kind]}</span>
      </div>
      {plan.parts.length > 0 && (
        <div className="selection-body">
          {plan.parts.map((part, i) => (
            <PartPreview key={i} part={part} />
          ))}
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
