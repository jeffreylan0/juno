/**
 * A selection in the chat: Box, Freeform and Element show their screenshot,
 * Text shows the text itself. It is exactly what the model receives — nothing
 * extra is read off the page. The page it came from is named, since one chat
 * can gather selections from many pages.
 *
 * Screenshots sit straight on the panel's own background: no card, no frame,
 * no fill, so nothing around a selection looks like part of it. A thin
 * hairline marks the edge of a rectangular shot. A freeform shape shows only
 * what was inside its outline, with the outline drawn on; the model itself
 * gets that area with the outside painted white (capture.ts), since models
 * read transparency inconsistently.
 *
 * No token counts or routing details here; those are for a super-user view
 * once plans and pricing settle (Settings.showUsage).
 */
import { useState } from 'react';
import type { ImagePart, Part, Point } from '@shared/payload';
import type { SelectionItem } from '@/lib/chats';
import { KIND_ICON, KIND_LABEL } from '@/lib/kinds';
import { useImage } from './useChat';

/** Lines of captured text shown before "Show all". */
const COLLAPSED_LINES = 14;

export function SelectionCard({ item, onRemove }: { item: SelectionItem; onRemove?: () => void }) {
  const { plan, notice } = item;
  const kind = plan.selection.kind;
  return (
    <section className="selection" data-testid="selection" data-kind={kind}>
      <div className="selection-head">
        <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: KIND_ICON[kind] }} />
        <span className="selection-kind" data-testid="selection-kind">
          {KIND_LABEL[kind]}
        </span>
        {kind === 'element' && plan.selection.label && <span className="selection-sub">· {plan.selection.label}</span>}
        <PageLink url={plan.page.url} title={plan.page.title} />
        {onRemove && (
          <button type="button" className="icon selection-remove" title="Remove this selection" aria-label="Remove this selection" data-testid="selection-remove" onClick={onRemove}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </div>
      {plan.parts.length > 0 && (
        <div className="selection-body">
          {plan.parts.map((part, i) => (
            <PartPreview key={i} part={part} outline={plan.selection.outline} />
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

/** Where the selection came from: the page's title, opening the page in a new tab. */
function PageLink({ url, title }: { url: string; title: string }) {
  let host = '';
  let safe = false;
  try {
    const u = new URL(url);
    host = u.hostname;
    safe = u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    /* not a URL we can show */
  }
  const label = title.trim() || host;
  if (!label) return null;
  return safe ? (
    <a className="selection-page" href={url} target="_blank" rel="noopener noreferrer" title={url} data-testid="selection-page">
      {label}
    </a>
  ) : (
    <span className="selection-page" title={url} data-testid="selection-page">
      {label}
    </span>
  );
}

function PartPreview({ part, outline }: { part: Part; outline?: Point[] }) {
  switch (part.kind) {
    case 'image':
      return <Shot part={part} outline={outline} />;
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

function Shot({ part, outline }: { part: ImagePart; outline?: Point[] }) {
  const src = useImage(part.dataUrl);
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const clipPath = outline?.length ? `polygon(${outline.map((p) => `${pct(p.x)} ${pct(p.y)}`).join(', ')})` : undefined;
  const d = outline?.length
    ? `M${outline.map((p) => `${(p.x * 100).toFixed(2)} ${(p.y * 100).toFixed(2)}`).join('L')}Z`
    : undefined;
  return (
    <div className="selection-frame" data-testid="selection-frame">
      <div className="selection-shot">
        {src === null ? (
          <div className="selection-missing">Screenshot no longer available</div>
        ) : (
          // Sized from the start (width/height), so nothing jumps when the pixels arrive.
          <img
            className={`selection-image${clipPath ? ' shaped' : ''}`}
            src={src}
            alt="The selected area"
            width={part.width}
            height={part.height}
            style={clipPath ? { clipPath } : undefined}
          />
        )}
        {d && (
          <svg className="selection-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path d={d} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </div>
    </div>
  );
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
