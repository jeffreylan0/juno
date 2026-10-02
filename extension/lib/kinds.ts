/**
 * The selection modes as the student sees them: a name and an icon, shared by
 * the in-page bar and the panel so they always match.
 */
import type { SelectionKind } from '@shared/payload';
import type { Shapes } from './icons';

/** Left to right in the bar. */
export const KIND_ORDER: SelectionKind[] = ['box', 'freeform', 'element', 'text'];

export const KIND_LABEL: Record<SelectionKind, string> = {
  box: 'Box',
  freeform: 'Freeform',
  element: 'Element',
  text: 'Text',
};

/** 24×24 stroke icons, as shapes (see icons.ts). */
export const KIND_ICON: Record<SelectionKind, Shapes> = {
  box: [['rect', {x:"3",y:"5",width:"18",height:"14",rx:"2",'stroke-dasharray':"3 2.4"}]],
  text: [['path', {d:"M5 6.5V5h14v1.5"}], ['path', {d:"M12 5v14"}], ['path', {d:"M9 19h6"}]],
  element: [['path', {d:"M4 4h16v6H4z"}], ['path', {d:"M4 14h7v6H4z"}], ['path', {d:"M14 14h6v6h-6z"}]],
  freeform: [['path', {d:"M7.5 17.5C4.4 16.3 3 14.3 3 12c0-4 4-7 9-7s9 3 9 7-4 7-9 7c-1 0-2-.1-2.9-.3",'stroke-dasharray':"3 2.4"}], ['path', {d:"M9 19.2c-.4 1-1.3 1.8-2.6 1.8"}]],
};
