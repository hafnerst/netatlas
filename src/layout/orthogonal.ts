/**
 * Orthogonal routing, the way the Structured arrangement draws cables and
 * relations: every route is made of horizontal and vertical segments only,
 * with exact 90° bends, and goes around the boxes in its way.
 *
 * A route is found on a sparse grid: the lines through its two ends, the
 * line halfway between them, and the lines just outside every obstacle near
 * them (`margin` away from its sides). A shortest path on that grid that
 * stays out of every obstacle is searched (Dijkstra), where a bend costs as
 * much as `BEND` px of length, crossing a route already laid costs `CROSS`
 * and running along one costs extra per px, so routes take few bends and
 * keep apart where they can. A route leaves its start in the direction its
 * port faces and arrives at its end against the direction of that port.
 *
 * Routes that still share a line afterwards (a corridor between two rows
 * that several cables use) are spread apart sideways by `separate`, which
 * moves only their inner segments: the segments at the ports stay where
 * they are, so every route keeps its attachment.
 *
 * Only + - * / and comparisons are used and every tie is broken in a fixed
 * order, so every browser computes the same routes.
 */
import { Pt, Rect } from './geometry';

/** what a bend costs, as px of length */
const BEND = 48;
/** what crossing a route already laid costs */
const CROSS = 90;
/** extra cost per px of running on a line another route already runs on */
const ALONG = 3;
/** at most this many grid lines per axis (the window around a route shrinks to it) */
const MAX_LINES = 160;

/** A laid route's segments, for the costs of the next ones. */
export interface Lanes {
  /** horizontal segments: y, x0 < x1 */
  h: Array<[number, number, number]>;
  /** vertical segments: x, y0 < y1 */
  v: Array<[number, number, number]>;
}

export function newLanes(): Lanes {
  return { h: [], v: [] };
}

/** Record a route's segments as taken (crossing a route costs, running along it too). */
export function addLanes(l: Lanes, pts: Pt[]): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (Math.abs(a.y - b.y) < 0.01) l.h.push([a.y, Math.min(a.x, b.x), Math.max(a.x, b.x)]);
    else if (Math.abs(a.x - b.x) < 0.01) l.v.push([a.x, Math.min(a.y, b.y), Math.max(a.y, b.y)]);
  }
}

function inside(x: number, y: number, o: Rect): boolean {
  return x > o.x + 0.01 && x < o.x + o.w - 0.01 && y > o.y + 0.01 && y < o.y + o.h - 0.01;
}

/**
 * Sorted grid lines without near-duplicates. The first `keep` values (the
 * route's ends) are kept exactly: a line closer than a hair to one of them
 * is dropped in its favour, so the route runs exactly through its ends.
 */
function uniq(v: number[], keep: number): number[] {
  const s = v.map((x, i) => ({ x, k: i < keep })).sort((a, b) => a.x - b.x || Number(b.k) - Number(a.k));
  const out: Array<{ x: number; k: boolean }> = [];
  for (const e of s) {
    const last = out[out.length - 1];
    // (two ends are both kept unless they are the same: a route between ends half a px apart jogs by that much)
    if (last && e.x - last.x <= 0.5 && !(e.k && last.k && e.x - last.x > 0.01)) {
      if (e.k && !last.k) out[out.length - 1] = e;
      continue;
    }
    out.push(e);
  }
  return out.map((e) => e.x);
}

/** A tiny binary heap of [cost, order, state], smallest first; ties by order (deterministic). */
class Heap {
  private a: Array<[number, number, number]> = [];
  get size(): number {
    return this.a.length;
  }
  push(x: [number, number, number]): void {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[p], a[i])) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop() as [number, number, number];
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function less(p: [number, number, number], q: [number, number, number]): boolean {
  return p[0] < q[0] - 1e-9 || (Math.abs(p[0] - q[0]) <= 1e-9 && p[1] < q[1]);
}

/**
 * The search's state arrays, kept from one search to the next (a route each is many searches): a state's
 * values count only when its stamp is the current search's, so nothing has to be cleared.
 */
let bufN = 0;
let bufDist = new Float64Array(0);
let bufPrev = new Int32Array(0);
let bufStamp = new Uint32Array(0);
let bufGen = 0;
function buffers(n: number): { dist: Float64Array; prev: Int32Array; stamp: Uint32Array; gen: number } {
  if (n > bufN) {
    bufN = Math.max(n, bufN * 2);
    bufDist = new Float64Array(bufN);
    bufPrev = new Int32Array(bufN);
    bufStamp = new Uint32Array(bufN);
    bufGen = 0;
  }
  bufGen++;
  if (bufGen >= 0xffffffff) {
    bufStamp.fill(0);
    bufGen = 1;
  }
  return { dist: bufDist, prev: bufPrev, stamp: bufStamp, gen: bufGen };
}

/** unit directions: 0 +x, 1 -x, 2 +y, 3 -y */
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

function dirOf(d: Pt): number {
  if (Math.abs(d.x) >= Math.abs(d.y)) return d.x >= 0 ? 0 : 1;
  return d.y >= 0 ? 2 : 3;
}

/**
 * An orthogonal way from `s` to `e`: `s` left in direction `sd`, `e`
 * reached moving against `ed` (the direction its port faces). Around
 * `obstacles`, `margin` clear of them; `lanes` are the routes laid before.
 * Returns the points from `s` to `e`, both included, bends in between.
 */
export function orthoRoute(s: Pt, sd: Pt, e: Pt, ed: Pt, obstacles: Rect[], margin: number, lanes: Lanes = newLanes()): Pt[] {
  // an obstacle that holds an end of the route can't be avoided: it is left out. The others are kept clear
  // of by `margin` (grown by it), or by as much as the route's ends leave where they are nearer than that
  const gap = (o: Rect, p: Pt): number => Math.max(o.x - p.x, p.x - (o.x + o.w), o.y - p.y, p.y - (o.y + o.h));
  const all = obstacles
    .filter((o) => !inside(s.x, s.y, o) && !inside(e.x, e.y, o))
    .map((o) => {
      const k = Math.max(0, Math.min(margin, gap(o, s) - 0.5, gap(o, e) - 0.5));
      return { x: o.x - k, y: o.y - k, w: o.w + 2 * k, h: o.h + 2 * k };
    });
  for (const pad of [300, 1200, Infinity]) {
    const x0 = Math.min(s.x, e.x) - pad;
    const x1 = Math.max(s.x, e.x) + pad;
    const y0 = Math.min(s.y, e.y) - pad;
    const y1 = Math.max(s.y, e.y) + pad;
    const near = all.filter((o) => o.x + o.w > x0 && o.x < x1 && o.y + o.h > y0 && o.y < y1);
    const way = search(s, dirOf(sd), e, dirOf({ x: -ed.x, y: -ed.y }), near, lanes);
    if (way) return way;
  }
  // no way around (an end walled in): a plain elbow, still orthogonal
  return simplify([s, { x: e.x, y: s.y }, e]);
}

function search(s: Pt, sdir: number, e: Pt, edir: number, obstacles: Rect[], lanes: Lanes): Pt[] | null {
  let obs = obstacles;
  let xs: number[] = [];
  let ys: number[] = [];
  for (;;) {
    xs = [s.x, e.x, (s.x + e.x) / 2];
    ys = [s.y, e.y, (s.y + e.y) / 2];
    // (the obstacles are already grown by the margin: the lines run along their edges)
    for (const o of obs) {
      xs.push(o.x, o.x + o.w);
      ys.push(o.y, o.y + o.h);
    }
    xs = uniq(xs, 2);
    ys = uniq(ys, 2);
    if ((xs.length <= MAX_LINES && ys.length <= MAX_LINES) || obs.length < 8) break;
    // too many lines: only the obstacles nearest to the route's box
    const cx = (s.x + e.x) / 2;
    const cy = (s.y + e.y) / 2;
    obs = obs
      .map((o, i) => ({ o, i, d: Math.abs(o.x + o.w / 2 - cx) + Math.abs(o.y + o.h / 2 - cy) }))
      .sort((p, q) => p.d - q.d || p.i - q.i)
      .slice(0, Math.floor(obs.length * 0.7))
      .sort((p, q) => p.i - q.i)
      .map((x) => x.o);
  }
  const nx = xs.length;
  const ny = ys.length;
  /** the grid line nearest to `x` */
  const find = (v: number[], x: number): number => {
    let best = 0;
    for (let i = 1; i < v.length; i++) if (Math.abs(v[i] - x) < Math.abs(v[best] - x)) best = i;
    return best;
  };
  const si = find(xs, s.x);
  const sj = find(ys, s.y);
  const ei = find(xs, e.x);
  const ej = find(ys, e.y);
  // what the obstacles take, marked from each obstacle's extent on the grid:
  // grid points inside one, and the grid segments that run through one
  const blocked = new Uint8Array(nx * ny);
  const hShut = new Uint8Array(nx * ny);
  const vShut = new Uint8Array(nx * ny);
  /** first index whose value is above `x` (by more than a hair) */
  const above = (v: number[], x: number): number => {
    let lo = 0;
    let hi = v.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (v[m] <= x + 0.01) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  /** last index whose value is below `x` (by more than a hair) */
  const below = (v: number[], x: number): number => {
    let lo = -1;
    let hi = v.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (v[m] < x - 0.01) lo = m;
      else hi = m - 1;
    }
    return lo;
  };
  for (const o of obs) {
    // the lines strictly inside the obstacle, and the stretches that reach into it
    const i0 = above(xs, o.x);
    const i1 = below(xs, o.x + o.w);
    const j0 = above(ys, o.y);
    const j1 = below(ys, o.y + o.h);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) blocked[j * nx + i] = 1;
      // horizontal stretches i -> i+1 overlapping (o.x, o.x + o.w): from the one ending past o.x to the one starting before its end
      for (let i = Math.max(0, i0 - 1); i <= Math.min(nx - 2, i1); i++) hShut[j * nx + i] = 1;
    }
    for (let i = i0; i <= i1; i++) for (let j = Math.max(0, j0 - 1); j <= Math.min(ny - 2, j1); j++) vShut[j * nx + i] = 1;
  }
  const canStep = (i: number, j: number, d: number): boolean => {
    if (d === 0 || d === 1) {
      const a = d === 0 ? i : i - 1;
      return a >= 0 && a + 1 < nx && !hShut[j * nx + a];
    }
    const a = d === 2 ? j : j - 1;
    return a >= 0 && a + 1 < ny && !vShut[a * nx + i];
  };
  /** what running from one grid point to the next costs beyond its length: crossings and shared lines */
  // the routes laid before, as far as they reach into the grid: sorted across their lines for the crossings,
  // grouped by their line for the stretches run along them
  const gx0 = xs[0];
  const gx1 = xs[nx - 1];
  const gy0 = ys[0];
  const gy1 = ys[ny - 1];
  const vs = lanes.v.filter(([x, a, b]) => x >= gx0 - 1 && x <= gx1 + 1 && b >= gy0 && a <= gy1).sort((p, q) => p[0] - q[0]);
  const hs = lanes.h.filter(([y, a, b]) => y >= gy0 - 1 && y <= gy1 + 1 && b >= gx0 && a <= gx1).sort((p, q) => p[0] - q[0]);
  /** index of the first lane whose line is above `v` (lanes sorted by their line) */
  const from = (l: Array<[number, number, number]>, v: number): number => {
    let lo = 0;
    let hi = l.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (l[m][0] <= v) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  /** what running along a grid line from (lo) to (hi) at `at` costs beyond its length: crossings of the lanes across, and the stretch on lanes along it */
  const extra = (at: number, lo: number, hi: number, across: Array<[number, number, number]>, along: Array<[number, number, number]>): number => {
    let c = 0;
    for (let k = from(across, lo + 0.5); k < across.length && across[k][0] < hi - 0.5; k++) if (at > across[k][1] + 0.5 && at < across[k][2] - 0.5) c += CROSS;
    for (let k = from(along, at - 0.5); k < along.length && along[k][0] < at + 0.5; k++) c += ALONG * Math.max(0, Math.min(hi, along[k][2]) - Math.max(lo, along[k][1]));
    return c;
  };
  // (each grid segment's cost once)
  const hCost = new Float64Array(nx * ny).fill(-1);
  const vCost = new Float64Array(nx * ny).fill(-1);
  const stepCost = (i: number, j: number, d: number): number => {
    if (d < 2) {
      const a = d === 0 ? i : i - 1;
      const k = j * nx + a;
      if (hCost[k] < 0) hCost[k] = xs[a + 1] - xs[a] + extra(ys[j], xs[a], xs[a + 1], vs, hs);
      return hCost[k];
    }
    const a = d === 2 ? j : j - 1;
    const k = a * nx + i;
    if (vCost[k] < 0) vCost[k] = ys[a + 1] - ys[a] + extra(xs[i], ys[a], ys[a + 1], hs, vs);
    return vCost[k];
  };
  // a state: a grid point, the direction of travel, and whether it has just turned there (a second turn
  // in the same place would be a U-turn back along its own way: never)
  const N = nx * ny * 8;
  const { dist, prev, stamp, gen } = buffers(N);
  const g = (k: number): number => (stamp[k] === gen ? dist[k] : Infinity);
  const set = (k: number, c: number, from: number): void => {
    stamp[k] = gen;
    dist[k] = c;
    prev[k] = from;
  };
  const st = (i: number, j: number, d: number, turned = 0): number => ((j * nx + i) * 4 + d) * 2 + turned;
  // A*: the queue is ordered by the cost so far plus the distance still to go (no step costs less than its
  // length, so the way found is a cheapest one); ties in the order the states were reached
  const togo = (i: number, j: number): number => Math.abs(xs[i] - xs[ei]) + Math.abs(ys[j] - ys[ej]);
  const heap = new Heap();
  let order = 0;
  const start = st(si, sj, sdir);
  set(start, 0, -1);
  heap.push([togo(si, sj), order++, start]);
  const goals = [st(ei, ej, edir, 0), st(ei, ej, edir, 1)];
  let goal = -1;
  while (heap.size) {
    const [f, , k] = heap.pop();
    const turned = k % 2;
    const d = ((k - turned) / 2) % 4;
    const cell = ((k - turned) / 2 - d) / 4;
    const i = cell % nx;
    const j = (cell - i) / nx;
    const c = g(k);
    if (f > c + togo(i, j) + 1e-9) continue;
    if (k === goals[0] || k === goals[1]) {
      goal = k;
      break;
    }
    // on: to the next grid point in the same direction
    if (canStep(i, j, d)) {
      const i2 = i + DX[d];
      const j2 = j + DY[d];
      if (!blocked[j2 * nx + i2] || (i2 === ei && j2 === ej)) {
        const k2 = st(i2, j2, d);
        const c2 = c + stepCost(i, j, d);
        if (c2 < g(k2) - 1e-9) {
          set(k2, c2, k);
          heap.push([c2 + togo(i2, j2), order++, k2]);
        }
      }
    }
    // a right-angle turn where it is (not right after another one)
    if (turned) continue;
    for (const t of d < 2 ? [2, 3] : [0, 1]) {
      const k2 = st(i, j, t, 1);
      const c2 = c + BEND;
      if (c2 < g(k2) - 1e-9) {
        set(k2, c2, k);
        heap.push([c2 + togo(i, j), order++, k2]);
      }
    }
  }
  if (goal < 0) return null;
  const pts: Pt[] = [];
  for (let k = goal; k >= 0; k = prev[k]) {
    const cell = (((k - (k % 2)) / 2) - (((k - (k % 2)) / 2) % 4)) / 4;
    const i = cell % nx;
    const j = (cell - i) / nx;
    const p = { x: xs[i], y: ys[j] };
    const q = pts[pts.length - 1];
    if (!q || q.x !== p.x || q.y !== p.y) pts.push(p);
  }
  pts.reverse();
  // (the grid holds both ends exactly)
  pts[0] = { x: s.x, y: s.y };
  pts[pts.length - 1] = { x: e.x, y: e.y };
  return simplify(pts);
}

/** Without repeated points, and without points in the middle of a straight run. */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01) continue;
    out.push({ x: p.x, y: p.y });
    while (out.length >= 3) {
      const a = out[out.length - 3];
      const b = out[out.length - 2];
      const c = out[out.length - 1];
      const straight = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01);
      if (!straight) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

/** Do two segments cross properly (each from one side of the other to its other side)? */
function properCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const side = (p: Pt, q: Pt, r: Pt): number => {
    const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return v > 1e-6 ? 1 : v < -1e-6 ? -1 : 0;
  };
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/** Is every segment of the polyline horizontal or vertical? */
export function isOrthogonal(pts: Pt[]): boolean {
  for (let i = 0; i + 1 < pts.length; i++) if (Math.abs(pts[i].x - pts[i + 1].x) > 0.01 && Math.abs(pts[i].y - pts[i + 1].y) > 0.01) return false;
  return true;
}

/** One route for `separate`: its points, its width, and whether its first and last segments are fixed (at a port). */
export interface SepRoute {
  id: string;
  pts: Pt[];
  width: number;
}

/**
 * Spread apart the inner segments of routes that run on one line over a
 * common stretch (a shared corridor): each group of such segments is fanned
 * out around its line, `gap` apart (plus the routes' widths), in the order
 * of where the routes come from and go to, so they don't cross each other
 * there. The first and last segment of every route stay (they are at the
 * ports). A move that would take a segment, or the ones beside it, into an
 * obstacle is not made. Changes `routes` in place.
 */
export function separate(routes: SepRoute[], gap: number, obstacles: Rect[]): void {
  interface Seg {
    r: SepRoute;
    k: number;
    horiz: boolean;
    at: number;
    lo: number;
    hi: number;
    /** sort key: where the route is before and after the segment, across the line */
    key: number;
  }
  const segs: Seg[] = [];
  for (const r of routes) {
    const p = r.pts;
    for (let k = 1; k + 2 < p.length; k++) {
      const a = p[k];
      const b = p[k + 1];
      const horiz = Math.abs(a.y - b.y) < 0.01;
      const before = p[k - 1];
      const after = p[k + 2];
      const key = horiz ? before.y - a.y + (after.y - b.y) : before.x - a.x + (after.x - b.x);
      segs.push({ r, k, horiz, at: horiz ? a.y : a.x, lo: horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y), hi: horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y), key });
    }
  }
  segs.sort((p, q) => Number(p.horiz) - Number(q.horiz) || p.at - q.at || p.lo - q.lo || (p.r.id < q.r.id ? -1 : p.r.id > q.r.id ? 1 : p.k - q.k));
  /** is the segment a-b clear of the obstacles (but those that hold `end`: a port on its own box's edge) */
  const clear = (a: Pt, b: Pt, end?: Pt): boolean => {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const holds = (o: Rect): boolean => !!end && end.x >= o.x - 0.01 && end.x <= o.x + o.w + 0.01 && end.y >= o.y - 0.01 && end.y <= o.y + o.h + 0.01;
    return !obstacles.some((o) => x1 > o.x + 0.01 && x0 < o.x + o.w - 0.01 && y1 > o.y + 0.01 && y0 < o.y + o.h - 0.01 && !holds(o));
  };
  let i = 0;
  while (i < segs.length) {
    // the segments on one line whose stretches overlap (transitively)
    let j = i + 1;
    let hi = segs[i].hi;
    while (j < segs.length && segs[j].horiz === segs[i].horiz && Math.abs(segs[j].at - segs[i].at) < 0.5 && segs[j].lo < hi - 0.5) {
      hi = Math.max(hi, segs[j].hi);
      j++;
    }
    const group = segs.slice(i, j);
    i = j;
    if (group.length < 2 || new Set(group.map((s) => s.r)).size < 2) continue;
    group.sort((p, q) => p.key - q.key || (p.r.id < q.r.id ? -1 : p.r.id > q.r.id ? 1 : p.k - q.k));
    const total = group.reduce((s, g) => s + g.r.width, 0) + gap * (group.length - 1);
    // A small group is put in the order whose lanes cross each other least where they come in and go out
    // (the segment, and the ones before and after it): every order is tried, the first of the cheapest kept.
    if (group.length <= 6) {
      const offsets = (n: number): number[] => {
        const out: number[] = [];
        let c = -total / 2;
        for (let i = 0; i < n; i++) {
          const g = order[i];
          out.push(c + g.r.width / 2);
          c += g.r.width + gap;
        }
        return out;
      };
      let order = group.slice();
      const legs = (g: Seg, off: number): Array<[Pt, Pt]> => {
        const p = g.r.pts;
        const na = g.horiz ? { x: p[g.k].x, y: p[g.k].y + off } : { x: p[g.k].x + off, y: p[g.k].y };
        const nb = g.horiz ? { x: p[g.k + 1].x, y: p[g.k + 1].y + off } : { x: p[g.k + 1].x + off, y: p[g.k + 1].y };
        return [[p[g.k - 1], na], [na, nb], [nb, p[g.k + 2]]];
      };
      const crossingsOf = (o: Seg[]): number => {
        order = o;
        const offs = offsets(o.length);
        const ls = o.map((g, i) => legs(g, offs[i]));
        let n = 0;
        for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) for (const [a1, b1] of ls[i]) for (const [a2, b2] of ls[j]) if (properCross(a1, b1, a2, b2)) n++;
        return n;
      };
      let best = group.slice();
      let bestN = crossingsOf(best);
      const perms = (xs: Seg[]): Seg[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms(xs.slice(0, i).concat(xs.slice(i + 1))).map((r) => [x].concat(r))));
      for (const o of perms(group)) {
        if (!bestN) break;
        const n = crossingsOf(o);
        if (n < bestN) {
          bestN = n;
          best = o;
        }
      }
      group.splice(0, group.length, ...best);
    }
    let cur = -total / 2;
    for (const g of group) {
      const off = cur + g.r.width / 2;
      cur += g.r.width + gap;
      if (Math.abs(off) < 0.01) continue;
      const p = g.r.pts;
      const a = p[g.k];
      const b = p[g.k + 1];
      const na = g.horiz ? { x: a.x, y: a.y + off } : { x: a.x + off, y: a.y };
      const nb = g.horiz ? { x: b.x, y: b.y + off } : { x: b.x + off, y: b.y };
      // the segments before and after get longer or shorter: they must stay clear, and keep their direction
      const before = p[g.k - 1];
      const after = p[g.k + 2];
      const keeps = (u: Pt, v: Pt, w: Pt): boolean => (g.horiz ? (u.y - v.y) * (u.y - w.y) > 0.01 : (u.x - v.x) * (u.x - w.x) > 0.01);
      if (!keeps(before, a, na) || !keeps(after, b, nb)) continue;
      if (!clear(na, nb) || !clear(before, na, before) || !clear(nb, after, after)) continue;
      p[g.k] = na;
      p[g.k + 1] = nb;
    }
  }
}
