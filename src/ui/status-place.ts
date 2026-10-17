/**
 * Where a device's status indicator goes in the diagram (the simulation's
 * Operational / Powered off / Booting … pill): on its box's top edge, else
 * its bottom edge, where nothing else is drawn — no text (names, addresses,
 * port names and tags, chips, group titles), no port mark, no cable,
 * relation or membership line, no other box and no indicator already
 * placed. The scene is read once (bounding boxes in the drawing's own
 * coordinates; lines as points along them, a few pixels apart) into a grid,
 * so placing hundreds of indicators stays cheap. Nothing is moved: when no
 * place is free, the top right corner is taken anyway.
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** a device box: its own indicator may sit on it */
  owner?: SVGGraphicsElement;
}

const CELL = 48;
/** the line layers: their paths are sampled */
const LINE_LAYERS = ['.layer-links', '.layer-relations', '.layer-members', '.layer-next-hops', '.layer-vwires'];
const STEP = 4;
/** clearance from what is near: to the sides, and above and below (a box's text starts 10 px inside its edge) */
const GAP = 3;
const VGAP = 1;

export class StatusPlacer {
  private grid = new Map<string, Box[]>();

  constructor(scene: Element) {
    const outside = (e: Element): boolean => !e.closest('[class^="layer-sim"], [class*=" layer-sim"]');
    const bbox = (e: Element): DOMRect | null => {
      try {
        const r = (e as SVGGraphicsElement).getBBox();
        return r.width > 0 || r.height > 0 ? r : null;
      } catch (err) {
        return null;
      }
    };
    // texts, port marks, the badges and chips of the drawing
    const solids = scene.querySelectorAll('text, .layer-ports > *, .lport, .hub, .pill-box, .lag-mark, .svc-badge, .layer-badge');
    for (let i = 0; i < solids.length; i++) {
      const e = solids[i];
      if (!outside(e)) continue;
      const r = bbox(e);
      if (r) this.add({ x: r.x, y: r.y, w: r.width, h: r.height });
    }
    // the other boxes (a device's own box may carry its indicator)
    const boxes = scene.querySelectorAll('.dev-box, .net-box, .vbar-box, .pg-box, .lg-box');
    for (let i = 0; i < boxes.length; i++) {
      const r = bbox(boxes[i]);
      if (r) this.add({ x: r.x, y: r.y, w: r.width, h: r.height, owner: boxes[i] as SVGGraphicsElement });
    }
    // lines: points along them
    for (const sel of LINE_LAYERS) {
      const paths = scene.querySelectorAll(`${sel} path, ${sel} line, ${sel} polyline`);
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i] as SVGGeometryElement;
        if (!outside(p) || typeof p.getTotalLength !== 'function') continue;
        let len = 0;
        try {
          len = p.getTotalLength();
        } catch (err) {
          continue;
        }
        for (let d = 0; d <= len; d += STEP) {
          const pt = p.getPointAtLength(d);
          this.add({ x: pt.x - 2, y: pt.y - 2, w: 4, h: 4 });
        }
      }
    }
  }

  private add(b: Box): void {
    for (let cx = Math.floor(b.x / CELL); cx <= Math.floor((b.x + b.w) / CELL); cx++) {
      for (let cy = Math.floor(b.y / CELL); cy <= Math.floor((b.y + b.h) / CELL); cy++) {
        const k = cx + ',' + cy;
        const list = this.grid.get(k);
        if (list) list.push(b);
        else this.grid.set(k, [b]);
      }
    }
  }

  private free(r: Box, own: DOMRect): boolean {
    for (let cx = Math.floor(r.x / CELL); cx <= Math.floor((r.x + r.w) / CELL); cx++) {
      for (let cy = Math.floor(r.y / CELL); cy <= Math.floor((r.y + r.h) / CELL); cy++) {
        const list = this.grid.get(cx + ',' + cy);
        if (!list) continue;
        for (const b of list) {
          if (b.owner && Math.abs(b.x - own.x) < 0.5 && Math.abs(b.y - own.y) < 0.5 && Math.abs(b.w - own.width) < 0.5) continue;
          if (r.x < b.x + b.w && b.x < r.x + r.w && r.y < b.y + b.h && b.y < r.y + r.h) return false;
        }
      }
    }
    return true;
  }

  /** A place for an indicator w × h on a box's edge (taken: nothing else goes there afterwards). */
  find(own: DOMRect, w: number, h: number): { x: number; y: number; edge: 'top' | 'bottom' | 'none' } {
    const right = own.x + own.width - w - 10;
    const left = Math.min(right, own.x + 10);
    for (const edge of ['top', 'bottom'] as Array<'top' | 'bottom'>) {
      const y = (edge === 'top' ? own.y : own.y + own.height) - h / 2;
      for (let x = right; x >= left - 0.01; x -= STEP) {
        const r = { x, y, w, h };
        // (a few pixels clear of its neighbours)
        if (this.free({ x: x - GAP, y: y - VGAP, w: w + 2 * GAP, h: h + 2 * VGAP }, own)) {
          this.add(r);
          return { x, y, edge };
        }
      }
    }
    const r = { x: right, y: own.y - h / 2, w, h };
    this.add(r);
    return { x: right, y: r.y, edge: 'none' };
  }
}
