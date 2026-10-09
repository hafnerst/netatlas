/**
 * Self-contained SVG for export: every style the browser computed for the
 * diagram on screen (from the stylesheet, its design tokens and the theme in
 * effect) is written onto the elements as plain presentation attributes with
 * resolved values. The file carries no stylesheet, no CSS custom property and
 * no prefers-color-scheme query, so it looks the same in every viewer,
 * whatever that viewer's own colour scheme, and always shows the theme that
 * was selected in NetAtlas when it was exported.
 */

/** Inherited properties, written where an element's value differs from its parent's. */
const INHERITED = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'paint-order',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'visibility',
];
/** Properties that are not inherited, written where they are not the default. */
const OWN: Array<[string, string]> = [
  ['opacity', '1'],
  ['display', 'inline'],
];

/** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" → hex colour and alpha; other values (none, url(…)) as they are. */
export function resolvedPaint(v: string): { color: string; alpha: number } {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v.trim());
  if (!m) return { color: v, alpha: 1 };
  const hex = '#' + [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(255, Math.round(parseFloat(x)))).toString(16).padStart(2, '0')).join('');
  let a = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (m[4] && m[4].endsWith('%')) a /= 100;
  return { color: a === 0 ? 'none' : hex, alpha: a };
}

function round(v: string): string {
  return v.replace(/(\d+\.\d{3})\d+/g, (_m, d: string) => String(parseFloat(d)));
}

/**
 * Write the computed styles of `svg` (and every element in it) as attributes.
 * The SVG must be in the document while this runs (that is where its styles
 * are computed); afterwards it needs no stylesheet. Class attributes are
 * kept: they name what an element is, and style nothing any more.
 */
export function inlineComputedStyles(svg: SVGSVGElement, win: Window): void {
  const visit = (e: Element, parent: Map<string, string> | null): void => {
    const cs = win.getComputedStyle(e);
    const mine = new Map<string, string>();
    // the alpha of an rgba() colour goes into fill-opacity / stroke-opacity (understood by every SVG viewer)
    const alpha: { [p: string]: number } = {};
    for (const p of INHERITED) {
      let v = cs.getPropertyValue(p).trim();
      if (p === 'fill' || p === 'stroke') {
        const pv = resolvedPaint(v);
        v = pv.color;
        alpha[p + '-opacity'] = pv.alpha;
      } else if (alpha[p] !== undefined) {
        const base = parseFloat(v);
        v = String(Math.round((isNaN(base) ? 1 : base) * alpha[p] * 1000) / 1000);
      }
      v = round(v);
      mine.set(p, v);
      if (!parent || parent.get(p) !== v || e.hasAttribute(p)) e.setAttribute(p, v);
    }
    for (const [p, def] of OWN) {
      const v = cs.getPropertyValue(p).trim();
      if (v && v !== def) e.setAttribute(p, p === 'display' ? (v === 'none' ? 'none' : 'inline') : v);
    }
    // a glow (selection, highlight): a CSS filter function with its colour resolved
    const f = cs.getPropertyValue('filter').trim();
    if (f && f !== 'none') e.setAttribute('style', 'filter: ' + f);
    else e.removeAttribute('style');
    for (let i = 0; i < e.children.length; i++) visit(e.children[i], mine);
  };
  visit(svg, null);
}
