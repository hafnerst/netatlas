/**
 * VNode -> DOM. The only place that creates elements from scene data.
 * Text is always assigned via text nodes; attribute names are restricted so
 * that no event handler or script URL can ever be produced from input data.
 */
import { VNode, h } from '../diagram/scene';

export const SVG_NS = 'http://www.w3.org/2000/svg';

const SAFE_ATTR = /^(?:[a-z][a-z0-9-]*|viewBox|preserveAspectRatio)$/;

/** Attributes that hold a colour a scene element is painted with. */
const PAINT_ATTR = /^(?:fill|stroke|stop-color|color)$/;
let paint: ((color: string) => string) | null = null;

/**
 * The colour mapping of the theme in effect (diagram/palette.ts): applied to
 * the fill and stroke colours of every element created from scene data, so
 * the diagram, the legends and the exports are drawn in the theme's colours.
 */
export function setPaint(fn: ((color: string) => string) | null): void {
  paint = fn;
}

export function materialize(v: VNode, doc: Document, inSvg = false): Element {
  const svg = inSvg || v.tag === 'svg';
  const el = svg ? doc.createElementNS(SVG_NS, v.tag) : doc.createElement(v.tag);
  for (const name of Object.keys(v.attrs)) {
    if (!SAFE_ATTR.test(name) || /^on/i.test(name) || name === 'href' || name === 'src' || name === 'style') continue;
    el.setAttribute(name, paint && PAINT_ATTR.test(name) ? paint(v.attrs[name]) : v.attrs[name]);
  }
  if (v.text !== undefined) el.appendChild(doc.createTextNode(v.text));
  for (const c of v.children) el.appendChild(materialize(c, doc, svg && v.tag !== 'foreignObject'));
  return el;
}

/** Replace all children of `parent` with the rendered VNode(s). */
export function mount(parent: Element, nodes: VNode | VNode[], inSvg = false): void {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
  const doc = parent.ownerDocument as Document;
  for (const n of Array.isArray(nodes) ? nodes : [nodes]) parent.appendChild(materialize(n, doc, inSvg));
}

/** Tiny HTML element helper for UI chrome (text only, never markup). */
export function el(
  doc: Document,
  tag: string,
  attrs: { [k: string]: string } = {},
  children: Array<Node | string | null> = [],
): HTMLElement {
  const e = doc.createElement(tag);
  for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
  for (const c of children) {
    if (c === null) continue;
    e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
  }
  return e;
}

/** Line icons of the UI chrome (fixed path data, drawn in the current text colour). */
const ICONS: { [name: string]: string } = {
  duplicate: 'M9 9h11v11H9z M5 15H4V4h11v1',
  delete: 'M4 7h16 M9.5 7V4.5h5V7 M6.5 7l1 13h9l1-13 M10.5 11v5.5 M13.5 11v5.5',
  ok: 'M5 12.5l4.5 4.5L19 7.5',
  warning: 'M12 3.5l9.5 17h-19z M12 10v4.5 M12 17.5v.5',
  error: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7.5v6 M12 16.5v.5',
};

/** A small decorative icon as a VNode; the control it sits in carries the accessible name. */
export function iconNode(name: string): VNode {
  return h('svg', { class: 'icon-svg', viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true', focusable: 'false' }, [h('path', { d: ICONS[name] || '' })]);
}

/** A small decorative icon; the control it sits in carries the accessible name. */
export function icon(doc: Document, name: string): Element {
  return materialize(iconNode(name), doc, true);
}
