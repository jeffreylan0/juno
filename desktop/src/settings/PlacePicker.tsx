/**
 * Where the bar or the panel goes: a little screen of 3×3 parts. The chosen
 * part's mark sits at its outer edge, where the bar or panel will (bar.ts,
 * geometry.rs).
 */
import type { Place } from '@/selection/bar';

const ROWS = ['top', 'middle', 'bottom'] as const;
const COLS = ['left', 'center', 'right'] as const;

/** "Top left", "Middle", "Bottom right": what a screen reader says for each part. */
export function placeName(place: Place): string {
  const [row, col] = place.split('-') as [(typeof ROWS)[number], (typeof COLS)[number]];
  if (row === 'middle' && col === 'center') return 'Middle';
  const r = { top: 'Top', middle: 'Middle', bottom: 'Bottom' }[row];
  return col === 'center' ? `${r} middle` : `${r} ${col}`;
}

export function PlacePicker({ label, value, onChange }: { label: string; value: Place; onChange: (place: Place) => void }) {
  return (
    <div className={`place-picker ${label.toLowerCase()}`} role="radiogroup" aria-label={label} data-testid={`place-${label.toLowerCase()}`}>
      <span className="place-label">{label}</span>
      <div className="place-screen">
        {ROWS.flatMap((row) =>
          COLS.map((col) => {
            const place: Place = `${row}-${col}`;
            const name = placeName(place);
            return (
              <button
                key={place}
                type="button"
                role="radio"
                aria-checked={value === place}
                aria-label={name}
                title={name}
                className="place-cell"
                data-place={place}
                onClick={() => onChange(place)}
              >
                <span className="place-mark" />
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
