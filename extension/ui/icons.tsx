/** The panel's icons (lib/icons.ts), drawn as React elements from their shapes. */
import { createElement } from 'react';
import { ICON_PATHS, type IconName, type Shapes } from '@/lib/icons';

export type { IconName } from '@/lib/icons';

/** React wants camelCase SVG attributes (strokeDasharray, not stroke-dasharray). */
const camel = (attrs: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()), v]));

export function ShapesIcon({ shapes, className }: { shapes: Shapes; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      {shapes.map(([tag, attrs], i) => createElement(tag, { key: i, ...camel(attrs) }))}
    </svg>
  );
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <ShapesIcon shapes={ICON_PATHS[name]} className={className} />;
}
