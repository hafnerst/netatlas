/**
 * Auto-arrange strategies. Each one is a pure, deterministic function of the
 * canonical layout input (layout/input.ts), so arranging twice moves nothing
 * the second time and the same model always gets the same positions.
 *
 *   default     the tiered / stress layout of layout/physical.ts and
 *               layout/logical.ts, unchanged, with the standard routing.
 *   compact     packed tight (see compact()): the default layout with the
 *               slack taken out, leaf rows folded and unconnected groups side
 *               by side, whichever is clearly smallest without more crossings
 *               or lines through boxes; never larger than Default (then it is
 *               Default).
 *   structured  rows and columns on a 10 px grid (see structured()), routed
 *               orthogonally: the arrangement stores 'orthogonal' as the
 *               view's routing (STRATEGY_ROUTING), and the views then draw
 *               every cable and relation with horizontal and vertical
 *               segments (layout/orthogonal.ts).
 *
 * Group frames are derived from their contents when drawing, so both
 * strategies place a group as one rigid block the size of its frame (with its
 * title), its contents arranged first: frames never overlap anything outside
 * them.
 *
 * Only + - * / and comparisons are used, and the results are rounded to
 * integers, as in the default layout.
 */
import { Pt, segmentHitsRect } from './geometry';
import { LayoutInput, cmp, physicalInput } from './input';
import { commonChain, logicalEdges, logicalSpecs } from './logical';
import { assignPorts, physicalBoxes, sideLabelWidth } from './physical';
import { LayoutView, autoPositions } from './positions';
import { GROUP_PAD, groupHeader, linkLabelBox } from './sizes';

export type ArrangeStrategy = 'default' | 'compact' | 'structured';
/** In this order: it is also the tie-breaker when two strategies give the same positions. */
export const STRATEGIES: ArrangeStrategy[] = ['default', 'compact', 'structured'];

export const STRATEGY_LABEL: { [s in ArrangeStrategy]: string } = {
  default: 'Default',
  compact: 'Compact',
  structured: 'Structured',
};

/** What each strategy is for, in a few words (the command palette; the buttons say more). */
export const STRATEGY_HINT: { [s in ArrangeStrategy]: string } = {
  default: 'balanced: tiers and groups by cabling, lines straight or around boxes',
  compact: 'packed tight: the smallest picture without overlaps',
  structured: 'rows and columns on a grid, lines at right angles only',
};

/** Words the command palette finds each strategy by. */
export const STRATEGY_KEYWORDS: { [s in ArrangeStrategy]: string } = {
  default: 'layout positions tidy balanced standard',
  compact: 'layout positions tidy small tight pack dense fit',
  structured: 'layout positions tidy grid aligned rows columns orthogonal right angle straight lines',
};

/** How a strategy routes the lines of the view it arranges: Structured with horizontal and vertical segments only. */
export const STRATEGY_ROUTING: { [s in ArrangeStrategy]: 'orthogonal' | undefined } = {
  default: undefined,
  compact: undefined,
  structured: 'orthogonal',
};

/** factor the compact strategy shrinks the default layout by before separating the nodes again */
const COMPACT_SHRINK = 0.55;


/** gaps the compact strategy keeps between two nodes (x, y), per view */
const COMPACT_GAP: { [v in LayoutView]: [number, number] } = { physical: [56, 72], logical: [64, 64] };
/** two items exactly the separation apart are apart (sums of fractions are not exact) */
const EPS = 0.5;



interface SNode {
  id: string;
  w: number;
  h: number;
  /** room the ports on its left / right side take beside it: their labels (physical view), their stubs and end labels (logical view) */
  left: number;
  right: number;
  /** the groups the node lies in, innermost first */
  chain: string[];
}

/** Positions of one view, arranged with a strategy. */
export function strategyPositions(view: LayoutView, input: LayoutInput, strategy: ArrangeStrategy): Map<string, Pt> {
  const base = autoPositions(view, input);
  if (strategy === 'default' || base.size === 0) return base;
  return withRoom(view, input, base, strategy === 'structured' ? structured : compact);
}

/** Positions for every strategy (keyed by strategy); the default is computed once. */
export function allStrategyPositions(view: LayoutView, input: LayoutInput): Map<ArrangeStrategy, Map<string, Pt>> {
  const base = autoPositions(view, input);
  const out = new Map<ArrangeStrategy, Map<string, Pt>>();
  out.set('default', base);
  out.set('compact', base.size ? withRoom(view, input, base, compact) : base);
  out.set('structured', base.size ? withRoom(view, input, base, structured) : base);
  return out;
}

/**
 * Arrange with a strategy, sized for what the result needs. A node's size
 * and the room its port labels take beside it depend on which sides its
 * ports are on, and that depends on where its neighbours end up: two
 * devices the default layout puts one above the other have their ports on
 * their top and bottom sides, side by side on their facing sides, with the
 * labels between them. So the strategy is run with the sizes and rooms of
 * the default layout, then again with those of its own result (each the
 * larger of the two), until they don't grow any more (at most five
 * times).
 */
function withRoom(view: LayoutView, input: LayoutInput, base: Map<string, Pt>, fn: (view: LayoutView, input: LayoutInput, base: Map<string, Pt>, nodes: SNode[]) => Map<string, Pt>): Map<string, Pt> {
  let nodes = viewSNodes(view, input, base).filter((n) => base.has(n.id));
  let pos = fn(view, input, base, nodes);
  for (let k = 0; k < 4; k++) {
    const at = new Map(viewSNodes(view, input, pos).map((n) => [n.id, n] as [string, SNode]));
    let grown = false;
    nodes = nodes.map((n) => {
      const a = at.get(n.id);
      if (!a || (a.w <= n.w && a.h <= n.h && a.left <= n.left && a.right <= n.right)) return n;
      grown = true;
      return { ...n, w: Math.max(n.w, a.w), h: Math.max(n.h, a.h), left: Math.max(n.left, a.left), right: Math.max(n.right, a.right) };
    });
    if (!grown) break;
    pos = fn(view, input, base, nodes);
  }
  // (should the sizes still not have settled and two boxes overlap, the result is not used: Compact is
  // then Default, Structured is run once more with room to spare)
  if (overlapping(view, input, pos)) {
    if (fn === compact) return base;
    pos = fn(view, input, base, nodes.map((n) => ({ ...n, w: n.w + 40, h: n.h + 24, left: n.left + 20, right: n.right + 20 })));
  }
  return pos;
}

/** Do two nodes of a view overlap (closer than 4 px) at these positions? */
function overlapping(view: LayoutView, input: LayoutInput, pos: Map<string, Pt>): boolean {
  const ns = viewSNodes(view, input, pos).filter((n) => pos.has(n.id));
  const bs = ns.map((n) => ({ p: pos.get(n.id) as Pt, w: n.w, h: n.h })).sort((a, b) => a.p.x - a.w / 2 - (b.p.x - b.w / 2));
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i];
      const b = bs[j];
      if (b.p.x - b.w / 2 >= a.p.x + a.w / 2 + 4) break;
      if (Math.abs(a.p.y - b.p.y) < (a.h + b.h) / 2 + 4) return true;
    }
  }
  return false;
}

/** The nodes of a view with their sizes (as drawn at the default positions) and group chains. */
function viewSNodes(view: LayoutView, input: LayoutInput, base: Map<string, Pt>): SNode[] {
  const groups = new Map(input.groups.map((g) => [g.id, g] as [string, (typeof input.groups)[number]]));
  const chainMemo = new Map<string, string[]>();
  const devChain = (id: string): string[] => {
    const known = chainMemo.get(id);
    if (known) return known;
    const out: string[] = [];
    const seen = new Set<string>();
    let g = input.devices.find((d) => d.id === id)?.group || null;
    while (g !== null && groups.has(g) && !seen.has(g)) {
      seen.add(g);
      out.push(g);
      g = (groups.get(g) as (typeof input.groups)[number]).parent;
    }
    chainMemo.set(id, out);
    return out;
  };
  if (view === 'physical') {
    // (guests are drawn inside their hosts)
    input = physicalInput(input);
    const boxes = physicalBoxes(input, base);
    // the labels of the ports on the left and right sides stand beside the box (sides as in the default
    // layout): two devices side by side keep room for the labels on their facing sides, as there
    const room = new Map<string, { left: number; right: number }>();
    for (const p of assignPorts(input.links, boxes)) {
      if (p.side !== 'left' && p.side !== 'right') continue;
      const r = room.get(p.device) || { left: 0, right: 0 };
      r[p.side] = Math.max(r[p.side], sideLabelWidth(p.iface, p.tag));
      room.set(p.device, r);
    }
    return input.devices.map((d) => {
      const b = boxes.get(d.id) as { w: number; h: number };
      const r = room.get(d.id) || { left: 0, right: 0 };
      return { id: d.id, w: b.w, h: b.h, left: r.left, right: r.right, chain: devChain(d.id) };
    });
  }
  const specs = logicalSpecs(input);
  const shownDevs = new Set(specs.filter((s) => s.kind === 'device').map((s) => s.id));
  return specs.map((s) => {
    let chain: string[] = [];
    if (s.kind === 'device') chain = devChain(s.id);
    else {
      // networks and hubs whose devices all lie in one group are drawn inside it (diagram/logical.ts)
      const devs = s.kind === 'network' ? (input.networks.find((n) => n.id === s.id)?.members || []) : (input.relations.find((r) => r.id === s.id)?.devices || []);
      const inner = commonChain(devs.filter((d) => shownDevs.has(d)).map(devChain));
      chain = inner;
    }
    // the stubs and end labels of a device's ports reach out beside it (layout/input.ts portReach)
    const reach = s.reach || 0;
    return { id: s.id, w: s.w, h: s.h, left: reach, right: reach, chain };
  });
}

/** The connections between the nodes of a view, by node id (cables; in the logical view relations and memberships), sorted. */
function viewNeighbours(view: LayoutView, input: LayoutInput, nodes: SNode[]): Map<string, string[]> {
  const nbrs = new Map<string, string[]>();
  for (const n of nodes) nbrs.set(n.id, []);
  const connect = (a: string, b: string): void => {
    if (a === b || !nbrs.has(a) || !nbrs.has(b)) return;
    (nbrs.get(a) as string[]).push(b);
    (nbrs.get(b) as string[]).push(a);
  };
  if (view === 'physical') for (const l of physicalInput(input).links) connect(l.a.device, l.b.device);
  else for (const [a, b] of logicalEdges(input, logicalSpecs(input))) connect(a.slice(a.indexOf(':') + 1), b.slice(b.indexOf(':') + 1));
  nbrs.forEach((v) => v.sort(cmp));
  return nbrs;
}

/** Do the straight lines a-b and c-d cross (properly)? */
function crosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const side = (p: Pt, q: Pt, r: Pt): number => {
    const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return v > 1e-6 ? 1 : v < -1e-6 ? -1 : 0;
  };
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/** One thing placed by the compact strategy inside a container: a node, or a whole group as a rigid block. */
interface Item {
  id: string;
  /** centre in the default layout (a block: the centre of its frame there) */
  base: Pt;
  /** top edge in the default layout */
  top: number;
  w: number;
  h: number;
  /** room for port labels beside it (see SNode) */
  left: number;
  right: number;
  /** a block: the positions of the nodes inside it, and its centre in those coordinates */
  inner?: Map<string, Pt>;
  at?: Pt;
}

/**
 * Compact: packed tight, container by container. The contents of each group
 * are packed first, and the group then takes part in its parent's packing
 * as one rigid block the size of its frame (with its title), so frames never
 * overlap anything outside them. Inside a container, several packings are
 * tried and the smallest one is kept, unless it crosses or stretches the
 * lines inside the container much more than the first:
 *
 *   - the default layout with the slack taken out: the items shrunk towards
 *     their common centre and separated again, first along x (in x order,
 *     each item pushed right of the earlier ones it stands beside in the
 *     default layout), then along y (in y order, each pushed below the
 *     earlier ones it overlaps horizontally). Rows stay rows, stacks stay
 *     stacks;
 *   - the rows of the default layout folded at a width: a long row (the
 *     leaf devices under a switch, say) continues on a second line;
 *   - shelves at a width: the items in the order of the default layout
 *     (row by row, left to right) filled into lines of that width, so that
 *     sibling groups and parts stand side by side instead of below each
 *     other.
 *
 * The widths tried follow from the items' area. Every packing keeps the same
 * gaps (with room for the port labels on the facing sides), so nothing
 * overlaps; fonts, labels and boxes are never made smaller.
 */
function compact(view: LayoutView, input: LayoutInput, base: Map<string, Pt>, nodes: SNode[]): Map<string, Pt> {
  const nbrs = viewNeighbours(view, input, nodes);
  const [gx, gy] = COMPACT_GAP[view];
  const groups = new Map(input.groups.map((g) => [g.id, g] as [string, (typeof input.groups)[number]]));
  // the groups that hold a node of this view, with their child groups and their own nodes
  const used = new Set<string>();
  for (const n of nodes) for (const g of n.chain) used.add(g);
  const parentOf = (g: string): string | null => {
    const p = groups.get(g)?.parent || null;
    return p !== null && used.has(p) ? p : null;
  };
  const childGroups = (c: string | null): string[] => Array.from(used).filter((g) => parentOf(g) === c).sort(cmp);
  const ownNodes = (c: string | null): SNode[] => nodes.filter((n) => (n.chain.length ? n.chain[0] : null) === c);
  /**
   * The frame of group `g` with its nodes at `pos`: centre and size, as
   * diagram groupRects draws it (its own nodes and the frames of its
   * sub-groups, padded, with its title above and at least as wide as that).
   */
  const frame = (g: string, pos: Map<string, Pt>): { c: Pt; w: number; h: number } => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const add = (cx: number, cy: number, w: number, h: number): void => {
      x0 = Math.min(x0, cx - w / 2);
      x1 = Math.max(x1, cx + w / 2);
      y0 = Math.min(y0, cy - h / 2);
      y1 = Math.max(y1, cy + h / 2);
    };
    for (const n of ownNodes(g)) {
      const p = pos.get(n.id);
      if (p) add(p.x, p.y, n.w, n.h);
    }
    for (const sub of childGroups(g)) {
      const f = frame(sub, pos);
      add(f.c.x, f.c.y, f.w, f.h);
    }
    const gr = groups.get(g) as (typeof input.groups)[number];
    const head = groupHeader(gr.label, gr.kind, x1 - x0, gr.extra);
    const w = Math.max(x1 - x0 + 2 * GROUP_PAD, head.minW);
    const h = y1 - y0 + 2 * GROUP_PAD + head.h;
    return { c: { x: (x0 + x1) / 2, y: y0 - GROUP_PAD - head.h + h / 2 }, w, h };
  };
  const deep = (g: string): Map<string, Pt> => {
    const out = new Map<string, Pt>();
    for (const n of nodes) if (n.chain.indexOf(g) >= 0) out.set(n.id, base.get(n.id) as Pt);
    return out;
  };
  /** the node positions of items at the given centres */
  const nodeSpots = (items: Item[], at: Map<Item, Pt>): Map<string, Pt> => {
    const out = new Map<string, Pt>();
    for (const it of items) {
      const p = at.get(it) as Pt;
      if (it.inner && it.at) {
        const dx = p.x - it.at.x;
        const dy = p.y - it.at.y;
        it.inner.forEach((q, id) => out.set(id, { x: q.x + dx, y: q.y + dy }));
      } else out.set(it.id, p);
    }
    return out;
  };
  /** what a packing is like: its area (outer extent of the items), and the crossings and length of the lines inside it */
  const measure = (items: Item[], at: Map<Item, Pt>): { area: number; w: number; h: number; crossings: number; length: number } => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const it of items) {
      const p = at.get(it) as Pt;
      x0 = Math.min(x0, p.x - it.w / 2 - it.left);
      x1 = Math.max(x1, p.x + it.w / 2 + it.right);
      y0 = Math.min(y0, p.y - it.h / 2);
      y1 = Math.max(y1, p.y + it.h / 2);
    }
    const spots = nodeSpots(items, at);
    const segs: Array<[Pt, Pt]> = [];
    let length = 0;
    spots.forEach((p, id) => {
      for (const o of nbrs.get(id) || []) {
        if (cmp(id, o) >= 0) continue;
        const q = spots.get(o);
        if (!q) continue;
        segs.push([p, q]);
        length += Math.sqrt((q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y));
      }
    });
    let crossings = 0;
    if (segs.length <= 400) {
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (crosses(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) crossings++;
    }
    return { area: (x1 - x0) * (y1 - y0), w: x1 - x0, h: y1 - y0, crossings, length };
  };
  /**
   * Lines of items, each at most `width` wide, `gx`/`gy` apart (with room for the port labels on facing
   * sides): devices of a line on one centre line, groups by their tops; lines centred under each other.
   */
  const shelves = (lines: Item[][]): Map<Item, Pt> => {
    const at = new Map<Item, Pt>();
    const sep = (a: Item, b: Item): number => (a.w + b.w) / 2 + Math.max(gx, a.right + b.left + 8);
    const widths = lines.map((l) => l.reduce((s, it, i) => s + (i ? sep(l[i - 1], it) - (l[i - 1].w + it.w) / 2 : 0) + it.w, 0));
    const full = widths.reduce((m, w) => Math.max(m, w), 0);
    let y = 0;
    lines.forEach((l, k) => {
      const nodeH = l.reduce((m, it) => Math.max(m, it.inner ? 0 : it.h), 0);
      let x = (full - widths[k]) / 2;
      let bottom = y;
      l.forEach((it, i) => {
        if (i) x += sep(l[i - 1], it) - (l[i - 1].w + it.w) / 2;
        const top = it.inner ? y : y + (nodeH - it.h) / 2;
        at.set(it, { x: x + it.w / 2, y: top + it.h / 2 });
        bottom = Math.max(bottom, top + it.h);
        x += it.w;
      });
      y = bottom + gy;
    });
    return at;
  };
  /** the default layout's rows of items: extents overlapping by half the smaller height, left to right */
  const defaultRows = (items: Item[]): Item[][] => {
    const byY = items.slice().sort((a, b) => a.top + a.h / 2 - (b.top + b.h / 2) || a.base.x - b.base.x || cmp(a.id, b.id));
    const rows: Item[][] = [];
    let first: Item | null = null;
    for (const it of byY) {
      const overlap = first ? Math.min(first.top + first.h, it.top + it.h) - Math.max(first.top, it.top) : -1;
      if (first && overlap >= Math.min(first.h, it.h) / 2) rows[rows.length - 1].push(it);
      else {
        rows.push([it]);
        first = it;
      }
    }
    for (const r of rows) r.sort((a, b) => a.base.x - b.base.x || cmp(a.id, b.id));
    return rows;
  };
  /** the nodes of an item */
  const nodeIds = (it: Item): string[] => (it.inner ? Array.from(it.inner.keys()) : [it.id]);
  /** are two items connected (a line between a node of one and a node of the other)? */
  const linked = (a: Item, b: Item): boolean => {
    const bs = new Set(nodeIds(b));
    return nodeIds(a).some((id) => (nbrs.get(id) || []).some((o) => bs.has(o)));
  };
  /**
   * Cut a sequence of items into lines at most `width` wide. With `keep`
   * (the default layout's rows), an item may only join a line that holds
   * items of an earlier row when it is connected to none of them: a device
   * or group never comes to stand beside what it is cabled to above it (the
   * tiers stay), while unconnected parts and groups are packed side by
   * side. A row is only cut in two where `split` allows it.
   */
  const fill = (seq: Item[], width: number, keep?: Map<Item, number>, split: (row: number) => boolean = () => true): Item[][] => {
    const sep = (a: Item, b: Item): number => (a.w + b.w) / 2 + Math.max(gx, a.right + b.left + 8);
    const out: Item[][] = [];
    let cur: Item[] = [];
    let w = 0;
    for (const it of seq) {
      const next = cur.length ? w + sep(cur[cur.length - 1], it) - (cur[cur.length - 1].w + it.w) / 2 + it.w : it.w;
      const apart = !keep || cur.every((o) => keep.get(o) === keep.get(it) || !linked(o, it));
      // (a row of the default layout is only cut in two where it may be folded)
      const prev = cur.length ? cur[cur.length - 1] : null;
      const sameRow = !!keep && !!prev && keep.get(prev) === keep.get(it);
      if (cur.length && ((next > width && (!sameRow || split(keep ? (keep.get(it) as number) : 0))) || !apart)) {
        out.push(cur);
        cur = [it];
        w = it.w;
      } else {
        cur.push(it);
        w = next;
      }
    }
    if (cur.length) out.push(cur);
    return out;
  };
  /**
   * The packing of a container's items that is kept: the smallest of the shrunk default layout, its rows
   * folded at a few widths, and shelves at those widths; a packing pays for every crossing of the lines
   * inside the container it adds (a crossing costs a fifth of the area), for lines much longer than in the
   * shrunk layout, and for a shape far from a screen's.
   */
  const bestPacking = (items: Item[], shrunk: Map<Item, Pt>): Map<Item, Pt> => {
    const first = measure(items, shrunk);
    const rows = defaultRows(items);
    const order: Item[] = [];
    const rowOf = new Map<Item, number>();
    rows.forEach((r, i) => {
      order.push(...r);
      r.forEach((it) => rowOf.set(it, i));
    });
    const total = items.reduce((s, it) => s + (it.w + gx) * (it.h + gy), 0);
    const widest = items.reduce((m, it) => Math.max(m, it.w), 0);
    const widths = [1, 1.6, 2.4, 3.4].map((r) => Math.max(widest, Math.sqrt(total * r)));
    const candidates: Array<Map<Item, Pt>> = [shrunk];
    // only a row with nothing below it cabled to it is folded (the leaf devices under a switch): a row
    // with lines going down would send them across its own second line
    const leafRow = (i: number): boolean => rows[i].every((it) => order.every((o) => (rowOf.get(o) as number) <= i || !linked(it, o)));
    for (const w of widths) {
      const folded: Item[][] = [];
      rows.forEach((r, i) => folded.push(...(leafRow(i) ? fill(r, w) : [r])));
      candidates.push(shelves(folded));
      candidates.push(shelves(fill(order, w, rowOf, leafRow)));
    }
    const score = (m: { area: number; w: number; h: number; crossings: number; length: number }): number => {
      const ratio = m.w / Math.max(1, m.h);
      const shape = ratio < 0.6 ? 0.6 / ratio : ratio > 3 ? ratio / 3 : 1;
      const longer = first.length > 0 ? 2 * Math.max(0, m.length / first.length - 1.1) : 0;
      return m.area * (1 + 0.2 * Math.max(0, m.crossings - first.crossings)) * (1 + longer) * shape;
    };
    let best = shrunk;
    let bestScore = score(first);
    candidates.forEach((cand, i) => {
      if (!i) return;
      const sc = score(measure(items, cand));
      // a packing only replaces the shrunk default layout when it is clearly smaller
      if (sc < bestScore * 0.95 - 0.5) {
        bestScore = sc;
        best = cand;
      }
    });
    return best;
  };
  const place = (c: string | null): Map<string, Pt> => {
    const items: Item[] = [];
    for (const g of childGroups(c)) {
      const inner = place(g);
      const now = frame(g, inner);
      const was = frame(g, deep(g));
      // a frame keeps a little air around it, like the room between two nodes
      // (the ports of the nodes inside reach beyond the frame as far as its padding doesn't hold them)
      const within = nodes.filter((n) => n.chain.indexOf(g) >= 0);
      const left = Math.max(0, within.reduce((m, n) => Math.max(m, n.left), 0) - GROUP_PAD);
      const right = Math.max(0, within.reduce((m, n) => Math.max(m, n.right), 0) - GROUP_PAD);
      items.push({ id: 'group:' + g, base: was.c, top: was.c.y - was.h / 2, w: now.w + 12, h: now.h + 12, left, right, inner, at: now.c });
    }
    for (const n of ownNodes(c)) {
      const p = base.get(n.id) as Pt;
      items.push({ id: n.id, base: p, top: p.y - n.h / 2, w: n.w, h: n.h, left: n.left, right: n.right });
    }
    const out = new Map<string, Pt>();
    if (!items.length) return out;
    let cx0 = Infinity;
    let cy0 = Infinity;
    let cx1 = -Infinity;
    let cy1 = -Infinity;
    for (const it of items) {
      cx0 = Math.min(cx0, it.base.x);
      cx1 = Math.max(cx1, it.base.x);
      cy0 = Math.min(cy0, it.top);
      cy1 = Math.max(cy1, it.top);
    }
    const mid = { x: (cx0 + cx1) / 2, y: (cy0 + cy1) / 2 };
    const X = new Map<Item, number>();
    const Y = new Map<Item, number>();
    // shrunk towards the middle by centre along x, but by top edge along y: the default layout lines up
    // the tops of a row (blocks of different heights), and so does the compact one
    for (const it of items) {
      X.set(it, mid.x + (it.base.x - mid.x) * COMPACT_SHRINK);
      Y.set(it, mid.y + (it.top - mid.y) * COMPACT_SHRINK + it.h / 2);
    }
    // side by side, the gap holds at least the port labels on the two facing sides
    const sepX = (a: Item, b: Item): number => {
      const [l, r] = a.base.x < b.base.x || (a.base.x === b.base.x && cmp(a.id, b.id) < 0) ? [a, b] : [b, a];
      return (a.w + b.w) / 2 + Math.max(gx, l.right + r.left + 8);
    };
    const sepY = (a: Item, b: Item): number => (a.h + b.h) / 2 + gy;
    const byX = items.slice().sort((a, b) => (X.get(a) as number) - (X.get(b) as number) || cmp(a.id, b.id));
    for (let i = 0; i < byX.length; i++) {
      const a = byX[i];
      let x = X.get(a) as number;
      for (let j = 0; j < i; j++) {
        const b = byX[j];
        // items one above the other in the default layout are kept apart by the y pass
        if (Math.abs(a.base.y - b.base.y) >= sepY(a, b) - EPS) continue;
        x = Math.max(x, (X.get(b) as number) + sepX(a, b));
      }
      X.set(a, x);
    }
    const byY = items.slice().sort((a, b) => (Y.get(a) as number) - (Y.get(b) as number) || cmp(a.id, b.id));
    for (let i = 0; i < byY.length; i++) {
      const a = byY[i];
      let y = Y.get(a) as number;
      for (let j = 0; j < i; j++) {
        const b = byY[j];
        if (Math.abs((X.get(a) as number) - (X.get(b) as number)) >= sepX(a, b) - EPS) continue;
        y = Math.max(y, (Y.get(b) as number) + sepY(a, b));
      }
      Y.set(a, y);
    }
    // ---- other packings: the default rows folded, and shelves; the smallest that keeps the lines readable
    const shrunk = new Map(items.map((it) => [it, { x: X.get(it) as number, y: Y.get(it) as number }] as [Item, Pt]));
    const chosen = repack && items.length > 1 ? bestPacking(items, shrunk) : shrunk;
    for (const it of items) {
      const { x, y } = chosen.get(it) as Pt;
      if (it.inner && it.at) {
        const dx = x - it.at.x;
        const dy = y - it.at.y;
        it.inner.forEach((p, id) => out.set(id, { x: p.x + dx, y: p.y + dy }));
      } else out.set(it.id, { x, y });
    }
    return out;
  };
  /** the extent of a whole layout: every node with the room of its port labels, and the frames of the top-level groups */
  const extent = (pos: Map<string, Pt>): number => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const add = (cx: number, cy: number, w: number, h: number, l = 0, r = 0): void => {
      x0 = Math.min(x0, cx - w / 2 - l);
      x1 = Math.max(x1, cx + w / 2 + r);
      y0 = Math.min(y0, cy - h / 2);
      y1 = Math.max(y1, cy + h / 2);
    };
    // (with the margins the drawing keeps around boxes and frames, diagram/physical.ts bounds)
    for (const n of nodes) {
      const p = pos.get(n.id);
      if (p) add(p.x, p.y, n.w + 100, n.h + 80, n.left, n.right);
    }
    for (const g of childGroups(null)) {
      const f = frame(g, pos);
      add(f.c.x, f.c.y, f.w + 40, f.h + 40);
    }
    // a cable's label stands beside its middle (physical view)
    if (view === 'physical') {
      const links = new Map(physicalInput(input).links.map((l) => [l.id, l] as [string, (typeof input.links)[number]]));
      for (const lab of input.linkLabels) {
        const l = links.get(lab.id);
        const p = l && pos.get(l.a.device);
        const q = l && pos.get(l.b.device);
        if (!p || !q) continue;
        const box = linkLabelBox(lab.text, lab.extra);
        // (it moves sideways off the line when it has to: up to its width and a little more on either side)
        add((p.x + q.x) / 2, (p.y + q.y) / 2, 2 * box.w + 160, box.h + 24);
      }
    }
    return x1 > x0 ? (x1 - x0) * (y1 - y0) : 0;
  };
  const finish = (placed: Map<string, Pt>): Map<string, Pt> => {
    const out = new Map<string, Pt>();
    // in the input's order, so the map compares and prints like the default result
    base.forEach((p, id) => {
      const q = placed.get(id);
      out.set(id, q ? { x: Math.round(q.x), y: Math.round(q.y) } : p);
    });
    return out;
  };
  // Each container keeps its smallest packing, but a group packed wide can make its parent larger: of the
  // packed layout and the layout with only the slack taken out, the smaller one is kept, and where neither
  // is clearly smaller than Default (a chain of a few devices, say), Compact is Default.
  let repack = true;
  const packed = finish(place(null));
  repack = false;
  const plain = finish(place(null));
  // (the extents are estimates of the drawing: Compact has to be clearly smaller than Default to be used)
  // and in the logical view it never leads more lines straight through a third box than Default does: they
  // would have to bend around it in little room (a cable of the physical view goes around boxes anyway)
  const blocked = (pos: Map<string, Pt>): number => {
    if (view === 'physical') return 0;
    let n = 0;
    const boxes = nodes.filter((x) => pos.has(x.id)).map((x) => ({ id: x.id, p: pos.get(x.id) as Pt, w: x.w, h: x.h }));
    pos.forEach((p, id) => {
      for (const o of nbrs.get(id) || []) {
        if (cmp(id, o) >= 0) continue;
        const q = pos.get(o);
        if (!q) continue;
        for (const b of boxes) {
          if (b.id === id || b.id === o) continue;
          const r = { x: b.p.x - b.w / 2, y: b.p.y - b.h / 2, w: b.w, h: b.h };
          if (r.x > Math.max(p.x, q.x) || r.x + r.w < Math.min(p.x, q.x) || r.y > Math.max(p.y, q.y) || r.y + r.h < Math.min(p.y, q.y)) continue;
          if (segmentHitsRect(p, q, r)) n++;
        }
      }
    });
    return n;
  };
  const lines = nodes.reduce((sum, n) => sum + (nbrs.get(n.id) || []).filter((o) => cmp(n.id, o) < 0).length, 0);
  const most = blocked(finish(base)) + Math.floor(lines / 4);
  const sizes = [extent(packed), extent(plain), extent(base) * 0.94];
  const bp = blocked(packed);
  const bq = blocked(plain);
  // of the two, the one with fewer such lines, else the smaller
  const first = bp < bq || (bp === bq && sizes[0] <= sizes[1]) ? 0 : 1;
  for (const k of [first, 1 - first]) {
    if ((k === 0 ? bp : bq) <= most && sizes[k] < sizes[2]) return k === 0 ? packed : plain;
  }
  return finish(base);
}

/** Structured: the grid the positions are on, and the gaps it keeps (x, y), per view */
const GRID = 10;
const STRUCT_GAP: { [v in LayoutView]: [number, number] } = { physical: [64, 96], logical: [72, 88] };
/** a row wider than this continues on the next row (or as wide as its widest item) */
const STRUCT_ROW_W = 1500;
/** room per line that has to bend between two rows (its horizontal lane), beyond the first few */
const LANE = 8;

/** Up to the grid. */
function ceilGrid(v: number): number {
  return Math.ceil(v / GRID - 1e-9) * GRID;
}

function roundGrid(v: number): number {
  return Math.round(v / GRID) * GRID;
}

/** One thing placed by the structured strategy inside a container: a node, or a whole group as a rigid block. */
interface SItem {
  id: string;
  /** its nodes (one for a node; every node inside for a block) */
  nodes: string[];
  /** in the default layout: centre x, top */
  bx: number;
  btop: number;
  w: number;
  h: number;
  left: number;
  right: number;
  /** where it is in the layout its rows come from (the physical default layout): centre x, top, height; none for a network or hub */
  kx: number;
  ktop: number;
  kh: number;
  keyed: boolean;
  block: boolean;
  /** a block: the positions of the nodes inside it, and its frame's centre in those coordinates */
  inner?: Map<string, Pt>;
  at?: Pt;
  /** where it is placed: centre x, top */
  x: number;
  top: number;
}

/**
 * Structured: rows and columns. Inside every group (and at the top level),
 * its devices and its sub-groups are put in the rows of the physical view's
 * default layout (tiers, routers above switches above endpoints, and the
 * layers of cabled groups) in both views, so a device stands in the same
 * place in both; in the logical view each network and multipoint hub gets a
 * row of its own right under the highest row it connects to. A row keeps the
 * order of the default layout; a row
 * that is too wide continues on the next one. Then every item is moved
 * along its row toward the items it is connected to in the rows above and
 * below (from the top, from the bottom, and from the top again), as far as
 * its neighbours in the row allow, so that connected things stand in one
 * column and their lines run straight. Positions are on a 10 px grid, rows
 * are evenly spaced, and between two rows there is room for a lane per line
 * that has to bend there. Groups are placed as rigid blocks with their
 * frames (their insides arranged first), so frames never overlap anything
 * outside them.
 */
function structured(view: LayoutView, input: LayoutInput, base: Map<string, Pt>, nodes: SNode[]): Map<string, Pt> {
  const [gx, gy] = STRUCT_GAP[view];
  const groups = new Map(input.groups.map((g) => [g.id, g] as [string, (typeof input.groups)[number]]));
  const nbrs = viewNeighbours(view, input, nodes);
  // The logical view takes its rows from the physical view's default layout (tiers, and the layers of cabled
  // groups), so that Structured puts things in the same places in both views: a device where it is in the
  // physical view (a guest where its host is), a group where its frame is there.
  const phys = view === 'logical' ? autoPositions('physical', input) : base;
  const physSize = new Map<string, { w: number; h: number }>();
  if (view === 'logical') for (const n of viewSNodes('physical', input, phys)) physSize.set(n.id, { w: n.w, h: n.h });
  const insideOf = new Map(input.devices.map((d) => [d.id, d.inside] as [string, string | undefined]));
  /** the physical box a logical device stands for: its own, or its (outermost) host's */
  const physBox = (id: string): { x: number; y: number; w: number; h: number } | undefined => {
    let d = id;
    for (let k = 0; k < 8 && insideOf.get(d) !== undefined; k++) d = insideOf.get(d) as string;
    const p = phys.get(d);
    const z = physSize.get(d);
    return p && z ? { x: p.x, y: p.y, w: z.w, h: z.h } : undefined;
  };
  const used = new Set<string>();
  for (const n of nodes) for (const g of n.chain) used.add(g);
  const parentOf = (g: string): string | null => {
    const p = groups.get(g)?.parent || null;
    return p !== null && used.has(p) ? p : null;
  };
  const childGroups = (c: string | null): string[] => Array.from(used).filter((g) => parentOf(g) === c).sort(cmp);
  const ownNodes = (c: string | null): SNode[] => nodes.filter((n) => (n.chain.length ? n.chain[0] : null) === c);
  /** the frame of group `g` with its nodes at `pos` (as diagram groupRects draws it) */
  const frame = (g: string, pos: Map<string, Pt>): { c: Pt; w: number; h: number } => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const add = (cx: number, cy: number, w: number, h: number): void => {
      x0 = Math.min(x0, cx - w / 2);
      x1 = Math.max(x1, cx + w / 2);
      y0 = Math.min(y0, cy - h / 2);
      y1 = Math.max(y1, cy + h / 2);
    };
    for (const n of ownNodes(g)) {
      const p = pos.get(n.id);
      if (p) add(p.x, p.y, n.w, n.h);
    }
    for (const sub of childGroups(g)) {
      const f = frame(sub, pos);
      add(f.c.x, f.c.y, f.w, f.h);
    }
    const gr = groups.get(g) as (typeof input.groups)[number];
    const head = groupHeader(gr.label, gr.kind, x1 - x0, gr.extra);
    const w = Math.max(x1 - x0 + 2 * GROUP_PAD, head.minW);
    const h = y1 - y0 + 2 * GROUP_PAD + head.h;
    return { c: { x: (x0 + x1) / 2, y: y0 - GROUP_PAD - head.h + h / 2 }, w, h };
  };
  const deep = (g: string): Map<string, Pt> => {
    const out = new Map<string, Pt>();
    for (const n of nodes) if (n.chain.indexOf(g) >= 0) out.set(n.id, base.get(n.id) as Pt);
    return out;
  };

  const place = (c: string | null): Map<string, Pt> => {
    const items: SItem[] = [];
    for (const g of childGroups(c)) {
      const inner = place(g);
      const now = frame(g, inner);
      const was = frame(g, deep(g));
      // (the ports of the nodes inside reach beyond the frame as far as its padding doesn't hold them)
      const within = nodes.filter((n) => n.chain.indexOf(g) >= 0);
      const left = Math.max(0, within.reduce((m, n) => Math.max(m, n.left), 0) - GROUP_PAD);
      const right = Math.max(0, within.reduce((m, n) => Math.max(m, n.right), 0) - GROUP_PAD);
      const ids = within.map((n) => n.id).sort(cmp);
      // (logical view: the group's frame around its devices' places in the physical layout)
      let key = { x: was.c.x, top: was.c.y - was.h / 2, h: was.h, ok: true };
      if (view === 'logical') {
        const bs = ids.map(physBox).filter((b): b is { x: number; y: number; w: number; h: number } => !!b);
        key = bs.length
          ? {
              x: (bs.reduce((m, b) => Math.min(m, b.x - b.w / 2), Infinity) + bs.reduce((m, b) => Math.max(m, b.x + b.w / 2), -Infinity)) / 2,
              top: bs.reduce((m, b) => Math.min(m, b.y - b.h / 2), Infinity),
              h: bs.reduce((m, b) => Math.max(m, b.y + b.h / 2), -Infinity) - bs.reduce((m, b) => Math.min(m, b.y - b.h / 2), Infinity),
              ok: true,
            }
          : { x: was.c.x, top: 0, h: 0, ok: false };
      }
      // a frame keeps a little air around it (6 px each side)
      items.push({ id: 'group:' + g, nodes: ids, bx: was.c.x, btop: was.c.y - was.h / 2, w: now.w + 12, h: now.h + 12, left, right, kx: key.x, ktop: key.top, kh: key.h, keyed: key.ok, block: true, inner, at: now.c, x: 0, top: 0 });
    }
    for (const n of ownNodes(c)) {
      const p = base.get(n.id) as Pt;
      const b = view === 'logical' ? physBox(n.id) : { x: p.x, y: p.y, w: n.w, h: n.h };
      items.push({ id: n.id, nodes: [n.id], bx: p.x, btop: p.y - n.h / 2, w: n.w, h: n.h, left: n.left, right: n.right, kx: b ? b.x : p.x, ktop: b ? b.y - b.h / 2 : 0, kh: b ? b.h : 0, keyed: !!b, block: false, x: 0, top: 0 });
    }
    const out = new Map<string, Pt>();
    if (!items.length) return out;
    // ---- rows: those of the physical default layout (items whose extents there overlap by half the smaller height)
    let rows: SItem[][] = [];
    const byY = items.filter((it) => it.keyed).sort((a, b) => a.ktop + a.kh / 2 - (b.ktop + b.kh / 2) || a.kx - b.kx || cmp(a.id, b.id));
    let first: SItem | null = null;
    for (const it of byY) {
      const overlap = first ? Math.min(first.ktop + first.kh, it.ktop + it.kh) - Math.max(first.ktop, it.ktop) : -1;
      if (first && overlap >= Math.min(first.kh, it.kh) / 2) rows[rows.length - 1].push(it);
      else {
        rows.push([it]);
        first = it;
      }
    }
    // logical view: a network or multipoint hub in a row of its own right under the highest row it connects to
    // (in the order of the logical default layout); one connected to nothing here below everything
    const loose = items.filter((it) => !it.keyed);
    if (loose.length) {
      const rowIndex = new Map<string, number>();
      rows.forEach((r, i) => r.forEach((it) => it.nodes.forEach((id) => rowIndex.set(id, i))));
      const under = new Map<number, SItem[]>();
      for (const it of loose) {
        const at = it.nodes.reduce((m, id) => (nbrs.get(id) || []).reduce((k, o) => (rowIndex.has(o) ? Math.min(k, rowIndex.get(o) as number) : k), m), rows.length);
        if (!under.has(at)) under.set(at, []);
        (under.get(at) as SItem[]).push(it);
      }
      const merged: SItem[][] = [];
      for (let i = 0; i <= rows.length; i++) {
        if (i < rows.length) merged.push(rows[i]);
        const extra = under.get(i);
        if (extra) merged.push(extra);
      }
      rows = merged;
    }
    for (const r of rows) r.sort((a, b) => a.kx - b.kx || a.bx - b.bx || cmp(a.id, b.id));
    // side by side, the gap holds at least the port labels on the two facing sides (and a lane for vertical lines)
    const sepX = (a: SItem, b: SItem): number => ceilGrid((a.w + b.w) / 2 + Math.max(gx, a.right + b.left + 8));
    // a row too wide continues on the next one (a row of the physical default layout may be at least as wide
    // as it was there: the default layout already continued it where it was too wide)
    const wrapped: SItem[][] = [];
    for (const r of rows) {
      const wasW = r.every((it) => it.keyed) ? r.reduce((m, it) => Math.max(m, it.kx + it.w / 2), -Infinity) - r.reduce((m, it) => Math.min(m, it.kx - it.w / 2), Infinity) : 0;
      const limit = Math.max(STRUCT_ROW_W, wasW * 1.25, r.reduce((m, it) => Math.max(m, it.w), 0));
      let cur: SItem[] = [];
      let w = 0;
      for (const it of r) {
        const next = cur.length ? w + sepX(cur[cur.length - 1], it) - (cur[cur.length - 1].w + it.w) / 2 + it.w : it.w;
        if (cur.length && next > limit) {
          wrapped.push(cur);
          cur = [it];
          w = it.w;
        } else {
          cur.push(it);
          w = next;
        }
      }
      if (cur.length) wrapped.push(cur);
    }
    rows = wrapped;
    // ---- columns: packed first, then toward the connected items of the other rows
    const itemOf = new Map<string, SItem>();
    for (const it of items) for (const id of it.nodes) itemOf.set(id, it);
    const rowOf = new Map<SItem, number>();
    rows.forEach((r, i) => r.forEach((it) => rowOf.set(it, i)));
    /** the items of other rows an item is connected to (once per connection) */
    const links = new Map<SItem, SItem[]>();
    for (const it of items) {
      const l: SItem[] = [];
      for (const id of it.nodes) {
        for (const o of nbrs.get(id) as string[]) {
          const t = itemOf.get(o);
          if (t && t !== it && rowOf.get(t) !== rowOf.get(it)) l.push(t);
        }
      }
      links.set(it, l);
    }
    /** centres along a row as near to `want` as the order and the gaps allow, on the grid */
    const packRow = (r: SItem[], want: number[]): void => {
      const n = r.length;
      const sep = (i: number): number => sepX(r[i], r[i + 1]);
      const f = want.slice();
      for (let i = 1; i < n; i++) f[i] = Math.max(f[i], f[i - 1] + sep(i - 1));
      const g = want.slice();
      for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] - sep(i));
      const at = f.map((v, i) => roundGrid((v + g[i]) / 2));
      for (let i = 1; i < n; i++) at[i] = Math.max(at[i], at[i - 1] + sep(i - 1));
      r.forEach((it, i) => (it.x = at[i]));
    };
    for (const r of rows) {
      const want: number[] = [];
      let x = 0;
      r.forEach((it, i) => {
        if (i) x += sepX(r[i - 1], it);
        want.push(x);
      });
      const shift = roundGrid(-x / 2);
      packRow(r, want.map((v) => v + shift));
    }
    const pull = (it: SItem, from: (o: SItem) => boolean): number | undefined => {
      const l = (links.get(it) as SItem[]).filter(from);
      if (!l.length) return undefined;
      return l.reduce((s, o) => s + o.x, 0) / l.length;
    };
    const sweep = (down: boolean): void => {
      const order = rows.map((_, i) => i);
      if (!down) order.reverse();
      for (const i of order) {
        const r = rows[i];
        packRow(
          r,
          r.map((it) => {
            const p = pull(it, (o) => (down ? (rowOf.get(o) as number) < i : (rowOf.get(o) as number) > i));
            return p === undefined ? it.x : p;
          }),
        );
      }
    };
    sweep(true);
    sweep(false);
    sweep(true);
    // ---- rows from the top, evenly apart, with a lane for every line that bends between two rows
    let y = 0;
    rows.forEach((r, i) => {
      // devices of a row on one centre line, groups by their tops
      const nodeH = r.reduce((m, it) => Math.max(m, it.block ? 0 : it.h), 0);
      for (const it of r) it.top = it.block ? y : y + (nodeH - it.h) / 2;
      const bottom = r.reduce((m, it) => Math.max(m, it.top + it.h), y);
      let bends = 0;
      for (const it of r) for (const o of links.get(it) as SItem[]) if ((rowOf.get(o) as number) > i && Math.abs(o.x - it.x) > 1) bends++;
      y = ceilGrid(bottom + gy + Math.max(0, bends - 4) * LANE);
    });
    for (const it of items) {
      if (it.inner && it.at) {
        // the frame (with its 6 px of air) goes where the item is (by whole grid steps: the inside stays on the grid)
        const dx = roundGrid(it.x - it.at.x);
        const dy = it.top + it.h / 2 - it.at.y;
        it.inner.forEach((p, id) => out.set(id, { x: p.x + dx, y: p.y + dy }));
      } else out.set(it.id, { x: it.x, y: it.top + it.h / 2 });
    }
    return out;
  };
  const placed = place(null);
  const out = new Map<string, Pt>();
  // in the input's order, so the map compares and prints like the default result
  base.forEach((p, id) => {
    const q = placed.get(id);
    out.set(id, q ? { x: Math.round(q.x), y: Math.round(q.y) } : p);
  });
  return out;
}
