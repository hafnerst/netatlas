/**
 * Where a device's status indicator goes in the diagram (the simulation's
 * Operational / Powered off / Booting … pill, an active querier's mark): on
 * its box's top edge, else its bottom edge, else just above or below the
 * box, where nothing else is drawn — no text (names, addresses,
 * port names and tags, chips, group titles), no port mark, no cable,
 * relation or membership line, no other box and no indicator already
 * placed. The scene is read once (bounding boxes in the drawing's own
 * coordinates; lines as points along them, a few pixels apart) into a grid,
 * kept while the drawing stays the same (a state change only places the
 * indicators again), so placing hundreds of indicators stays cheap. Nothing is moved: when no
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

/** The drawing's obstacles, read once per drawn scene (its nodes layer is new whenever the diagram is drawn again). */
const BASES = new WeakMap<Element, Map<string, Box[]>>();
/** The groups' frames (their edges), per drawn scene: avoided where possible, crossed when nothing else is free. */
const FRAMES = new WeakMap<Element, Map<string, Box[]>>();

export class StatusPlacer {
  /** the drawing's obstacles (shared by every placer of the same drawn scene) */
  private grid: Map<string, Box[]>;
  /** what this placer placed */
  private placed = new Map<string, Box[]>();
  /** the groups' frame edges (soft: see findBeside) */
  private frames: Map<string, Box[]>;

  /** A placer for a drawn scene: its obstacles read once and kept while the drawing stays the same. */
  static for(scene: Element): StatusPlacer {
    const key = scene.querySelector(':scope > .layer-nodes') || scene;
    let base = BASES.get(key);
    if (!base) {
      base = StatusPlacer.read(scene);
      BASES.set(key, base);
    }
    let frames = FRAMES.get(key);
    if (!frames) {
      frames = StatusPlacer.readFrames(scene);
      FRAMES.set(key, frames);
    }
    return new StatusPlacer(base, frames);
  }

  private constructor(base: Map<string, Box[]>, frames: Map<string, Box[]>) {
    this.grid = base;
    this.frames = frames;
  }

  /** The groups' frames: their four edges each. */
  private static readFrames(scene: Element): Map<string, Box[]> {
    const grid = new Map<string, Box[]>();
    const frames = scene.querySelectorAll('.layer-groups rect');
    for (let i = 0; i < frames.length; i++) {
      let r: DOMRect;
      try {
        r = (frames[i] as SVGGraphicsElement).getBBox();
      } catch (err) {
        continue;
      }
      if (!(r.width > 0 && r.height > 0)) continue;
      for (const b of [
        { x: r.x - 1, y: r.y - 1, w: r.width + 2, h: 2 },
        { x: r.x - 1, y: r.y + r.height - 1, w: r.width + 2, h: 2 },
        { x: r.x - 1, y: r.y - 1, w: 2, h: r.height + 2 },
        { x: r.x + r.width - 1, y: r.y - 1, w: 2, h: r.height + 2 },
      ])
        StatusPlacer.into(grid, b);
    }
    return grid;
  }

  /** Does a place cross a group's frame? */
  private onFrame(r: Box): boolean {
    for (let cx = Math.floor(r.x / CELL); cx <= Math.floor((r.x + r.w) / CELL); cx++) {
      for (let cy = Math.floor(r.y / CELL); cy <= Math.floor((r.y + r.h) / CELL); cy++) {
        for (const b of this.frames.get(cx + ',' + cy) || []) if (r.x < b.x + b.w && b.x < r.x + r.w && r.y < b.y + b.h && b.y < r.y + r.h) return true;
      }
    }
    return false;
  }

  private static read(scene: Element): Map<string, Box[]> {
    const grid = new Map<string, Box[]>();
    const add = (b: Box): void => StatusPlacer.into(grid, b);
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
      if (r) add({ x: r.x, y: r.y, w: r.width, h: r.height });
    }
    // the other boxes (a device's own box may carry its indicator)
    const boxes = scene.querySelectorAll('.dev-box, .net-box, .vbar-box, .pg-box, .lg-box');
    for (let i = 0; i < boxes.length; i++) {
      const r = bbox(boxes[i]);
      if (r) add({ x: r.x, y: r.y, w: r.width, h: r.height, owner: boxes[i] as SVGGraphicsElement });
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
          add({ x: pt.x - 2, y: pt.y - 2, w: 4, h: 4 });
        }
      }
    }
    return grid;
  }

  private static into(grid: Map<string, Box[]>, b: Box): void {
    for (let cx = Math.floor(b.x / CELL); cx <= Math.floor((b.x + b.w) / CELL); cx++) {
      for (let cy = Math.floor(b.y / CELL); cy <= Math.floor((b.y + b.h) / CELL); cy++) {
        const k = cx + ',' + cy;
        const list = grid.get(k);
        if (list) list.push(b);
        else grid.set(k, [b]);
      }
    }
  }

  private add(b: Box): void {
    StatusPlacer.into(this.placed, b);
  }

  private free(r: Box, own: DOMRect): boolean {
    for (let cx = Math.floor(r.x / CELL); cx <= Math.floor((r.x + r.w) / CELL); cx++) {
      for (let cy = Math.floor(r.y / CELL); cy <= Math.floor((r.y + r.h) / CELL); cy++) {
        const list = (this.grid.get(cx + ',' + cy) || []).concat(this.placed.get(cx + ',' + cy) || []);
        for (const b of list) {
          if (b.owner && Math.abs(b.x - own.x) < 0.5 && Math.abs(b.y - own.y) < 0.5 && Math.abs(b.w - own.width) < 0.5) continue;
          if (r.x < b.x + b.w && b.x < r.x + r.w && r.y < b.y + b.h && b.y < r.y + r.h) return false;
        }
      }
    }
    return true;
  }

  /** A place for an indicator w × h on a box's edge (taken: nothing else goes there afterwards). */
  find(own: DOMRect, w: number, h: number): { x: number; y: number; edge: 'top' | 'bottom' | 'above' | 'below' | 'none' } {
    const right = own.x + own.width - w - 10;
    const left = Math.min(right, own.x + 10);
    // on its top edge, its bottom edge; else just above or below the box (still beside it, its own)
    const rows: Array<['top' | 'bottom' | 'above' | 'below', number]> = [
      ['top', own.y - h / 2],
      ['bottom', own.y + own.height - h / 2],
      ['above', own.y - h - 3],
      ['below', own.y + own.height + 3],
    ];
    for (const [edge, y] of rows) {
      // on an edge: within the box's width; above or below: as far as half its width beyond either end
      const hi = edge === 'top' || edge === 'bottom' ? right : own.x + own.width - w / 2;
      const lo = edge === 'top' || edge === 'bottom' ? left : own.x - w / 2;
      for (let x = hi; x >= lo - 0.01; x -= STEP) {
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

  /** Take a given place for an indicator of a box when nothing is there (true: taken). */
  take(r: { x: number; y: number; w: number; h: number }, own: DOMRect): boolean {
    const pad = { x: r.x - GAP, y: r.y - VGAP, w: r.w + 2 * GAP, h: r.h + 2 * VGAP };
    if (!this.free(pad, own) || this.onFrame(pad)) return false;
    this.add(r);
    return true;
  }

  /**
   * A place for a block w × h beside a box (a stack of badges, too tall for
   * its edge): to its right, its left, below or above it, as close as
   * nothing is in the way (taken: nothing else goes there afterwards). The
   * same drawing gives the same place, so a block whose size stays the same
   * never moves.
   */
  findBeside(own: DOMRect, w: number, h: number): { x: number; y: number; side: 'right' | 'left' | 'below' | 'above' | 'none' } {
    const tries: Array<['right' | 'left' | 'below' | 'above', Array<{ x: number; y: number }>]> = [];
    const ys: number[] = [];
    for (let y = own.y; y <= own.y + Math.max(0, own.height - h) + 0.01; y += STEP) ys.push(y);
    for (let y = own.y - STEP; y >= own.y - h + 0.01; y -= STEP) ys.push(y);
    const xs = (lo: number, hi: number): number[] => {
      const out: number[] = [];
      for (let x = lo; x <= hi + 0.01; x += STEP) out.push(x);
      return out;
    };
    tries.push(['right', ys.map((y) => ({ x: own.x + own.width + 4, y }))]);
    tries.push(['left', ys.map((y) => ({ x: own.x - w - 4, y }))]);
    // below or above: under its own box (from its left edge to its right one), never reaching under a neighbour's
    const lo = Math.min(own.x, own.x + own.width - w);
    const hi = Math.max(own.x, own.x + own.width - w);
    tries.push(['below', xs(lo, hi).map((x) => ({ x, y: own.y + own.height + 4 }))]);
    tries.push(['above', xs(lo, hi).map((x) => ({ x, y: own.y - h - 4 }))]);
    // clear of the groups' frames first; else across one (its badges are opaque), still clear of everything else
    for (const soft of [true, false]) {
      for (const [side, at] of tries) {
        for (const { x, y } of at) {
          const pad = { x: x - GAP, y: y - VGAP, w: w + 2 * GAP, h: h + 2 * VGAP };
          if (this.free(pad, own) && !(soft && this.onFrame(pad))) {
            this.add({ x, y, w, h });
            return { x, y, side };
          }
        }
      }
    }
    const r = { x: own.x + own.width + 4, y: own.y, w, h };
    this.add(r);
    return { x: r.x, y: r.y, side: 'none' };
  }
}
