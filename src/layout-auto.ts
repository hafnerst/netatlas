/**
 * Positions of diagram nodes: auto-arrange, stored positions, and placement
 * of new nodes. Everything here is deterministic (see layout-input.ts).
 *
 * Positions are keyed by plain entity id (ids are unique across the model):
 *   physical view: device ids
 *   logical view:  device ids, network ids, and ids of relations drawn as
 *                  hubs (3+ devices)
 *
 * resolvePositions(view, input, stored) is THE function that decides what is
 * displayed:
 *   - nothing stored for this view  -> the auto-arrange result
 *   - otherwise                     -> stored positions for known nodes, and
 *     nodes without a stored position are placed next to their neighbors
 *     (in id order) without moving anything else.
 */
import { Pt } from './geometry';
import { LayoutInput, cmp } from './layout-input';
import { autoLogical, logicalEdges, logicalSpecs } from './layout-logical';
import { autoPhysical, physicalBaseSize } from './layout-physical';

export type LayoutView = 'physical' | 'logical';
export const LAYOUT_VIEWS: LayoutView[] = ['physical', 'logical'];

export interface PlaceNode {
  id: string;
  w: number;
  h: number;
  /** neighbor ids (sorted) */
  nbrs: string[];
}

/** refs ("device:x", "network:y", "hub:r") <-> plain ids */
export function refToId(ref: string): string {
  return ref.slice(ref.indexOf(':') + 1);
}

/** Nodes of a view with sizes and neighbors, sorted by id. */
export function viewNodes(view: LayoutView, input: LayoutInput): PlaceNode[] {
  if (view === 'physical') {
    const nbrs = new Map<string, Set<string>>();
    for (const d of input.devices) nbrs.set(d.id, new Set());
    const add = (a: string, b: string): void => {
      if (a !== b && nbrs.has(a) && nbrs.has(b)) {
        (nbrs.get(a) as Set<string>).add(b);
        (nbrs.get(b) as Set<string>).add(a);
      }
    };
    for (const l of input.links) add(l.a.device, l.b.device);
    // devices of the same group count as neighbors, so a new device lands in its group
    const byGroup = new Map<string, string[]>();
    for (const d of input.devices) {
      if (!d.group) continue;
      if (!byGroup.has(d.group)) byGroup.set(d.group, []);
      (byGroup.get(d.group) as string[]).push(d.id);
    }
    byGroup.forEach((ids) => {
      for (const a of ids) for (const b of ids) add(a, b);
    });
    return input.devices.map((d) => ({ id: d.id, ...physicalBaseSize(d.label), nbrs: Array.from(nbrs.get(d.id) as Set<string>).sort(cmp) }));
  }
  const specs = logicalSpecs(input);
  const nbrs = new Map<string, Set<string>>();
  for (const s of specs) nbrs.set(s.id, new Set());
  for (const [a, b] of logicalEdges(input, specs)) {
    (nbrs.get(refToId(a)) as Set<string>).add(refToId(b));
    (nbrs.get(refToId(b)) as Set<string>).add(refToId(a));
  }
  return specs
    .map((s) => ({ id: s.id, w: s.w, h: s.h, nbrs: Array.from(nbrs.get(s.id) as Set<string>).sort(cmp) }))
    .sort((a, b) => cmp(a.id, b.id));
}

/** Auto-arrange result for one view, keyed by plain id. */
export function autoPositions(view: LayoutView, input: LayoutInput): Map<string, Pt> {
  const phys = autoPhysical(input);
  if (view === 'physical') return phys;
  const out = new Map<string, Pt>();
  autoLogical(input, phys).forEach((p, ref) => out.set(refToId(ref), p));
  return out;
}

const GAP = 40;
const STEP = 20;
const MAX_RING = 400;

/**
 * Place `nodes` that have no position in `fixed`, one by one in id order,
 * next to the mean of their already-placed neighbors (or below everything if
 * they have none), at the nearest free spot on a 20 px grid. Nothing that is
 * already placed moves.
 */
export function placeIncremental(nodes: PlaceNode[], fixed: Map<string, Pt>): Map<string, Pt> {
  const out = new Map<string, Pt>();
  const size = new Map(nodes.map((n) => [n.id, n] as [string, PlaceNode]));
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  fixed.forEach((p, id) => {
    const n = size.get(id);
    if (!n) return;
    out.set(id, { x: p.x, y: p.y });
    boxes.push({ x: p.x, y: p.y, w: n.w, h: n.h });
  });
  const pending = nodes.filter((n) => !out.has(n.id));
  if (!pending.length) return out;
  // where to put nodes without placed neighbors: a row below everything placed
  let floorY = 0;
  let floorX = 0;
  if (boxes.length) {
    floorY = boxes.reduce((m, b) => Math.max(m, b.y + b.h / 2), -Infinity) + 80;
    floorX = boxes.reduce((m, b) => Math.min(m, b.x - b.w / 2), Infinity);
  }
  let rowX = floorX;
  const free = (x: number, y: number, n: PlaceNode): boolean => {
    for (const b of boxes) {
      if (Math.abs(b.x - x) < (b.w + n.w) / 2 + GAP && Math.abs(b.y - y) < (b.h + n.h) / 2 + GAP) return false;
    }
    return true;
  };
  for (const n of pending) {
    const placedNbrs = n.nbrs.filter((id) => out.has(id));
    let tx: number;
    let ty: number;
    if (placedNbrs.length) {
      tx = 0;
      ty = 0;
      for (const id of placedNbrs) {
        const p = out.get(id) as Pt;
        tx += p.x;
        ty += p.y;
      }
      tx = Math.round(tx / placedNbrs.length);
      ty = Math.round(ty / placedNbrs.length) + (placedNbrs.length === 1 ? n.h + GAP * 2 : 0);
    } else {
      tx = Math.round(rowX + n.w / 2);
      ty = Math.round(floorY + n.h / 2);
      rowX += n.w + GAP * 2;
    }
    let spot: Pt | null = null;
    for (let r = 0; r <= MAX_RING && !spot; r++) {
      // candidates on the square ring of radius r, nearest first, ties by (dy, dx)
      const ring: Array<[number, number]> = [];
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
      }
      ring.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
      for (const [dx, dy] of ring) {
        const x = tx + dx * STEP;
        const y = ty + dy * STEP;
        if (free(x, y, n)) {
          spot = { x, y };
          break;
        }
      }
    }
    const p = spot || { x: tx, y: ty };
    out.set(n.id, p);
    boxes.push({ x: p.x, y: p.y, w: n.w, h: n.h });
  }
  return out;
}

/** What is displayed for a view: stored positions, else auto-arrange; new nodes placed incrementally. */
export function resolvePositions(view: LayoutView, input: LayoutInput, stored: Map<string, Pt>): Map<string, Pt> {
  const nodes = viewNodes(view, input);
  const known = new Map<string, Pt>();
  for (const n of nodes) {
    const p = stored.get(n.id);
    if (p) known.set(n.id, p);
  }
  if (!known.size) return autoPositions(view, input);
  return placeIncremental(nodes, known);
}

/** Same positions for the same ids? */
export function samePositions(a: Map<string, Pt>, b: Map<string, Pt>): boolean {
  if (a.size !== b.size) return false;
  let same = true;
  a.forEach((p, id) => {
    const q = b.get(id);
    if (!q || q.x !== p.x || q.y !== p.y) same = false;
  });
  return same;
}
