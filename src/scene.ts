/**
 * A tiny, DOM-free virtual node tree. Renderers build VNodes (pure and
 * testable in Node); dom.ts turns them into real SVG elements using only
 * createElementNS / setAttribute / textContent, so user-provided strings
 * can never be interpreted as markup.
 */
export interface VNode {
  tag: string;
  attrs: { [name: string]: string };
  children: VNode[];
  /** Text content (set as a text node, never parsed). */
  text?: string;
}

type Child = VNode | null | undefined | false;
type AttrVal = string | number | undefined | null | false;

export function h(tag: string, attrs: { [name: string]: AttrVal } = {}, children: Child[] | string = []): VNode {
  const a: { [name: string]: string } = {};
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    a[k] = typeof v === 'number' ? fmt(v) : v;
  }
  if (typeof children === 'string') return { tag, attrs: a, children: [], text: children };
  return { tag, attrs: a, children: children.filter((c): c is VNode => !!c) };
}

/** Compact number formatting for SVG coordinates. */
export function fmt(n: number): string {
  if (!isFinite(n)) return '0';
  return String(Math.round(n * 10) / 10);
}

export function walk(v: VNode, fn: (n: VNode) => void): void {
  fn(v);
  for (const c of v.children) walk(c, fn);
}

export function findAll(v: VNode, pred: (n: VNode) => boolean): VNode[] {
  const out: VNode[] = [];
  walk(v, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
}

export function hasClass(v: VNode, cls: string): boolean {
  const c = v.attrs['class'];
  return !!c && (' ' + c + ' ').indexOf(' ' + cls + ' ') >= 0;
}

/** All text content in the tree, concatenated (used by tests and search). */
export function textOf(v: VNode): string {
  let s = '';
  walk(v, (n) => {
    if (n.text) s += n.text + '\n';
  });
  return s;
}
