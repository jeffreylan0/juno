import type { Part, Plan } from '@shared/payload';

/** Numbered selection chips. Week 6 adds "Sent as" toggles. */
export function Tray({ plan }: { plan: Plan }) {
  return (
    <div className="tray">
      {plan.parts.map((p, i) => (
        <span key={i} className={`chip chip-${p.kind}`} title={chipTitle(p)}>
          <b>{i + 1}</b> {chipLabel(p)}
        </span>
      ))}
      <span className="chip meta">~{plan.estimatedTokens} tok · {plan.route}</span>
    </div>
  );
}

function chipLabel(p: Part): string {
  switch (p.kind) {
    case 'text':
      return `text (${p.text.length} ch)`;
    case 'latex':
      return 'LaTeX';
    case 'table':
      return `table ${p.rows}×${p.cols}`;
    case 'code':
      return `code${p.language ? ` (${p.language})` : ''}`;
    case 'image':
      return `image ${p.width}×${p.height}`;
  }
}

function chipTitle(p: Part): string {
  switch (p.kind) {
    case 'text':
      return p.text.slice(0, 200);
    case 'latex':
      return p.latex;
    case 'table':
      return p.markdown.slice(0, 200);
    case 'code':
      return p.code.slice(0, 200);
    case 'image':
      return `Sent as an image because: ${p.reason}`;
  }
}
