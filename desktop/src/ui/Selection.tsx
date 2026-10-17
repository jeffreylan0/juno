/**
 * A selection in the chat: its screenshot. It is exactly what the model
 * receives — nothing extra is read off the page. A selection from a page
 * other than the one the chat is named after says which page, since one chat
 * can gather selections from many.
 *
 * Screenshots sit straight on the panel's own background: no card, no frame,
 * no fill, so nothing around a selection looks like part of it. A thin
 * hairline marks the edge of a rectangular shot. A freeform shape shows only
 * what was inside its outline, with the outline drawn on; the model itself
 * gets that area with the outside painted white (src-tauri/src/crop.rs),
 * since models read transparency inconsistently.
 *
 * No token counts or routing details here.
 */
import type { ImagePart, Part, Point, SelectionKind } from '@shared/payload';
import type { SelectionItem } from '@/lib/chats';
import { kindIcon, kindLabel } from '@/lib/kinds';
import { Icon, ShapesIcon } from './icons';
import { useImage } from './useChat';

/**
 * A selection just made, before it lands: its kind, and a soft shimmer where
 * the screenshot will be.
 */
export function IncomingSelection({ kind }: { kind: SelectionKind }) {
  return (
    <section className="selection incoming" data-testid="selection-incoming" data-kind={kind} aria-busy="true">
      <div className="selection-head">
        <ShapesIcon shapes={kindIcon(kind)} />
        <span className="selection-kind">{kindLabel(kind)}</span>
      </div>
      <div className="selection-placeholder" aria-label="Adding the selection…" />
    </section>
  );
}

export function SelectionCard({ item, onRemove, showPage = true }: { item: SelectionItem; onRemove?: () => void; showPage?: boolean }) {
  const { plan, notice } = item;
  const kind = plan.selection.kind;
  return (
    <section className="selection" data-testid="selection" data-kind={kind}>
      <div className="selection-head">
        <ShapesIcon shapes={kindIcon(kind)} />
        <span className="selection-kind" data-testid="selection-kind">
          {kindLabel(kind)}
        </span>
        {showPage && <PageLink url={plan.page.url} title={plan.page.title} />}
        {onRemove && (
          <button type="button" className="icon selection-remove" title="Remove this selection" aria-label="Remove this selection" data-testid="selection-remove" onClick={onRemove}>
            <Icon name="close" />
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
      {notice && (
        <div className="error" role="alert" data-testid="selection-notice">
          {notice}
        </div>
      )}
    </section>
  );
}

/** Where the selection came from: its window's title (a link, in older chats that name a web page). */
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
  // Text, LaTeX, tables and code: only in chats saved by earlier versions (and the eval).
  if (part.kind === 'image') return <Shot part={part} outline={outline} />;
  const text = part.kind === 'text' ? part.text : part.kind === 'latex' ? part.latex : part.kind === 'table' ? part.markdown : part.code;
  return <pre className="selection-mono">{text}</pre>;
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
