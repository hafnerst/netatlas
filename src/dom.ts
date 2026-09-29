/**
 * VNode -> DOM. The only place that creates elements from scene data.
 * Text is always assigned via text nodes; attribute names are restricted so
 * that no event handler or script URL can ever be produced from input data.
 */
import { VNode } from './scene';

export const SVG_NS = 'http://www.w3.org/2000/svg';

const SAFE_ATTR = /^(?:[a-z][a-z0-9-]*|viewBox|preserveAspectRatio)$/;

export function materialize(v: VNode, doc: Document, inSvg = false): Element {
  const svg = inSvg || v.tag === 'svg';
  const el = svg ? doc.createElementNS(SVG_NS, v.tag) : doc.createElement(v.tag);
  for (const name of Object.keys(v.attrs)) {
    if (!SAFE_ATTR.test(name) || /^on/i.test(name) || name === 'href' || name === 'src' || name === 'style') continue;
    el.setAttribute(name, v.attrs[name]);
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
