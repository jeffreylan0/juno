/**
 * The selection modes as the student sees them: a name and an icon, shared by
 * the bar and the panel so they always match.
 */
import type { SelectionKind } from '@shared/payload';
import type { Shapes } from './icons';

/** Left to right in the bar. */
export const KIND_ORDER: SelectionKind[] = ['box', 'freeform'];

export const KIND_LABEL: Record<SelectionKind, string> = {
  box: 'Box',
  freeform: 'Freeform',
};

/** 24×24 stroke icons, as shapes (see icons.ts). */
export const KIND_ICON: Record<SelectionKind, Shapes> = {
  box: [['rect', {x:"3",y:"5",width:"18",height:"14",rx:"2",'stroke-dasharray':"3 2.4"}]],
  freeform: [['path', {d:"M7.5 17.5C4.4 16.3 3 14.3 3 12c0-4 4-7 9-7s9 3 9 7-4 7-9 7c-1 0-2-.1-2.9-.3",'stroke-dasharray':"3 2.4"}], ['path', {d:"M9 19.2c-.4 1-1.3 1.8-2.6 1.8"}]],
};

/** A selection saved by an earlier version may be of a kind no longer offered ('text', 'element'). */
const known = (kind: string): kind is SelectionKind => kind in KIND_LABEL;
export const kindLabel = (kind: string) => (known(kind) ? KIND_LABEL[kind] : 'Selection');
export const kindIcon = (kind: string) => KIND_ICON[known(kind) ? kind : 'box'];
