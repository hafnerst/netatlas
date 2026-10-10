/**
 * Ports and routes of the logical view.
 *
 * Every relation is drawn from the interfaces it references, never from the
 * device as a whole:
 *
 * - Each row of a device's box that relations are bound to has a port on the
 *   side of the box, beside that row: the entry of an interface, or (for
 *   relations bound to the device itself) the device's name part, a port of
 *   its own that is drawn differently. A port is found by the interface's
 *   identity (its id in the model), never by a position or an index.
 * - A strand (the relations of a device pair bound to the same ports, see
 *   layout/bundles.ts) leaves its port on the side of the box that gives
 *   the shorter way to its peer without crossing either box; the choice is
 *   made from the geometry alone and ties are broken in a fixed order, so it
 *   is deterministic.
 * - Several strands (and spokes) at one port are stacked along it in the
 *   order of the height of their far ends, which keeps them from crossing
 *   each other; the row is high enough for all of them (layout/sizes.ts
 *   portRowH).
 * - A route leaves the port at a right angle, runs a stub straight out, then
 *   goes to the other stub, around every box in the way (diagram/physical.ts
 *   detour), so it never passes over another row of either device. The lanes
 *   of a strand follow its route as parallel offsets of it.
 */
import { HUB_R, LNode } from '../layout/logical';
import { Bundle, STRAND_GAP, bindingKey, bindingOn, spokeWidth } from '../layout/bundles';
import { Pt, Rect, boxRect, clipToCircle, normal, segmentHitsRect } from '../layout/geometry';
import { endLabelH, endLabelWidth } from '../layout/input';
import { ENTRY_GAP, PORT_INSET, PORT_STUB, entryBox } from '../layout/sizes';
import { Device, Model, Relation, relationDevices } from '../model/types';
import { entryItems } from './physical';

export type PortSide = 'left' | 'right';

/** The vertical extent of a row of a device's box. */
export interface RowSpan {
  top: number;
  bottom: number;
}

/**
 * The rows a port can be beside, by binding: "" for the device's name part
 * (the device-level port), else the interface id. Exactly the geometry the
 * renderer draws the entries with (diagram/physical.ts entryNodes).
 */
export function deviceRows(model: Model, d: Device, n: LNode): Map<string, RowSpan> {
  const top = n.cy - n.h / 2;
  const bodyH = n.bodyH || n.h;
  const rows = new Map<string, RowSpan>();
  rows.set('', { top, bottom: top + bodyH });
  let y = top + bodyH;
  for (const it of entryItems(model, d, 'logical')) {
    const h = entryBox(it).h;
    const prefix = 'iface:' + d.id + ':';
    if (it.ref.indexOf(prefix) === 0) rows.set(it.ref.slice(prefix.length), { top: y, bottom: y + h });
    y += h + ENTRY_GAP;
  }
  return rows;
}

/** One strand or spoke where it attaches to a port. */
interface End {
  /** "s:<bundle index>:<strand index>:a|b" or "h:<relation id>:<device>" */
  id: string;
  device: string;
  iface?: string;
  width: number;
  side: PortSide;
  /** where the other end is (for the order along the port) */
  far: Pt;
  /** center of the end along the port (set when the port is laid out) */
  y: number;
  /** where the route turns after leaving the port: up (-1), down (1) or straight on (0) */
  turn: number;
  /** length of the stub: from the side of the box to where the route turns */
  stub: number;
}

/** A port: the side of a device box beside one row, and the strands and spokes leaving it. */
export interface LPort {
  device: string;
  /** undefined: the device-level port */
  iface?: string;
  side: PortSide;
  /** x of the side of the box */
  x: number;
  /** the row it is beside: the port's area along the side */
  row: RowSpan;
  /** the extent the lanes take at the port */
  top: number;
  bottom: number;
  /** the shortest stub of the routes leaving it: room for its end label beside them */
  stub: number;
  /** which way most of its routes turn after their stubs (-1 up, 1 down, 0 straight on) */
  turn: number;
  /** its end label is written under the lanes (they turn up), else above them */
  labelBelow: boolean;
}

export interface LogicalRoutes {
  /** center line of each strand, from device `a` to device `b`, by "<bundle index>:<strand index>" */
  strands: Map<string, Pt[]>;
  /** each spoke, from its device's port to the hub's circle, by "<relation id>:<device>" */
  spokes: Map<string, Pt[]>;
  ports: LPort[];
  /** strands and spokes that could not be attached (an endpoint without a row); they are not drawn */
  unattached: string[];
}

/** how far routes keep from the sides of devices other than their own, at least */
const PORT_CLEAR = PORT_STUB + 16;
/** where an end label starts, from the side of the box */
export const END_LABEL_X = 5;

const SIDES: Array<[PortSide, PortSide]> = [
  ['right', 'left'],
  ['left', 'right'],
  ['right', 'right'],
  ['left', 'left'],
];

function sideX(n: LNode, side: PortSide): number {
  return side === 'right' ? n.cx + n.w / 2 : n.cx - n.w / 2;
}

function dirOf(side: PortSide): number {
  return side === 'right' ? 1 : -1;
}

function mid(r: RowSpan): number {
  return (r.top + r.bottom) / 2;
}

function len(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Lay out the ports of the logical view and route every strand and spoke.
 * `rows` gives the rows of each device box (deviceRows), `others` the
 * boxes other than devices that routes keep clear of (networks). A route
 * keeps clear of its own two devices by a little and of every other device
 * by a stub and an end label's room, so it never runs through the place
 * where another device's ports and their labels are.
 */
export function routeLogical(
  model: Model,
  nodes: Map<string, LNode>,
  rows: Map<string, Map<string, RowSpan>>,
  bundles: Bundle[],
  hubs: Relation[],
  others: Rect[],
): LogicalRoutes {
  const dev = (id: string): LNode | undefined => nodes.get('device:' + id);
  const rowOf = (d: string, iface: string | undefined): RowSpan | undefined => {
    const r = rows.get(d);
    return r ? r.get(iface === undefined ? '' : iface) : undefined;
  };
  const boxes = new Map<string, Rect>();
  const near = new Map<string, Rect>();
  const far = new Map<string, Rect>();
  nodes.forEach((n) => {
    if (n.kind !== 'device') return;
    boxes.set(n.id, boxRect(n, 4));
    near.set(n.id, boxRect(n, 6));
    far.set(n.id, boxRect(n, PORT_CLEAR));
  });
  /** what the route between these devices keeps clear of */
  const obstaclesFor = (own: string[], a?: Pt, b?: Pt): Rect[] => {
    const out: Rect[] = [];
    // a device whose ports' room holds the route's own start or end (two devices close together) is kept
    // clear of by its box only; a box that holds one (overlapping boxes, moved by hand) can't be avoided
    const holds = (r: Rect): boolean => !!a && !!b && (inside(a, r) || inside(b, r));
    far.forEach((r, id) => {
      const n = near.get(id) as Rect;
      const o = own.indexOf(id) >= 0 || holds(r) ? n : r;
      if (!holds(o)) out.push(o);
    });
    return out.concat(a && b ? clearOf(others, a, b) : others);
  };
  /** what a straight piece between two stubs costs: its length, and more for every box it crosses */
  const pieceCost = (p: Pt, q: Pt, own: string[]): number => {
    let c = len(p, q);
    for (const d of own) {
      const b = boxes.get(d);
      if (b && segmentHitsRect(p, q, b)) c += 5000;
    }
    for (const o of obstaclesFor(own)) if (segmentHitsRect(p, q, o)) c += 400;
    return c;
  };
  const ends: End[] = [];
  const unattached: string[] = [];
  const strandEnds = new Map<string, [End, End]>();
  bundles.forEach((b, bi) => {
    const A = dev(b.a);
    const B = dev(b.b);
    if (!A || !B) return;
    b.strands.forEach((s, si) => {
      const id = bi + ':' + si;
      const ra = rowOf(b.a, s.ia);
      const rb = rowOf(b.b, s.ib);
      // a binding without a row is never drawn somewhere else instead
      if (!ra || !rb) {
        unattached.push(id);
        return;
      }
      let best: [PortSide, PortSide] = SIDES[0];
      let bestCost = Infinity;
      for (const [sa, sb] of SIDES) {
        const pa = { x: sideX(A, sa), y: mid(ra) };
        const pb = { x: sideX(B, sb), y: mid(rb) };
        const qa = { x: pa.x + dirOf(sa) * PORT_STUB, y: pa.y };
        const qb = { x: pb.x + dirOf(sb) * PORT_STUB, y: pb.y };
        const c = 2 * PORT_STUB + pieceCost(qa, qb, [b.a, b.b]);
        if (c < bestCost - 0.01) {
          bestCost = c;
          best = [sa, sb];
        }
      }
      const ea: End = { id: 's:' + id + ':a', device: b.a, iface: s.ia, width: s.width, side: best[0], far: { x: B.cx, y: mid(rb) }, y: 0, turn: 0, stub: PORT_STUB };
      const eb: End = { id: 's:' + id + ':b', device: b.b, iface: s.ib, width: s.width, side: best[1], far: { x: A.cx, y: mid(ra) }, y: 0, turn: 0, stub: PORT_STUB };
      ends.push(ea, eb);
      strandEnds.set(id, [ea, eb]);
    });
  });
  const spokeEnds = new Map<string, End>();
  for (const r of hubs) {
    const hub = nodes.get('hub:' + r.id);
    if (!hub) continue;
    for (const d of relationDevices(r)) {
      const D = dev(d);
      const iface = bindingOn(r, d);
      const row = rowOf(d, iface);
      const id = r.id + ':' + d;
      if (!D || !row) {
        unattached.push('h:' + id);
        continue;
      }
      let side: PortSide = 'right';
      let bestCost = Infinity;
      for (const s of ['right', 'left'] as PortSide[]) {
        const q = { x: sideX(D, s) + dirOf(s) * PORT_STUB, y: mid(row) };
        const c = pieceCost(q, { x: hub.cx, y: hub.cy }, [d]);
        if (c < bestCost - 0.01) {
          bestCost = c;
          side = s;
        }
      }
      const e: End = { id: 'h:' + id, device: d, iface, width: spokeWidth(model, r), side, far: { x: hub.cx, y: hub.cy }, y: 0, turn: 0, stub: PORT_STUB };
      ends.push(e);
      spokeEnds.set(id, e);
    }
  }

  // ---- ports: the ends at one row and side, stacked along it
  const byPort = new Map<string, End[]>();
  for (const e of ends) {
    const k = bindingKey(e.device, e.iface) + '|' + e.side;
    if (!byPort.has(k)) byPort.set(k, []);
    (byPort.get(k) as End[]).push(e);
  }
  const ports: LPort[] = [];
  /** by port key: is its end label under the lanes */
  const labelSide = new Map<string, boolean>();
  Array.from(byPort.keys())
    .sort((p, q) => (p < q ? -1 : p > q ? 1 : 0))
    .forEach((k) => {
      const list = byPort.get(k) as End[];
      const first = list[0];
      const row = rowOf(first.device, first.iface) as RowSpan;
      const n0 = dev(first.device) as LNode;
      const from = { x: sideX(n0, first.side), y: mid(row) };
      // from the top down: in the order of the directions they head in (up and back, up, out, down, down and back)
      const key = new Map(list.map((e) => [e, heading(from, e.far, first.side)] as [End, number]));
      list.sort((u, v) => (key.get(u) as number) - (key.get(v) as number) || (u.id < v.id ? -1 : u.id > v.id ? 1 : 0));
      const total = list.reduce((s, e) => s + e.width, 0) + STRAND_GAP * (list.length - 1);
      // The row is high enough for every end at it (when they all leave on one side) and, above them,
      // for the port's end label: the lanes take the middle of the rest of the row.
      // the label goes on the side of the lanes away from where most of them turn (they leave it behind)
      const t = list.reduce((sum, e) => sum + turnOf(e.far.y - mid(row)), 0);
      const labelBelow = t < 0;
      labelSide.set(k, labelBelow);
      const lab = endLabelH(model, first.device, first.iface);
      const lo = row.top + PORT_INSET + (labelBelow ? 0 : lab);
      const hi = row.bottom - PORT_INSET - (labelBelow ? lab : 0);
      let start = (lo + hi) / 2 - total / 2;
      if (total <= hi - lo) start = Math.max(lo, Math.min(hi - total, start));
      else start = Math.max(row.top + PORT_INSET, Math.min(hi - total, start));
      const top = start;
      for (const e of list) {
        e.y = start + e.width / 2;
        start += e.width + STRAND_GAP;
      }
      const n = dev(first.device) as LNode;
      ports.push({ device: first.device, iface: first.iface, side: first.side, x: sideX(n, first.side), row, top, bottom: top + total, stub: 0, turn: 0, labelBelow, ends: list } as LPort & { ends: End[] });
    });

  // ---- stubs. Where the routes of one side of a box turn the same way,
  // the one that turns from nearer the side is the one closest to where it
  // is going: the routes nest like tracks, and none crosses the stub of
  // another port. A stub is at least as long as its port's end label, which
  // is written beside it.
  strandEnds.forEach(([ea, eb]) => {
    ea.turn = turnOf(eb.y - ea.y);
    eb.turn = turnOf(ea.y - eb.y);
  });
  spokeEnds.forEach((e) => (e.turn = turnOf(e.far.y - e.y)));
  const bySide = new Map<string, End[]>();
  for (const e of ends) {
    const k = e.device + '\u0000' + e.side;
    if (!bySide.has(k)) bySide.set(k, []);
    (bySide.get(k) as End[]).push(e);
  }
  /** how far the end label of a binding reaches out from the side of its box (0: none) */
  const labelReach = (d: string, iface: string | undefined): number => (iface === undefined ? 0 : END_LABEL_X + endLabelWidth(model, d, iface) + 2);
  bySide.forEach((list) => {
    // the own end label is on the side the lanes turn away from: it needs no longer stub
    // … unless it turns toward that side (a port with lanes turning both ways): then it turns beyond the label
    const base = (e: End): number => {
      const below = labelSide.get(bindingKey(e.device, e.iface) + '|' + e.side);
      return (below ? e.turn > 0 : e.turn < 0) ? Math.max(PORT_STUB, labelReach(e.device, e.iface) + 8 + e.width / 2) : PORT_STUB;
    };
    // A route that turns up passes beside every row above its own, one that turns down every row below:
    // it turns beyond the end labels written there.
    const rowTop = (e: End): number => (rowOf(e.device, e.iface) as RowSpan).top;
    const passed = (e: End): number => {
      let m = 0;
      for (const o of list) {
        if (e.turn === 0 || bindingKey(o.device, o.iface) === bindingKey(e.device, e.iface)) continue;
        if (e.turn < 0 ? rowTop(o) < rowTop(e) : rowTop(o) > rowTop(e)) m = Math.max(m, labelReach(o.device, o.iface) + 6 + e.width / 2);
      }
      return m;
    };
    const nest = (seq: End[]): void => {
      let prev: End | null = null;
      for (const e of seq) {
        e.stub = Math.max(base(e), passed(e), prev ? prev.stub + prev.width / 2 + STRAND_GAP + e.width / 2 : 0);
        prev = e;
      }
    };
    const byId = (u: End, v: End): number => (u.id < v.id ? -1 : u.id > v.id ? 1 : 0);
    // turning down (or straight on): from the lowest end up; turning up: from the highest end down
    nest(list.filter((e) => e.turn >= 0).sort((u, v) => v.y - u.y || byId(u, v)));
    nest(list.filter((e) => e.turn < 0).sort((u, v) => u.y - v.y || byId(u, v)));
  });

  // Other devices are kept clear of as far as their stubs reach out (and a little above and below).
  const reach = new Map<string, { left: number; right: number }>();
  for (const e of ends) {
    const r = reach.get(e.device) || { left: 0, right: 0 };
    r[e.side] = Math.max(r[e.side], e.stub + e.width / 2, labelReach(e.device, e.iface));
    reach.set(e.device, r);
  }
  nodes.forEach((n) => {
    if (n.kind !== 'device') return;
    const r = reach.get(n.id) || { left: 0, right: 0 };
    const b = boxRect(n);
    const l = Math.max(PORT_CLEAR, r.left + 6);
    const rr = Math.max(PORT_CLEAR, r.right + 6);
    far.set(n.id, { x: b.x - l, y: b.y - 10, w: b.w + l + rr, h: b.h + 20 });
  });

  // ---- routes: port, stub, around the boxes in the way, stub, port
  /** the corners of obstacles routes go around, and how far out the next one has to go (see laneDetour) */
  const corners = new Map<string, number>();
  const strands = new Map<string, Pt[]>();
  strandEnds.forEach(([ea, eb], id) => {
    const [bi] = id.split(':');
    const b = bundles[Number(bi)];
    const A = dev(b.a) as LNode;
    const B = dev(b.b) as LNode;
    const pa = { x: sideX(A, ea.side), y: ea.y };
    const pb = { x: sideX(B, eb.side), y: eb.y };
    const qa = { x: pa.x + dirOf(ea.side) * ea.stub, y: pa.y };
    const qb = { x: pb.x + dirOf(eb.side) * eb.stub, y: pb.y };
    const width = b.strands[Number(id.split(':')[1])].width;
    const obstacles = obstaclesFor([b.a, b.b], qa, qb);
    // heading back past its own box: first out of the box's reach, then on (around whatever is in the way)
    const ca = pastOwnBox(qa, qb, dirOf(ea.side), boxRect(A), obstacles);
    const s0 = ca.length ? ca[ca.length - 1] : qa;
    const cb = pastOwnBox(qb, s0, dirOf(eb.side), boxRect(B), obstacles).reverse();
    const e0 = cb.length ? cb[0] : qb;
    const pts = clean([pa, qa, ...ca, ...laneDetour(s0, e0, obstacles, width, corners), ...cb, qb, pb]);
    strands.set(id, clean(elbow(elbow(pts, dirOf(ea.side), obstacles, boxRect(A)).reverse(), dirOf(eb.side), obstacles, boxRect(B)).reverse()));
  });
  const spokes = new Map<string, Pt[]>();
  for (const r of hubs) {
    const hub = nodes.get('hub:' + r.id);
    if (!hub) continue;
    for (const d of relationDevices(r)) {
      const e = spokeEnds.get(r.id + ':' + d);
      if (!e) continue;
      const D = dev(d) as LNode;
      const p = { x: sideX(D, e.side), y: e.y };
      const q = { x: p.x + dirOf(e.side) * e.stub, y: p.y };
      const c = { x: hub.cx, y: hub.cy };
      const obstacles = obstaclesFor([d], q, { x: hub.cx, y: hub.cy });
      const cq = pastOwnBox(q, c, dirOf(e.side), boxRect(D), obstacles);
      const way = cq.concat(laneDetour(cq.length ? cq[cq.length - 1] : q, c, obstacles, e.width, corners));
      const last = way.length ? way[way.length - 1] : q;
      spokes.set(r.id + ':' + d, clean(elbow(clean([p, q, ...way, clipToCircle(c, HUB_R, last)]), dirOf(e.side), obstacles, boxRect(D))));
    }
  }
  for (const p of ports as Array<LPort & { ends?: End[] }>) {
    const list = p.ends as End[];
    delete p.ends;
    p.stub = list.reduce((m, e) => Math.min(m, e.stub), Infinity);
    const t = list.reduce((sum, e) => sum + e.turn, 0);
    p.turn = t > 0 ? 1 : t < 0 ? -1 : 0;
  }
  return { strands, spokes, ports, unattached };
}

/**
 * A number that grows with the direction from `from` to `to`, turning
 * clockwise from "up and back over the box" through "straight out" to
 * "down and back", as seen from a port on `side`. A pseudo-angle: only
 * + - * /, so every browser orders the same way.
 */
function heading(from: Pt, to: Pt, side: PortSide): number {
  const u = (to.x - from.x) * dirOf(side);
  const v = to.y - from.y;
  const a = Math.abs(u) + Math.abs(v);
  if (a === 0) return 0;
  const p = v / a;
  if (u >= 0) return p;
  return v < 0 ? -2 - p : 2 - p;
}

function turnOf(dy: number): number {
  return dy > 1 ? 1 : dy < -1 ? -1 : 0;
}

/**
 * A route that would head back toward its box right after the stub (to go
 * around a corner on that side, or to a hub under or over the box) first
 * runs straight up or down from where the stub ends: past the end of its
 * own box if that is enough, else to the height it is going to. So it never
 * passes beside the rows of its box, where the ports' end labels are
 * written. Only where that way is free of every box.
 */
function elbow(pts: Pt[], dir: number, obstacles: Rect[], own: Rect): Pt[] {
  if (pts.length < 3) return pts;
  const q = pts[1];
  const next = pts[2];
  if ((next.x - q.x) * dir >= -0.5 || Math.abs(next.y - q.y) < 0.5) return pts;
  const down = next.y > q.y;
  const past = down ? own.y + own.h + 16 : own.y - 16;
  const tries = (down ? past < next.y : past > next.y) ? [past, next.y] : [next.y];
  for (const y of tries) {
    const corner = { x: q.x, y };
    if (!obstacles.some((o) => segmentHitsRect(q, corner, o) || segmentHitsRect(corner, next, o))) return [pts[0], q, corner].concat(pts.slice(2));
  }
  return pts;
}

/**
 * The obstacles a route can keep clear of: not those its own start or end
 * lies in (two devices close together), which it could not avoid anyway.
 */
function clearOf(obstacles: Rect[], a: Pt, b: Pt): Rect[] {
  return obstacles.filter((r) => !inside(a, r) && !inside(b, r));
}

function inside(p: Pt, r: Rect): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}

/**
 * Where a route that heads back past its own box (its target lies behind
 * the side it leaves from) first goes: straight up or down from the end of
 * its stub to beyond the box, so it does not pass beside the box's rows;
 * if something is in that way, the stub first runs further out. Empty when
 * it is not heading back, or no such way is free.
 */
function pastOwnBox(q: Pt, target: Pt, dir: number, own: Rect, obstacles: Rect[]): Pt[] {
  if ((target.x - q.x) * dir >= 0) return [];
  const down = target.y > q.y;
  const y = down ? own.y + own.h + 16 : own.y - 16;
  if (down ? y >= target.y : y <= target.y) return [];
  for (let k = 0; k <= 12; k++) {
    const out = { x: q.x + dir * k * 14, y: q.y };
    const corner = { x: out.x, y };
    if (obstacles.some((o) => segmentHitsRect(q, out, o) || segmentHitsRect(out, corner, o))) continue;
    return k ? [out, corner] : [corner];
  }
  return [];
}

function grow(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

/** distance of a route's center line from the corner of an obstacle it goes around */
const CORNER_M = 14;

/**
 * Way points from `s` to `e` around the obstacles the straight line would
 * cross, for a strand `width` wide (as diagram/physical.ts detour, which
 * the physical view's cables use). Every corner of an obstacle is used by
 * one route after the other, each one strand further out than the one
 * before (`used`, shared by all routes of the scene): routes around the same
 * corner run side by side, never on top of each other.
 */
function laneDetour(s: Pt, e: Pt, obstacles: Rect[], width: number, used: Map<string, number>, depth = 0): Pt[] {
  if (depth >= 4) return [];
  const half = width / 2;
  let hit: Rect | null = null;
  let hitD = Infinity;
  for (const o of obstacles) {
    if (!segmentHitsRect(s, e, grow(o, half))) continue;
    const d = Math.hypot(o.x + o.w / 2 - s.x, o.y + o.h / 2 - s.y);
    if (d < hitD) {
      hitD = d;
      hit = o;
    }
  }
  if (!hit) return [];
  const h = hit;
  const key = (k: number): string => [h.x, h.y, h.w, h.h, k].map((v) => Math.round(v * 10)).join(',');
  const corner = (k: number): Pt => {
    const m = CORNER_M + half + (used.get(key(k)) || 0);
    return { x: k % 2 ? h.x + h.w + m : h.x - m, y: k < 2 ? h.y - m : h.y + h.h + m };
  };
  // corners: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right
  const len = (p: Pt, q: Pt): number => Math.hypot(q.x - p.x, q.y - p.y);
  const box = grow(h, half);
  const clear = (p: Pt, q: Pt): boolean => !segmentHitsRect(p, q, box);
  const ways: number[][] = [[0], [1], [2], [3]];
  for (const [i, j] of [[0, 2], [1, 3], [0, 1], [2, 3]]) ways.push([i, j], [j, i]);
  const usable = ways
    .map((w, i) => {
      const pts = w.map(corner);
      return { w, pts, i, cost: len(s, pts[0]) + (pts.length > 1 ? len(pts[0], pts[1]) : 0) + len(pts[pts.length - 1], e) };
    })
    .filter((x) => clear(s, x.pts[0]) && clear(x.pts[x.pts.length - 1], e))
    .sort((p, q) => p.cost - q.cost || p.i - q.i);
  if (!usable.length) return [];
  const best = usable[0];
  for (const k of best.w) used.set(key(k), (used.get(key(k)) || 0) + width + STRAND_GAP);
  const w = best.pts;
  return [...laneDetour(s, w[0], obstacles, width, used, depth + 1), ...w, ...laneDetour(w[w.length - 1], e, obstacles, width, used, depth + 1)];
}

/** A polyline without repeated points. */
function clean(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q.x - p.x) > 0.01 || Math.abs(q.y - p.y) > 0.01) out.push(p);
  }
  return out;
}

/**
 * The polyline `pts` moved sideways by `o` (along the normal of each
 * segment, as layout/geometry.ts normal()): a lane parallel to its strand's
 * center line. Corners are mitred; a corner so sharp that the mitre would
 * reach far out is bevelled instead.
 */
export function offsetPolyline(pts: Pt[], o: number): Pt[] {
  if (!o || pts.length < 2) return pts.slice();
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      const nr = i === 0 ? normal(pts[0], pts[1]) : normal(pts[n - 2], pts[n - 1]);
      out.push({ x: pts[i].x + nr.x * o, y: pts[i].y + nr.y * o });
      continue;
    }
    const n1 = normal(pts[i - 1], pts[i]);
    const n2 = normal(pts[i], pts[i + 1]);
    const dot = n1.x * n2.x + n1.y * n2.y;
    if (1 + dot < 0.5) {
      out.push({ x: pts[i].x + n1.x * o, y: pts[i].y + n1.y * o }, { x: pts[i].x + n2.x * o, y: pts[i].y + n2.y * o });
      continue;
    }
    const k = o / (1 + dot);
    out.push({ x: pts[i].x + (n1.x + n2.x) * k, y: pts[i].y + (n1.y + n2.y) * k });
  }
  return out;
}

/** The longest segment of a route between its two stubs (the whole route when it has no inner segment). */
export function middleSegment(pts: Pt[], stubs: [boolean, boolean] = [true, true]): [Pt, Pt] {
  const lo = stubs[0] && pts.length > 3 ? 1 : 0;
  const hi = stubs[1] && pts.length > 3 ? pts.length - 2 : pts.length - 1;
  let best = lo;
  let bestLen = -1;
  for (let i = lo; i < hi; i++) {
    const d = len(pts[i], pts[i + 1]);
    if (d > bestLen + 0.01) {
      bestLen = d;
      best = i;
    }
  }
  return [pts[best], pts[best + 1]];
}

/** SVG path data of a polyline. */
export function polylineD(pts: Pt[]): string {
  return pts.map((p, i) => (i ? 'L' : 'M') + r1(p.x) + ' ' + r1(p.y)).join('');
}

function r1(v: number): string {
  return String(Math.round(v * 10) / 10);
}
