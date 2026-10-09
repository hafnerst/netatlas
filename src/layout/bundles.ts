/**
 * Relations between the same two devices form a bundle of parallel lanes; a
 * relation carried over a tunnel of the same pair is nested inside that
 * tunnel's tube. Both the layout (to reserve room for the lanes and their
 * labels) and the logical renderer (to draw them) use this one definition.
 */
import { addressAttrLines } from '../model/addresses';
import { relationStyle } from '../model/protocols';
import { Model, ProtocolDef, Relation, relationDevices } from '../model/types';
import { cmp } from './order';

export const LANE_GAP = 7;
export const TUBE_WALL = 3;
export const TUBE_MIN = 12;
export const LINE_W = 2.4;

interface Lane {
  rel: Relation;
  def: ProtocolDef;
  width: number;
  children: Lane[];
}

export interface PlacedLane {
  rel: Relation;
  def: ProtocolDef;
  /** offset of the lane's center from the line between the two devices */
  offset: number;
  width: number;
  depth: number;
  /** label describing the nested stack, e.g. "IPsec · site-to-site › GRE › OSPF · area 1" */
  stack: string;
  /** true for lanes that are not nested in another one; these carry the label */
  root: boolean;
  /**
   * address lines of the stack (address-like attrs), drawn under the label:
   * the lane's own, then those of the relations nested in it, each of those
   * named by its protocol so the owner is clear
   */
  extra: string[];
}

export interface Bundle {
  a: string;
  b: string;
  lanes: PlacedLane[];
  /** total width across all lanes */
  width: number;
}

/** Text of the label of a root lane: the relation and everything nested in it, each with its own label. */
export function laneLabel(p: PlacedLane): string {
  return p.stack;
}

/** Key of a device pair, independent of endpoint order. */
export function pairKey(a: string, b: string): string {
  return cmp(a, b) <= 0 ? a + '\u0000' + b : b + '\u0000' + a;
}

/** Two-device relations grouped by device pair (pairs and relations in id order). */
export function relationPairs(relations: Relation[]): Map<string, Relation[]> {
  const byPair = new Map<string, Relation[]>();
  for (const r of relations.slice().sort((p, q) => cmp(p.id, q.id))) {
    const ds = relationDevices(r);
    if (ds.length !== 2) continue;
    const key = pairKey(ds[0], ds[1]);
    if (!byPair.has(key)) byPair.set(key, []);
    (byPair.get(key) as Relation[]).push(r);
  }
  return new Map(Array.from(byPair.entries()).sort((p, q) => cmp(p[0], q[0])));
}

/** Lanes of one device pair, with nesting, widths and offsets. */
export function buildBundle(model: Model, key: string, rels: Relation[]): Bundle {
  const [a, b] = key.split('\u0000');
  const inPair = new Set(rels.map((r) => r.id));
  const lanes = new Map<string, Lane>();
  for (const r of rels) lanes.set(r.id, { rel: r, def: relationStyle(model, r), width: 0, children: [] });
  const roots: Lane[] = [];
  for (const r of rels) {
    // (the smallest id if it names several, so the order of the list doesn't matter)
    const carrier = r.over
      .filter((o) => inPair.has(o) && (lanes.get(o) as Lane).def.style === 'tube')
      .sort(cmp)[0];
    if (carrier && carrier !== r.id) (lanes.get(carrier) as Lane).children.push(lanes.get(r.id) as Lane);
    else roots.push(lanes.get(r.id) as Lane);
  }
  // guard against cycles (validated already, but never loop forever)
  const measure = (ln: Lane, depth: number): number => {
    if (depth > 12) ln.children = [];
    const kids = ln.children.map((c) => measure(c, depth + 1));
    if (ln.def.style === 'tube') {
      const inner = kids.length ? kids.reduce((s, w) => s + w, 0) + 3 * (kids.length - 1) : 0;
      ln.width = Math.max(TUBE_MIN, inner + 2 * TUBE_WALL + 4);
    } else ln.width = LINE_W + 3;
    return ln.width;
  };
  roots.forEach((r) => measure(r, 0));
  // sort lanes: tunnels (widest) in the middle keeps the bundle symmetric
  roots.sort((u, v) => u.width - v.width || cmp(u.rel.id, v.rel.id));
  const ordered: Lane[] = [];
  roots.forEach((ln, i) => (i % 2 ? ordered.unshift(ln) : ordered.push(ln)));
  const total = ordered.reduce((s, l) => s + l.width, 0) + LANE_GAP * Math.max(0, ordered.length - 1);
  const placed: PlacedLane[] = [];
  // every relation of the stack is named with its own label, so none is lost by nesting
  const stackLabel = (ln: Lane): string =>
    ln.def.label +
    (ln.rel.label ? ' · ' + ln.rel.label : '') +
    (ln.children.length === 1 ? ' › ' + stackLabel(ln.children[0]) : ln.children.length > 1 ? ' › (' + ln.children.map(stackLabel).join(', ') + ')' : '');
  const stackExtra = (ln: Lane, nested: boolean): string[] =>
    addressAttrLines(ln.rel.attrs)
      .map((l) => (nested ? ln.def.label + ': ' + l : l))
      .concat(...ln.children.map((c) => stackExtra(c, true)));
  const place = (ln: Lane, offset: number, depth: number, root: boolean): void => {
    placed.push({ rel: ln.rel, def: ln.def, offset, width: ln.width, depth, stack: stackLabel(ln), root, extra: stackExtra(ln, false) });
    if (!ln.children.length) return;
    const inner = ln.children.reduce((s, c) => s + c.width, 0) + 3 * (ln.children.length - 1);
    let cur = offset - inner / 2;
    for (const c of ln.children) {
      place(c, cur + c.width / 2, depth + 1, false);
      cur += c.width + 3;
    }
  };
  let cur = -total / 2;
  for (const ln of ordered) {
    place(ln, cur + ln.width / 2, 0, true);
    cur += ln.width + LANE_GAP;
  }
  return { a, b, lanes: placed, width: total };
}
