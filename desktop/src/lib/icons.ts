/**
 * Stroke icons, 24×24, drawn in currentColor. Kept as data — each shape a tag
 * and its attributes — and built element by element, never parsed from markup,
 * so no icon can ever carry anything but shapes. Shared by the panel
 * (ui/icons.tsx) and the bar, which cannot use React.
 */
export type Shape = readonly ['path' | 'circle' | 'rect', Readonly<Record<string, string>>];
export type Shapes = readonly Shape[];

export const ICON_PATHS = {
  menu: [['path', {d:"M4 7h16M4 12h16M4 17h16"}]],
  search: [['circle', {cx:"11",cy:"11",r:"6.5"}], ['path', {d:"m20 20-4.2-4.2"}]],
  pencil: [['path', {d:"M16.5 3.8a2.1 2.1 0 0 1 3 3L8 18.3l-4 1 1-4z"}]],
  trash: [['path', {d:"M4 7h16"}], ['path', {d:"M9.5 7V4.8h5V7"}], ['path', {d:"M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7"}]],
  // A ghost: temporary chats, as Gemini and ChatGPT draw them.
  ghost: [['path', {d:"M5 19.5V10a7 7 0 0 1 14 0v9.5l-2.33-1.5-2.34 1.5L12 18l-2.33 1.5-2.34-1.5z"}], ['circle', {cx:"9.5",cy:"10.5",r:"1.25",fill:"currentColor",stroke:"none"}], ['circle', {cx:"14.5",cy:"10.5",r:"1.25",fill:"currentColor",stroke:"none"}]],
  gear: [['circle', {cx:"12",cy:"12",r:"3"}], ['path', {d:"M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"}]],
  close: [['path', {d:"M6 6l12 12M18 6 6 18"}]],
  send: [['path', {d:"M12 19V5"}], ['path', {d:"m5 12 7-7 7 7"}]],
  stop: [['rect', {x:"6",y:"6",width:"12",height:"12",rx:"2"}]],
  warning: [['path', {d:"M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"}], ['path', {d:"M12 9.5v4"}], ['path', {d:"M12 17h.01"}]],
  // A plug pulled apart: disconnected.
  unplugged: [['path', {d:"m19 5 3-3"}], ['path', {d:"m2 22 3-3"}], ['path', {d:"M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4z"}], ['path', {d:"M7.5 13.5 10 11"}], ['path', {d:"M10.5 16.5 13 14"}], ['path', {d:"m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0z"}]],
  info: [['circle', {cx:"12",cy:"12",r:"9"}], ['path', {d:"M12 11v5"}], ['path', {d:"M12 8h.01"}]],
  copy: [['rect', {x:"9",y:"9",width:"11",height:"11",rx:"2.5"}], ['path', {d:"M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"}]],
  // Round arrow: ask again.
  retry: [['path', {d:"M4 12a8 8 0 1 0 2.6-5.9L4 8.5"}], ['path', {d:"M4 4v4.5h4.5"}]],
  check: [['path', {d:"m5 12.5 4.5 4.5L19 7.5"}]],
} satisfies Record<string, Shapes>;

export type IconName = keyof typeof ICON_PATHS;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An icon as an <svg> element, for DOM code (the bar). */
export function svgIcon(shapes: Shapes): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}
