/**
 * Where the labels of the simulation's dots go: pure geometry, no DOM, so
 * it is tested on its own. A label is tried at a few places around its dot
 * (on its lane's side first, then further out, then the other side); the
 * first place that touches neither a text of the diagram (addresses,
 * names, port labels), nor a device box, nor a label already placed wins.
 * A dot whose label finds no place is not drawn (the event log has it),
 * so labels never overlap anything.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A grid of boxes for fast overlap tests. */
export class BoxIndex {
  private cells = new Map<string, Box[]>();
  constructor(private size = 64) {}

  add(b: Box): void {
    for (const k of this.keys(b)) {
      const c = this.cells.get(k);
      if (c) c.push(b);
      else this.cells.set(k, [b]);
    }
  }

  hits(b: Box, pad = 1): boolean {
    for (const k of this.keys(b)) {
      const c = this.cells.get(k);
      if (!c) continue;
      for (const o of c) if (overlaps(b, o, pad)) return true;
    }
    return false;
  }

  private keys(b: Box): string[] {
    const out: string[] = [];
    const s = this.size;
    for (let gx = Math.floor(b.x / s); gx <= Math.floor((b.x + b.w) / s); gx++) for (let gy = Math.floor(b.y / s); gy <= Math.floor((b.y + b.h) / s); gy++) out.push(gx + ',' + gy);
    return out;
  }
}

export function overlaps(a: Box, b: Box, pad = 0): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/**
 * The places a label of size w × h is tried around a dot at (x, y) on a
 * line going in direction (ux, uy); `side` is +1 or −1 (the lane's side).
 */
export function candidates(x: number, y: number, ux: number, uy: number, w: number, h: number, side: 1 | -1): Box[] {
  // the normal of the line, towards the lane's side
  const nx = -uy * side;
  const ny = ux * side;
  const out: Box[] = [];
  for (const [s, d] of [[1, 9], [1, 20], [1, 32], [-1, 9], [-1, 20], [-1, 32]] as Array<[number, number]>) {
    const cx = x + nx * d * s;
    const cy = y + ny * d * s;
    // the box beside the point: centred on it along the normal, its near edge at the point
    const bx = nx * s >= 0.3 ? cx : nx * s <= -0.3 ? cx - w : cx - w / 2;
    const by = ny * s >= 0.3 ? cy : ny * s <= -0.3 ? cy - h : cy - h / 2;
    out.push({ x: bx, y: by, w, h });
  }
  return out;
}

/** The first candidate that hits nothing (null: none). */
export function placeLabel(cands: Box[], obstacles: BoxIndex, placed: BoxIndex): Box | null {
  for (const c of cands) {
    if (obstacles.hits(c) || placed.hits(c, 2)) continue;
    return c;
  }
  return null;
}
