/**
 * Auto-arrange strategies. Each one is a pure, deterministic function of the
 * canonical layout input (layout/input.ts), so arranging twice moves nothing
 * the second time and the same model always gets the same positions.
 *
 *   default   the tiered / stress layout of layout/physical.ts and
 *             layout/logical.ts, unchanged.
 *   compact   the default layout shrunk towards its centre, then pushed apart
 *             again just enough that no two nodes (and no two group frames)
 *             overlap: the same arrangement, with the slack taken out. Good
 *             for small architectures that should fit on one screen or slide.
 *             Rows and stacks keep their order, so crossings don't change;
 *             cable and relation labels have less room and may sit closer to
 *             their lines.
 *   spacious  the default layout spread out from its centre by a fixed
 *             factor. Distances only grow, so nothing can come to overlap,
 *             and every cable and relation gets more room for its labels:
 *             for dense architectures, at the price of a larger picture.
 *
 * Group frames are derived from their contents when drawing, so the compact
 * strategy keeps every node of a group clear of the frames of the groups it
 * does not belong to: two nodes are kept apart by their gap plus the frame
 * padding (and, above a frame, its title) of every group that contains only
 * one of them.
 *
 * Only + - * / and comparisons are used, and the results are rounded to
 * integers, as in the default layout.
 */
import { Pt } from './geometry';
import { LayoutInput, cmp } from './input';
import { commonChain, logicalSpecs } from './logical';
import { physicalBoxes } from './physical';
import { LayoutView, autoPositions } from './positions';
import { GROUP_PAD, groupHeader } from './sizes';

export type ArrangeStrategy = 'default' | 'compact' | 'spacious';
/** In this order: it is also the tie-breaker when two strategies give the same positions. */
export const STRATEGIES: ArrangeStrategy[] = ['default', 'compact', 'spacious'];

export const STRATEGY_LABEL: { [s in ArrangeStrategy]: string } = {
  default: 'Default',
  compact: 'Compact',
  spacious: 'Spacious',
};

/** factor the compact strategy shrinks the default layout by before separating the nodes again */
const COMPACT_SHRINK = 0.55;
/** factor the spacious strategy spreads the default layout by */
const SPACIOUS_SPREAD = 1.4;
/** gaps the compact strategy keeps between two nodes (x, y), per view */
const COMPACT_GAP: { [v in LayoutView]: [number, number] } = { physical: [56, 72], logical: [64, 64] };
/** two items exactly the separation apart are apart (sums of fractions are not exact) */
const EPS = 0.5;



interface SNode {
  id: string;
  w: number;
  h: number;
  /** the groups the node lies in, innermost first */
  chain: string[];
}

/** Positions of one view, arranged with a strategy. */
export function strategyPositions(view: LayoutView, input: LayoutInput, strategy: ArrangeStrategy): Map<string, Pt> {
  const base = autoPositions(view, input);
  if (strategy === 'default' || base.size === 0) return base;
  if (strategy === 'spacious') return spread(base, SPACIOUS_SPREAD);
  return compact(view, input, base);
}

/** Positions for every strategy (keyed by strategy); the default is computed once. */
export function allStrategyPositions(view: LayoutView, input: LayoutInput): Map<ArrangeStrategy, Map<string, Pt>> {
  const base = autoPositions(view, input);
  const out = new Map<ArrangeStrategy, Map<string, Pt>>();
  out.set('default', base);
  out.set('compact', base.size ? compact(view, input, base) : base);
  out.set('spacious', base.size ? spread(base, SPACIOUS_SPREAD) : base);
  return out;
}

/** Centre of the node centres' bounding box. */
function centreOf(pos: Map<string, Pt>): Pt {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  pos.forEach((p) => {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  });
  return { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) };
}

function spread(pos: Map<string, Pt>, k: number): Map<string, Pt> {
  const c = centreOf(pos);
  const out = new Map<string, Pt>();
  pos.forEach((p, id) => out.set(id, { x: Math.round(c.x + (p.x - c.x) * k), y: Math.round(c.y + (p.y - c.y) * k) }));
  return out;
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
    const boxes = physicalBoxes(input, base);
    return input.devices.map((d) => {
      const b = boxes.get(d.id) as { w: number; h: number };
      return { id: d.id, w: b.w, h: b.h, chain: devChain(d.id) };
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
    return { id: s.id, w: s.w, h: s.h, chain };
  });
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
  /** a block: the positions of the nodes inside it, and its centre in those coordinates */
  inner?: Map<string, Pt>;
  at?: Pt;
}

/**
 * The default layout with the slack taken out, container by container: the
 * contents of each group are compacted first, and the group then takes part
 * in its parent's compaction as one rigid block the size of its frame (with
 * its title), so frames never overlap anything outside them. Inside a
 * container, the items are shrunk towards their common centre and separated
 * again: first along x (in x order, each item pushed right of the earlier
 * ones it stands beside in the default layout), then along y (in y order,
 * each pushed below the earlier ones it overlaps horizontally). The order
 * along each axis is kept, so rows stay rows and stacks stay stacks, and
 * after the two passes every pair of items is apart along one axis.
 */
function compact(view: LayoutView, input: LayoutInput, base: Map<string, Pt>): Map<string, Pt> {
  const nodes = viewSNodes(view, input, base).filter((n) => base.has(n.id));
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
  const place = (c: string | null): Map<string, Pt> => {
    const items: Item[] = [];
    for (const g of childGroups(c)) {
      const inner = place(g);
      const now = frame(g, inner);
      const was = frame(g, deep(g));
      // a frame keeps a little air around it, like the room between two nodes
      items.push({ id: 'group:' + g, base: was.c, top: was.c.y - was.h / 2, w: now.w + 12, h: now.h + 12, inner, at: now.c });
    }
    for (const n of ownNodes(c)) {
      const p = base.get(n.id) as Pt;
      items.push({ id: n.id, base: p, top: p.y - n.h / 2, w: n.w, h: n.h });
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
    const sepX = (a: Item, b: Item): number => (a.w + b.w) / 2 + gx;
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
    for (const it of items) {
      const x = X.get(it) as number;
      const y = Y.get(it) as number;
      if (it.inner && it.at) {
        const dx = x - it.at.x;
        const dy = y - it.at.y;
        it.inner.forEach((p, id) => out.set(id, { x: p.x + dx, y: p.y + dy }));
      } else out.set(it.id, { x, y });
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
