/**
 * Logical view layout.
 *
 * Auto-arrange (`autoLogical`) is a deterministic force-directed layout
 * (Fruchterman–Reingold style) of devices, networks and multipoint-relation
 * hubs, computed only from the canonical LayoutInput:
 *   - the graph is split into connected components; each is laid out on its
 *     own, seeded from the auto-arranged *physical* positions (never from
 *     manual positions), so both views keep a similar mental map;
 *   - every node is as large as its full text needs; the distance between two
 *     connected nodes is chosen from their sizes and from the labels that
 *     have to fit between them, and boxes are pushed apart to keep that room;
 *   - components are packed in rows, largest first (ties: smallest id);
 *   - devices are clustered by group (location): each group's content (its
 *     devices and child groups) is laid out on its own, deepest groups
 *     first, and the group then takes part in the layout around it as one
 *     box of exactly the size of its frame (content + GROUP_PAD + title), so
 *     a group's frame never covers a device of another group. Networks and
 *     multipoint hubs belong to no group and are placed around the groups.
 *     A model without groups is laid out exactly as before;
 *   - nodes and edges are processed in id order; only + - * / and Math.sqrt
 *     are used (Math.hypot / sin / cos may differ between browsers), and the
 *     result is rounded to integers.
 */
import { CBox, Pt } from './geometry';
import { LGroup, LayoutInput, cmp } from './input';
import { GROUP_PAD, HUB_R, groupHeader, logicalDeviceSize, networkBody, pillBox } from './sizes';

export { CHIP_H, HUB_R, MAX_CHIPS, chipRows, networkSubtitle } from './sizes';

export interface LNode extends CBox {
  /** "device:<id>" | "network:<id>" | "hub:<relationId>" */
  ref: string;
  kind: 'device' | 'network' | 'hub';
  id: string;
  /** devices: height of the device box itself (the node also holds the loopback chips) */
  bodyH?: number;
}

export interface LogicalLayout {
  nodes: Map<string, LNode>;
}

export interface LSpec {
  ref: string;
  kind: 'device' | 'network' | 'hub';
  id: string;
  w: number;
  h: number;
  bodyH?: number;
}

/**
 * A layout edge: [node ref, node ref, weight, rx, ry]. The labels between the
 * two nodes need a horizontal gap of rx OR a vertical gap of ry between the
 * boxes (label text is horizontal, so a vertical line needs much less).
 */
export type LEdge = [string, string, number, number, number];

/** Relations with 3+ distinct devices are drawn as a hub with spokes. */
export function isMultipoint(devs: string[]): boolean {
  return devs.length >= 3;
}

/** The drawn device rectangle inside a (possibly taller) logical node. */
export function deviceRect(n: LNode): LNode {
  if (n.kind !== 'device' || n.bodyH === undefined || n.h <= n.bodyH) return n;
  return { ...n, cy: n.cy - n.h / 2 + n.bodyH / 2, h: n.bodyH };
}

/** Nodes of the logical view with their sizes, sorted by ref. */
export function logicalSpecs(input: LayoutInput): LSpec[] {
  const involved = new Set<string>();
  for (const r of input.relations) for (const d of r.devices) involved.add(d);
  for (const n of input.networks) for (const d of n.members) involved.add(d);
  // loopbacks are logical: a device that has one belongs in the logical view
  for (const d of input.devices) if (d.loopbacks) involved.add(d.id);
  const devs = involved.size ? input.devices.filter((d) => involved.has(d.id)) : input.devices;
  const out: LSpec[] = [];
  for (const d of devs) out.push({ ref: 'device:' + d.id, kind: 'device', id: d.id, ...logicalDeviceSize(d.label, d.sub, d.chipW, d.loopbacks, d.dns) });
  for (const n of input.networks) {
    const b = networkBody(n.label, n.sub);
    out.push({ ref: 'network:' + n.id, kind: 'network', id: n.id, w: b.w, h: b.h });
  }
  const devSet = new Set(devs.map((d) => d.id));
  for (const r of input.relations) {
    const ds = r.devices.filter((d) => devSet.has(d));
    if (isMultipoint(ds)) out.push({ ref: 'hub:' + r.id, kind: 'hub', id: r.id, w: HUB_R * 2, h: HUB_R * 2 });
  }
  return out.sort((a, b) => cmp(a.ref, b.ref));
}

/** room for the address written on a membership line, and for a hub's spokes */
const MEMBER_ROOM: [number, number] = [120, 56];
const SPOKE_ROOM: [number, number] = [80, 50];

/**
 * Room the labels of a device pair need between the two boxes: as wide as
 * the widest label, or as high as all of them stacked.
 */
export function pairLabelRoom(labels: string[]): [number, number] {
  const boxes = labels.map(pillBox);
  return [boxes.reduce((m, b) => Math.max(m, b.w), 0) + 40, boxes.reduce((s, b) => s + b.h + 4, 0) + 44];
}

/** Weighted edges between node refs (canonical order), each with the room its labels need. */
export function logicalEdges(input: LayoutInput, specs: LSpec[]): LEdge[] {
  const has = new Set(specs.map((s) => s.ref));
  const edges: LEdge[] = [];
  for (const n of input.networks) for (const d of n.members) if (has.has('device:' + d)) edges.push(['network:' + n.id, 'device:' + d, 1, MEMBER_ROOM[0], MEMBER_ROOM[1]]);
  for (const r of input.relations) {
    const ds = r.devices.filter((d) => has.has('device:' + d));
    if (isMultipoint(ds)) for (const d of ds) edges.push(['hub:' + r.id, 'device:' + d, 0.8, SPOKE_ROOM[0], SPOKE_ROOM[1]]);
  }
  for (const p of input.pairs) {
    if (!has.has('device:' + p.a) || !has.has('device:' + p.b)) continue;
    const [rx, ry] = pairLabelRoom(p.labels);
    edges.push(['device:' + p.a, 'device:' + p.b, Math.min(2, 0.7 + p.labels.length * 0.15), rx, ry]);
  }
  return edges.sort((p, q) => cmp(p[0], q[0]) || cmp(p[1], q[1]));
}

/** 16 unit directions (k · 22.5°) as constants: no trigonometry at run time. */
const DIRS: Array<[number, number]> = [
  [1, 0], [0.9238795325, 0.3826834324], [0.7071067812, 0.7071067812], [0.3826834324, 0.9238795325],
  [0, 1], [-0.3826834324, 0.9238795325], [-0.7071067812, 0.7071067812], [-0.9238795325, 0.3826834324],
  [-1, 0], [-0.9238795325, -0.3826834324], [-0.7071067812, -0.7071067812], [-0.3826834324, -0.9238795325],
  [0, -1], [0.3826834324, -0.9238795325], [0.7071067812, -0.7071067812], [0.9238795325, -0.3826834324],
];

function hashDir(s: string): [number, number] {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return DIRS[(h >>> 0) % 16];
}

function dist(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}

const K = 230;
const COMP_GAP = 90;

/** Auto-arranged node centers for the logical view, keyed by ref. `physical` = auto physical centers. */
export function autoLogical(input: LayoutInput, physical: Map<string, Pt>): Map<string, Pt> {
  const specs = logicalSpecs(input);
  if (!specs.length) return new Map();
  const edges = logicalEdges(input, specs);
  const seed = seedPositions(specs, edges, physical);
  const groupOf = new Map<string, string>();
  const groups = new Map(input.groups.map((g) => [g.id, g] as [string, LGroup]));
  for (const d of input.devices) if (d.group && groups.has(d.group)) groupOf.set(d.id, d.group);
  if (!specs.some((sp) => sp.kind === 'device' && groupOf.has(sp.id))) return roundAll(arrange(specs, edges, seed));
  return roundAll(clustered(specs, edges, seed, groupOf, groups));
}

/**
 * The groups every one of the given chains (innermost first) passes through,
 * innermost first: where a node connected to those devices belongs. Empty
 * when there are no chains or one of them is ungrouped.
 */
export function commonChain(chains: string[][]): string[] {
  if (!chains.length) return [];
  return chains[0].filter((g) => chains.every((c) => c.indexOf(g) >= 0));
}

function roundAll(pos: Map<string, Pt>): Map<string, Pt> {
  const out = new Map<string, Pt>();
  pos.forEach((p, ref) => out.set(ref, { x: Math.round(p.x), y: Math.round(p.y) }));
  return out;
}

/** Seed positions: physical auto positions for devices; networks / hubs near their devices. */
function seedPositions(specs: LSpec[], edges: LEdge[], physical: Map<string, Pt>): Map<string, Pt> {
  const seed = new Map<string, Pt>();
  for (const s of specs) if (s.kind === 'device') seed.set(s.ref, physical.get(s.id) || { x: 0, y: 0 });
  const members = new Map<string, string[]>();
  for (const [a, b] of edges) {
    if (a.indexOf('device:') !== 0 && b.indexOf('device:') === 0) {
      if (!members.has(a)) members.set(a, []);
      (members.get(a) as string[]).push(b);
    }
  }
  for (const s of specs) {
    if (s.kind === 'device') continue;
    const ms = (members.get(s.ref) || []).slice().sort(cmp);
    let cx = 0;
    let cy = 0;
    for (const m of ms) {
      const p = seed.get(m) as Pt;
      cx += p.x;
      cy += p.y;
    }
    if (ms.length) {
      cx /= ms.length;
      cy /= ms.length;
    }
    const [dx, dy] = hashDir(s.id);
    const r = s.kind === 'network' ? 90 : 30;
    seed.set(s.ref, { x: cx + dx * r, y: cy + dy * r });
  }
  return seed;
}

/**
 * Lay out a set of nodes: split into connected components, lay out each,
 * pack the components in rows (largest first: by the number of nodes they
 * hold, a group counting with everything inside it). The top-left corner of
 * the packing is (0, 0).
 */
function arrange(specs: LSpec[], edges: LEdge[], seed: Map<string, Pt>, weight: (ref: string) => number = () => 1): Map<string, Pt> {
  const out = new Map<string, Pt>();
  const index = new Map(specs.map((s, i) => [s.ref, i] as [string, number]));
  const own = edges.filter(([a, b]) => index.has(a) && index.has(b));

  // --- connected components (union-find over edges), each sorted by ref
  const parent = specs.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const [a, b] of own) {
    const ra = find(index.get(a) as number);
    const rb = find(index.get(b) as number);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const groups = new Map<number, number[]>();
  specs.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    (groups.get(r) as number[]).push(i);
  });
  const size = (c: number[]): number => c.reduce((n, i) => n + weight(specs[i].ref), 0);
  const comps = Array.from(groups.values()).sort((a, b) => size(b) - size(a) || cmp(specs[a[0]].ref, specs[b[0]].ref));

  // --- lay out each component, then pack the components
  const placed: Array<{ refs: string[]; pos: Map<string, Pt>; x0: number; y0: number; w: number; h: number }> = [];
  for (const comp of comps) {
    const refs = comp.map((i) => specs[i].ref);
    const pos = layoutComponent(
      comp.map((i) => specs[i]),
      own.filter(([a]) => refs.indexOf(a) >= 0),
      seed,
    );
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of comp) {
      const s = specs[i];
      const p = pos.get(s.ref) as Pt;
      x0 = Math.min(x0, p.x - s.w / 2);
      y0 = Math.min(y0, p.y - s.h / 2);
      x1 = Math.max(x1, p.x + s.w / 2);
      y1 = Math.max(y1, p.y + s.h / 2);
    }
    placed.push({ refs, pos, x0, y0, w: x1 - x0, h: y1 - y0 });
  }
  const area = placed.reduce((s, c) => s + (c.w + COMP_GAP) * (c.h + COMP_GAP), 0);
  const maxW = Math.max(placed.reduce((m, c) => Math.max(m, c.w), 0), Math.sqrt(area) * 1.5);
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  for (const c of placed) {
    if (cx > 0 && cx + c.w > maxW) {
      cx = 0;
      cy += rowH + COMP_GAP;
      rowH = 0;
    }
    for (const ref of c.refs) {
      const p = c.pos.get(ref) as Pt;
      out.set(ref, { x: Math.round(p.x - c.x0 + cx), y: Math.round(p.y - c.y0 + cy) });
    }
    cx += c.w + COMP_GAP;
    rowH = Math.max(rowH, c.h);
  }
  return out;
}

/**
 * The layout with devices clustered by group. Each group is a box of the
 * size of its frame, laid out among its siblings; its content is placed
 * inside it. Edges between nodes of different containers are lifted to the
 * containers (the child of the current container that holds each end).
 */
function clustered(specs: LSpec[], edges: LEdge[], seed: Map<string, Pt>, groupOf: Map<string, string>, groups: Map<string, LGroup>): Map<string, Pt> {
  /** the chain of groups of a node, innermost first (networks and hubs: none) */
  const chain = (ref: string): string[] => {
    const out: string[] = [];
    if (ref.indexOf('device:') !== 0) return out;
    const seen = new Set<string>();
    let g = groupOf.get(ref.slice(7));
    while (g !== undefined && groups.has(g) && !seen.has(g)) {
      seen.add(g);
      out.push(g);
      const p = (groups.get(g) as LGroup).parent;
      g = p === null ? undefined : p;
    }
    return out;
  };
  const chains = new Map(specs.map((sp) => [sp.ref, chain(sp.ref)] as [string, string[]]));
  // a network or hub whose devices all lie in one group is local to it: it goes into the innermost group holding all of them
  const neighbours = new Map<string, string[]>();
  for (const [a, b] of edges) {
    if (a.indexOf('device:') !== 0 && b.indexOf('device:') === 0) {
      if (!neighbours.has(a)) neighbours.set(a, []);
      (neighbours.get(a) as string[]).push(b);
    }
  }
  for (const sp of specs) {
    if (sp.kind === 'device') continue;
    chains.set(sp.ref, commonChain((neighbours.get(sp.ref) || []).map((d) => chains.get(d) as string[])));
  }
  /** the item directly inside `container` (null = top level) that holds `ref`, or null if `ref` is not inside it */
  const itemIn = (ref: string, container: string | null): string | null => {
    const c = chains.get(ref) as string[];
    if (container === null) return c.length ? 'group:' + c[c.length - 1] : ref;
    const k = c.indexOf(container);
    if (k < 0) return null;
    return k === 0 ? ref : 'group:' + c[k - 1];
  };
  /** every group that contains a node of the view, and its direct children */
  const children = new Map<string | null, Set<string>>();
  const add = (container: string | null, item: string): void => {
    if (!children.has(container)) children.set(container, new Set());
    (children.get(container) as Set<string>).add(item);
  };
  for (const sp of specs) {
    const c = chains.get(sp.ref) as string[];
    add(c.length ? c[0] : null, sp.ref);
    for (let k = 0; k < c.length; k++) add(k + 1 < c.length ? c[k + 1] : null, 'group:' + c[k]);
  }
  const specOf = new Map(specs.map((sp) => [sp.ref, sp] as [string, LSpec]));
  /** absolute positions of everything inside a placed item, relative to the item's center */
  const inner = new Map<string, Map<string, Pt>>();
  const leaves = (item: string): string[] => {
    if (item.indexOf('group:') !== 0) return [item];
    return Array.from((inner.get(item) as Map<string, Pt>).keys());
  };

  const layoutContainer = (container: string | null): { items: LSpec[]; pos: Map<string, Pt> } => {
    // children first (deepest groups are laid out before their parent)
    const kids = Array.from(children.get(container) || []).sort(cmp);
    const items: LSpec[] = kids.map((ref) => {
      if (ref.indexOf('group:') !== 0) return specOf.get(ref) as LSpec;
      const box = layoutGroup(ref.slice(6));
      return { ref, kind: 'device', id: ref.slice(6), w: box.w, h: box.h };
    });
    // edges lifted to the items of this container; parallel ones merged
    const merged = new Map<string, LEdge>();
    for (const [a, b, w, rx, ry] of edges) {
      const ia = itemIn(a, container);
      const ib = itemIn(b, container);
      if (ia === null || ib === null || ia === ib) continue;
      const [p, q] = cmp(ia, ib) <= 0 ? [ia, ib] : [ib, ia];
      const key = p + '\u0000' + q;
      const e = merged.get(key);
      if (!e) merged.set(key, [p, q, w, rx, ry]);
      else merged.set(key, [p, q, Math.min(2, Math.max(e[2], w)), Math.max(e[3], rx), Math.max(e[4], ry)]);
    }
    const lifted = Array.from(merged.values()).sort((p, q) => cmp(p[0], q[0]) || cmp(p[1], q[1]));
    // a group is seeded at the mean seed of what it contains
    const sd = new Map<string, Pt>();
    for (const it of items) {
      if (it.ref.indexOf('group:') !== 0) {
        sd.set(it.ref, seed.get(it.ref) as Pt);
        continue;
      }
      const ls = leaves(it.ref);
      let x = 0;
      let y = 0;
      for (const l of ls) {
        const p = seed.get(l) as Pt;
        x += p.x;
        y += p.y;
      }
      sd.set(it.ref, { x: x / ls.length, y: y / ls.length });
    }
    return { items, pos: arrange(items, lifted, sd, (ref) => leaves(ref).length) };
  };

  /** lay out a group's content; returns the size of its frame */
  const sizes = new Map<string, { w: number; h: number }>();
  const layoutGroup = (gid: string): { w: number; h: number } => {
    const known = sizes.get(gid);
    if (known) return known;
    const { items, pos } = layoutContainer(gid);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const it of items) {
      const p = pos.get(it.ref) as Pt;
      x0 = Math.min(x0, p.x - it.w / 2);
      y0 = Math.min(y0, p.y - it.h / 2);
      x1 = Math.max(x1, p.x + it.w / 2);
      y1 = Math.max(y1, p.y + it.h / 2);
    }
    const g = groups.get(gid) as LGroup;
    // the same frame geometry as the drawn group (diagram/physical.ts groupRects)
    const uw = x1 - x0;
    const head = groupHeader(g.label, g.kind, uw);
    const w = Math.max(uw + 2 * GROUP_PAD, head.minW);
    const h = y1 - y0 + 2 * GROUP_PAD + head.h;
    // positions relative to the frame's center: content centred horizontally, below the title
    const ox = -(x0 + uw / 2);
    const oy = -h / 2 + head.h + GROUP_PAD - y0;
    const rel = new Map<string, Pt>();
    for (const it of items) {
      const p = pos.get(it.ref) as Pt;
      const c = { x: p.x + ox, y: p.y + oy };
      if (it.ref.indexOf('group:') === 0) (inner.get(it.ref) as Map<string, Pt>).forEach((q, ref) => rel.set(ref, { x: c.x + q.x, y: c.y + q.y }));
      else rel.set(it.ref, c);
    }
    inner.set('group:' + gid, rel);
    const size = { w, h };
    sizes.set(gid, size);
    return size;
  };

  const top = layoutContainer(null);
  const out = new Map<string, Pt>();
  for (const it of top.items) {
    const c = top.pos.get(it.ref) as Pt;
    if (it.ref.indexOf('group:') === 0) (inner.get(it.ref) as Map<string, Pt>).forEach((q, ref) => out.set(ref, { x: c.x + q.x, y: c.y + q.y }));
    else out.set(it.ref, c);
  }
  return out;
}

/** Force-directed layout of one connected component (nodes sorted by ref). */
function layoutComponent(list: LSpec[], edgesIn: LEdge[], seed: Map<string, Pt>): Map<string, Pt> {
  const N = list.length;
  const X = new Float64Array(N);
  const Y = new Float64Array(N);
  const R = new Float64Array(N);
  list.forEach((n, i) => {
    const p = seed.get(n.ref) as Pt;
    X[i] = p.x;
    Y[i] = p.y;
    R[i] = dist(n.w, n.h) / 2;
  });
  const out = new Map<string, Pt>();
  if (N === 1) {
    out.set(list[0].ref, { x: 0, y: 0 });
    return out;
  }
  const idx = new Map(list.map((n, i) => [n.ref, i] as [string, number]));
  const E = edgesIn.filter(([a, b]) => idx.has(a) && idx.has(b)).map(([a, b, w]) => [idx.get(a) as number, idx.get(b) as number, w] as [number, number, number]);
  // room needed between two connected nodes (index pair -> px), and the edge length that gives it
  const room = new Map<number, [number, number]>();
  const lengths: number[] = [];
  edgesIn
    .filter(([a, b]) => idx.has(a) && idx.has(b))
    .forEach(([a, b, , rx, ry]) => {
      const i = idx.get(a) as number;
      const j = idx.get(b) as number;
      room.set(Math.min(i, j) * N + Math.max(i, j), [rx, ry]);
      lengths.push(Math.max(MIN_EDGE, Math.min(rx, 190) + (list[i].w + list[j].w) / 4 + (list[i].h + list[j].h) / 4 + 30));
    });

  // normalize the seed to a size suited to the node count (keeps its shape)
  {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < N; i++) {
      x0 = Math.min(x0, X[i]);
      x1 = Math.max(x1, X[i]);
      y0 = Math.min(y0, Y[i]);
      y1 = Math.max(y1, Y[i]);
      sx += X[i];
      sy += Y[i];
    }
    const span = Math.max(x1 - x0, y1 - y0, 1);
    const s = (K * Math.sqrt(N) * 1.1) / span;
    const mx = sx / N;
    const my = sy / N;
    for (let i = 0; i < N; i++) {
      X[i] = (X[i] - mx) * s;
      Y[i] = (Y[i] - my) * s;
    }
  }
  if (N <= STRESS_MAX) {
    stressLayout(N, E, lengths, X, Y);
  } else {
    forceLayout(N, E, X, Y, R);
  }
  removeOverlaps(list, X, Y, room);
  // crossing reduction: swap node positions when that strictly reduces edge crossings
  if (N <= 60 && E.length >= 3) {
    reduceCrossings(list, E, X, Y);
    removeOverlaps(list, X, Y, room);
  }
  if (N <= 150) {
    // alternate: clearing an edge can create an overlap and vice versa
    for (let k = 0; k < 4; k++) {
      clearEdgesFromNodes(list, E, X, Y);
      removeOverlaps(list, X, Y, room);
    }
  }
  list.forEach((n, i) => out.set(n.ref, { x: X[i], y: Y[i] }));
  return out;
}

/**
 * Nodes that a straight edge passes through are pushed sideways, perpendicular
 * to the edge, until the edge (and its label) no longer covers them.
 * Deterministic: edges and nodes are visited in index order.
 */
function clearEdgesFromNodes(list: LSpec[], E: Array<[number, number, number]>, X: Float64Array, Y: Float64Array): void {
  const PAD = 16;
  for (let round = 0; round < 12; round++) {
    let moved = false;
    for (const [a, b] of E) {
      const dx = X[b] - X[a];
      const dy = Y[b] - Y[a];
      const len = dist(dx, dy);
      if (len < 1) continue;
      const nx = -dy / len;
      const ny = dx / len;
      for (let k = 0; k < list.length; k++) {
        if (k === a || k === b) continue;
        const hw = list[k].w / 2 + PAD;
        const hh = list[k].h / 2 + PAD;
        if (!segmentHitsBox(X[a], Y[a], X[b], Y[b], X[k], Y[k], hw, hh)) continue;
        const sd = (X[k] - X[a]) * nx + (Y[k] - Y[a]) * ny;
        const side = sd < 0 ? -1 : 1;
        const extent = Math.abs(nx) * hw + Math.abs(ny) * hh;
        const push = extent - Math.abs(sd) + 1;
        X[k] += side * nx * push;
        Y[k] += side * ny * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

const STRESS_MAX = 300;
/** shortest edge: two small boxes with a short label between them */
const MIN_EDGE = 300;

/**
 * Stress majorization (SMACOF, Gauss-Seidel updates): places nodes so that
 * their distances match graph distances (hops x L). Gives even, readable
 * layouts for dense cores (full meshes, rings) where force layouts fold.
 */
function stressLayout(N: number, E: Array<[number, number, number]>, lengths: number[], X: Float64Array, Y: Float64Array): void {
  // all-pairs shortest paths over the edge lengths (Floyd-Warshall; the component is connected)
  const FAR = 1e12;
  const D: Float64Array[] = [];
  for (let i = 0; i < N; i++) {
    const d = new Float64Array(N).fill(FAR);
    d[i] = 0;
    D.push(d);
  }
  E.forEach(([a, b], k) => {
    if (a === b) return;
    if (lengths[k] < D[a][b]) {
      D[a][b] = lengths[k];
      D[b][a] = lengths[k];
    }
  });
  for (let k = 0; k < N; k++) {
    const dk = D[k];
    for (let i = 0; i < N; i++) {
      const dik = D[i][k];
      if (dik >= FAR) continue;
      const di = D[i];
      for (let j = 0; j < N; j++) {
        const v = dik + dk[j];
        if (v < di[j]) di[j] = v;
      }
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (D[i][j] >= FAR) D[i][j] = N * MIN_EDGE;
  for (let it = 0; it < 250; it++) {
    let change = 0;
    for (let i = 0; i < N; i++) {
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const dij = D[i][j];
        const w = 1 / (dij * dij);
        let dx = X[i] - X[j];
        let dy = Y[i] - Y[j];
        let d = dist(dx, dy);
        if (d < 0.01) {
          dx = 0.01 * (1 + ((i * 7 + j * 13) % 5));
          dy = 0.01 * (1 + ((i * 11 + j * 3) % 7));
          d = dist(dx, dy);
        }
        sx += w * (X[j] + (dij * dx) / d);
        sy += w * (Y[j] + (dij * dy) / d);
        sw += w;
      }
      const nx = sx / sw;
      const ny = sy / sw;
      change += Math.abs(nx - X[i]) + Math.abs(ny - Y[i]);
      X[i] = nx;
      Y[i] = ny;
    }
    if (change / N < 0.05) break;
  }
}

/** Fruchterman-Reingold for large components. */
function forceLayout(N: number, E: Array<[number, number, number]>, X: Float64Array, Y: Float64Array, R: Float64Array): void {
  const iterations = Math.max(15, Math.min(300, Math.floor(4e7 / (N * N))));
  let temp = K * 1.5;
  const cool = temp / iterations;
  const DX = new Float64Array(N);
  const DY = new Float64Array(N);
  for (let it = 0; it < iterations; it++) {
    DX.fill(0);
    DY.fill(0);
    let gx = 0;
    let gy = 0;
    for (let i = 0; i < N; i++) {
      gx += X[i];
      gy += Y[i];
    }
    gx /= N;
    gy /= N;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let dx = X[i] - X[j];
        let dy = Y[i] - Y[j];
        let d = dist(dx, dy);
        if (d < 0.01) {
          dx = 0.01 * (1 + ((i * 7 + j * 13) % 5));
          dy = 0.01 * (1 + ((i * 11 + j * 3) % 7));
          d = dist(dx, dy);
        }
        const eff = Math.max(8, d - (R[i] + R[j]) * 0.45);
        const f = (K * K) / eff / d;
        DX[i] += dx * f;
        DY[i] += dy * f;
        DX[j] -= dx * f;
        DY[j] -= dy * f;
      }
    }
    for (const [a, b, w] of E) {
      const dx = X[a] - X[b];
      const dy = Y[a] - Y[b];
      const d = dist(dx, dy) || 0.01;
      const f = ((d * d) / K) * w / d;
      DX[a] -= dx * f;
      DY[a] -= dy * f;
      DX[b] += dx * f;
      DY[b] += dy * f;
    }
    for (let i = 0; i < N; i++) {
      DX[i] += (gx - X[i]) * 0.05;
      DY[i] += (gy - Y[i]) * 0.05;
      const d = dist(DX[i], DY[i]);
      if (d > 0) {
        const lim = Math.min(d, temp);
        X[i] += (DX[i] / d) * lim;
        Y[i] += (DY[i] / d) * lim;
      }
    }
    temp = Math.max(2, temp - cool);
  }
}

/**
 * Push boxes apart until each pair is separated by its margin: connected
 * nodes by the room their labels need, other devices by room for relation
 * bundles passing between them.
 */
function removeOverlaps(list: LSpec[], X: Float64Array, Y: Float64Array, room: Map<number, [number, number]>): void {
  const N = list.length;
  const margin = (i: number, j: number): [number, number] => {
    const base = list[i].kind === 'device' && list[j].kind === 'device' ? 150 : 40;
    const r = room.get(i * N + j);
    return r === undefined ? [base, base * 0.8] : [Math.max(base, r[0]), Math.max(base * 0.8, r[1])];
  };
  const passes = Math.max(4, Math.min(120, Math.floor(6e7 / (N * N))));
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const [mx, my] = margin(i, j);
        const ox = (list[i].w + list[j].w) / 2 + mx - Math.abs(X[i] - X[j]);
        const oy = (list[i].h + list[j].h) / 2 + my - Math.abs(Y[i] - Y[j]);
        if (ox > 0 && oy > 0) {
          moved = true;
          if (ox / (list[i].w + list[j].w) < oy / (list[i].h + list[j].h)) {
            const s = (X[i] < X[j] || (X[i] === X[j] && i < j) ? -1 : 1) * (ox / 2 + 0.5);
            X[i] += s;
            X[j] -= s;
          } else {
            const s = (Y[i] < Y[j] || (Y[i] === Y[j] && i < j) ? -1 : 1) * (oy / 2 + 0.5);
            Y[i] += s;
            Y[j] -= s;
          }
        }
      }
    }
    if (!moved) break;
  }
}

/** Does segment a->b pass through box `k` (inflated by `pad`)? Liang-Barsky clipping. */
function segmentHitsBox(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, hw: number, hh: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax - (cx - hw)) && clip(dx, cx + hw - ax) && clip(-dy, ay - (cy - hh)) && clip(dy, cy + hh - ay) && t0 <= t1;
}

/**
 * Layout cost: proper crossings between straight edges (edges sharing a node
 * are ignored), plus 3 for every edge that passes through another node's box
 * (its line and label would hide that node).
 */
function countCrossings(E: Array<[number, number, number]>, X: Float64Array, Y: Float64Array, list?: LSpec[]): number {
  const orient = (a: number, b: number, c: number): number => {
    const v = (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  };
  let n = 0;
  for (let i = 0; i < E.length; i++) {
    const [a, b] = E[i];
    for (let j = i + 1; j < E.length; j++) {
      const [c, d] = E[j];
      if (a === c || a === d || b === c || b === d) continue;
      if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) n++;
    }
  }
  if (list) {
    for (const [a, b] of E) {
      for (let k = 0; k < list.length; k++) {
        if (k === a || k === b) continue;
        if (segmentHitsBox(X[a], Y[a], X[b], Y[b], X[k], Y[k], list[k].w / 2 + 10, list[k].h / 2 + 10)) n += 3;
      }
    }
  }
  return n;
}

/**
 * Greedy, deterministic crossing reduction: for node pairs in index (= ref)
 * order, swap their positions if the total number of crossings strictly
 * decreases; repeat until a full round brings no improvement (max 6 rounds).
 */
function reduceCrossings(list: LSpec[], E: Array<[number, number, number]>, X: Float64Array, Y: Float64Array): void {
  const N = list.length;
  let best = countCrossings(E, X, Y, list);
  for (let round = 0; round < 6 && best > 0; round++) {
    let improved = false;
    for (let i = 0; i < N && best > 0; i++) {
      for (let j = i + 1; j < N && best > 0; j++) {
        let t = X[i];
        X[i] = X[j];
        X[j] = t;
        t = Y[i];
        Y[i] = Y[j];
        Y[j] = t;
        const c = countCrossings(E, X, Y, list);
        if (c < best) {
          best = c;
          improved = true;
        } else {
          t = X[i];
          X[i] = X[j];
          X[j] = t;
          t = Y[i];
          Y[i] = Y[j];
          Y[j] = t;
        }
      }
    }
    if (!improved) break;
  }
}

/** Logical layout (boxes) from node positions keyed by ref. */
export function logicalLayoutFrom(input: LayoutInput, positions: Map<string, Pt>): LogicalLayout {
  const nodes = new Map<string, LNode>();
  for (const s of logicalSpecs(input)) {
    const p = positions.get(s.ref) || { x: 0, y: 0 };
    nodes.set(s.ref, { ref: s.ref, kind: s.kind, id: s.id, cx: p.x, cy: p.y, w: s.w, h: s.h, bodyH: s.bodyH });
  }
  return { nodes };
}
