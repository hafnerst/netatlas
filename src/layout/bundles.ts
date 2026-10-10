/**
 * Relations between the same two devices form a bundle. Its relations are
 * grouped into strands by the interfaces they are bound to at the two ends
 * (a device-level endpoint is a binding of its own): every strand runs from
 * one port to one port, so a relation is always drawn from the interfaces it
 * references, never from a neighbour's. Within a strand the relations are
 * parallel lanes, and a relation carried over a tunnel of the same strand
 * is nested inside that tunnel's tube. Both the layout (to reserve room for
 * the lanes, ports and labels) and the logical renderer (to draw them) use
 * this one definition.
 */
import { addressAttrLines } from '../model/addresses';
import { relationStyle } from '../model/protocols';
import { Model, ProtocolDef, RelEndpoint, Relation, relationDevices } from '../model/types';
import { cmp } from './order';

export const LANE_GAP = 7;
export const TUBE_WALL = 3;
export const TUBE_MIN = 12;
export const LINE_W = 2.4;
/** gap between two strands that leave the same port */
export const STRAND_GAP = 5;

interface Lane {
  rel: Relation;
  def: ProtocolDef;
  width: number;
  children: Lane[];
}

export interface PlacedLane {
  rel: Relation;
  def: ProtocolDef;
  /** offset of the lane's center from its strand's center line (along the normal of the direction a → b) */
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
  /** index of the strand the lane belongs to (Bundle.strands) */
  strand: number;
}

/** The relations of a bundle bound to the same interface (or to the device) at each end. */
export interface Strand {
  /** interface id at device `a` (undefined: the relations are bound to the device itself) */
  ia?: string;
  /** interface id at device `b` */
  ib?: string;
  lanes: PlacedLane[];
  /** total width across its lanes */
  width: number;
}

export interface Bundle {
  a: string;
  b: string;
  strands: Strand[];
  /** every lane of every strand, strand by strand */
  lanes: PlacedLane[];
  /** total width across all lanes (all strands side by side) */
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

/**
 * The endpoint by which a relation is attached to a device: its first
 * endpoint on that device. Its interface (if any) is the binding.
 */
export function endpointOn(r: Relation, device: string): RelEndpoint | undefined {
  for (const e of r.endpoints) if (e.device === device) return e;
  return undefined;
}

/** The interface a relation is bound to on a device (undefined: device level). */
export function bindingOn(r: Relation, device: string): string | undefined {
  const e = endpointOn(r, device);
  return e ? e.iface : undefined;
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

/**
 * Lanes of the relations of one strand, with nesting, widths and offsets
 * (from the strand's center line). `elsewhere` names, for a relation
 * carried over a tunnel of the same device pair that is bound to other
 * ports (and so runs in another strand), that tunnel's protocol: its label
 * says what it is carried over, as nesting would have shown.
 */
function strandLanes(model: Model, rels: Relation[], index: number, elsewhere: Map<string, string>): { lanes: PlacedLane[]; width: number } {
  const inStrand = new Set(rels.map((r) => r.id));
  const lanes = new Map<string, Lane>();
  for (const r of rels) lanes.set(r.id, { rel: r, def: relationStyle(model, r), width: 0, children: [] });
  const roots: Lane[] = [];
  for (const r of rels) {
    // nested only in a tube of the same strand: a carrier bound to other ports runs elsewhere
    // (the smallest id if it names several, so the order of the list doesn't matter)
    const carrier = r.over
      .filter((o) => inStrand.has(o) && (lanes.get(o) as Lane).def.style === 'tube')
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
  // sort lanes: tunnels (widest) in the middle keeps the strand symmetric
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
  const rootLabel = (ln: Lane): string => stackLabel(ln) + (elsewhere.has(ln.rel.id) ? ' (over ' + elsewhere.get(ln.rel.id) + ')' : '');
  const stackExtra = (ln: Lane, nested: boolean): string[] =>
    addressAttrLines(ln.rel.attrs)
      .map((l) => (nested ? ln.def.label + ': ' + l : l))
      .concat(...ln.children.map((c) => stackExtra(c, true)));
  const place = (ln: Lane, offset: number, depth: number, root: boolean): void => {
    placed.push({ rel: ln.rel, def: ln.def, offset, width: ln.width, depth, stack: root ? rootLabel(ln) : stackLabel(ln), root, extra: stackExtra(ln, false), strand: index });
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
  return { lanes: placed, width: total };
}

/** Key of a strand within its bundle: the binding at `a`, then at `b` (device level first). */
function strandKey(ia: string | undefined, ib: string | undefined): string {
  return (ia === undefined ? '' : '\u0001' + ia) + '\u0000' + (ib === undefined ? '' : '\u0001' + ib);
}

/** Strands of one device pair, each with its lanes; strands in the order of their bindings. */
export function buildBundle(model: Model, key: string, rels: Relation[]): Bundle {
  const [a, b] = key.split('\u0000');
  const groups = new Map<string, { ia?: string; ib?: string; rels: Relation[] }>();
  for (const r of rels) {
    const ia = bindingOn(r, a);
    const ib = bindingOn(r, b);
    const k = strandKey(ia, ib);
    if (!groups.has(k)) groups.set(k, { ia, ib, rels: [] });
    (groups.get(k) as { rels: Relation[] }).rels.push(r);
  }
  const keys = Array.from(groups.keys()).sort(cmp);
  // a relation carried over a tunnel of this pair that runs in another strand (bound to other ports)
  const strandOf = new Map<string, string>();
  groups.forEach((g, k) => g.rels.forEach((r) => strandOf.set(r.id, k)));
  const byId = new Map(rels.map((r) => [r.id, r] as [string, Relation]));
  const elsewhere = new Map<string, string>();
  for (const r of rels) {
    const carrier = r.over
      .filter((o) => byId.has(o) && o !== r.id && relationStyle(model, byId.get(o) as Relation).style === 'tube')
      .sort(cmp)[0];
    if (carrier && strandOf.get(carrier) !== strandOf.get(r.id)) elsewhere.set(r.id, relationStyle(model, byId.get(carrier) as Relation).label);
  }
  const strands: Strand[] = [];
  const lanes: PlacedLane[] = [];
  keys.forEach((k, i) => {
    const g = groups.get(k) as { ia?: string; ib?: string; rels: Relation[] };
    const s = strandLanes(model, g.rels, i, elsewhere);
    strands.push({ ia: g.ia, ib: g.ib, lanes: s.lanes, width: s.width });
    lanes.push(...s.lanes);
  });
  const width = strands.reduce((s, x) => s + x.width, 0) + STRAND_GAP * Math.max(0, strands.length - 1);
  return { a, b, strands, lanes, width };
}

/** Width of the spoke of a multipoint relation (to its hub). */
export function spokeWidth(model: Model, r: Relation): number {
  return relationStyle(model, r).style === 'tube' ? TUBE_MIN : LINE_W + 3;
}

/** Key of a port binding: "device:iface", or "device:" for the device-level port. */
export function bindingKey(device: string, iface: string | undefined): string {
  return device + ':' + (iface === undefined ? '' : iface);
}

/**
 * The room the ports of each binding need along the side of their device:
 * every strand and every spoke bound to it, side by side, as if all of them
 * left on the same side (the side is only chosen when they are drawn).
 * Keyed by bindingKey().
 */
export function portSpans(model: Model, relations: Relation[] = model.relations): Map<string, number> {
  const parts = new Map<string, number[]>();
  const add = (device: string, iface: string | undefined, w: number): void => {
    const k = bindingKey(device, iface);
    if (!parts.has(k)) parts.set(k, []);
    (parts.get(k) as number[]).push(w);
  };
  relationPairs(relations).forEach((rels, key) => {
    const bundle = buildBundle(model, key, rels);
    for (const s of bundle.strands) {
      add(bundle.a, s.ia, s.width);
      add(bundle.b, s.ib, s.width);
    }
  });
  for (const r of relations.slice().sort((p, q) => cmp(p.id, q.id))) {
    const ds = relationDevices(r);
    if (ds.length < 3) continue;
    for (const d of ds) add(d, bindingOn(r, d), spokeWidth(model, r));
  }
  const out = new Map<string, number>();
  parts.forEach((ws, k) => out.set(k, ws.reduce((s, w) => s + w, 0) + STRAND_GAP * (ws.length - 1)));
  return out;
}
