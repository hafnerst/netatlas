/**
 * The protocol simulation in the diagram: a dot per message hop on screen
 * (analysis/sim: one per cable in the physical view, per relation or
 * network line in the logical view), where the pacing (analysis/sim/
 * pacing.ts) says it is: fading in at its sender, travelling its whole way
 * with its label "protocol message" beside it, crossing a switch between
 * two cables, and a short pulse at its receiver; the devices sending and
 * receiving are marked for that moment. Both directions of a line have
 * their own lane; labels are placed where they touch no text, device box
 * or other label (sim-labels.ts), so they never overlap: a dot whose label
 * has no room for a moment goes on without it until it has. At most
 * MAX_DOTS hops are on screen (the panel says how many more there are;
 * the event log has them all). The dots sit above the lines and below the
 * boxes; the labels above everything, with a halo. Following a message:
 * its hops draw a trail, the others are faint. Nothing here changes the
 * model or the layout.
 *
 * Reduced motion and exports: no moving dots, a still arrow with its label
 * for every message on screen, for as long as the pacing shows it (where
 * its label finds room: its middle first). A message lost to a failure is
 * marked ✕ where it was lost, for about a second.
 *
 * A dot's shape says how its frame is addressed: a circle unicast, a
 * square broadcast, a diamond multicast (an arrow's tail the same). A dot
 * can be clicked: the packet inspector shows its frame layer by layer
 * (the event log's messages offer the same from the keyboard).
 */
import { textWidth } from '../layout/geometry';
import { Flight, Track } from '../analysis/sim/types';
import type { PaceState } from '../analysis/sim/pacing';
import { Box, BoxIndex, candidates, placeIndex, placeLabel } from './sim-labels';
import { Activity } from '../analysis/sim/pacing';

/** At most this many dots (with their labels) are drawn at once. */
export const MAX_DOTS = 48;
const SVG = 'http://www.w3.org/2000/svg';
const LANE = 4;
const FONT = 10;

interface Geo {
  path: SVGPathElement;
  len: number;
  dir: 1 | -1;
}

const cssEsc = (s: string): string => s.replace(/["\\]/g, '\\$&');

/** The drawn line of a track in a scene (null: not drawn in this view, e.g. filtered out). */
export function findTrack(scene: Element, t: Track): Geo | null {
  const ref = cssEsc(t.ref);
  const pick = (sel: string, dir: 1 | -1): Geo | null => {
    const p = scene.querySelector(sel) as SVGPathElement | null;
    if (!p || typeof p.getTotalLength !== 'function') return null;
    const len = p.getTotalLength();
    return len > 1 ? { path: p, len, dir } : null;
  };
  // a virtual link (a vNIC or veth to its virtual switch or network): its wire in the host's box, drawn from the guest's end (b)
  // (a VM restarted on another member: its link there has the same wire, "@host" left out)
  if (t.ref.indexOf('link:~') === 0) return pick(`path.vwire[data-link="${cssEsc(t.ref.slice(5).replace(/@[^@~]*$/, ''))}"]`, t.from === 'b' ? 1 : -1);
  if (t.ref.indexOf('link:') === 0) return pick(`g.cable[data-ref="${ref}"] path.cable-line`, t.from === 'a' ? 1 : -1);
  if (t.ref.indexOf('network:') === 0) {
    if (t.to === 'net') return pick(`path.member[data-ref="${ref}"][data-member="${cssEsc(t.from)}"]`, 1);
    return pick(`path.member[data-ref="${ref}"][data-member="${cssEsc(t.to)}"]`, -1);
  }
  const stroke = ':not(.hit):not(.tube-inner):not(.arrow)';
  if (t.to === 'hub') return pick(`g.hub-rel[data-ref="${ref}"] path[data-spoke="${cssEsc(t.from)}"]${stroke}`, 1);
  if (t.from === 'hub') return pick(`g.hub-rel[data-ref="${ref}"] path[data-spoke="${cssEsc(t.to)}"]${stroke}`, -1);
  const g = scene.querySelector(`g.rel[data-ref="${ref}"][data-from]`);
  if (!g) return null;
  const dir: 1 | -1 = g.getAttribute('data-from') === t.from ? 1 : -1;
  const p = g.querySelector(`path${stroke}`) as SVGPathElement | null;
  if (!p || typeof p.getTotalLength !== 'function') return null;
  const len = p.getTotalLength();
  return len > 1 ? { path: p, len, dir } : null;
}

/** A point at a fraction of a track, its direction, and the lane's offset. */
function at(g: Geo, f: number): { x: number; y: number; ux: number; uy: number } {
  const s = Math.max(0, Math.min(1, f)) * g.len;
  const a = g.path.getPointAtLength(g.dir > 0 ? s : g.len - s);
  const b = g.path.getPointAtLength(Math.max(0, Math.min(g.len, g.dir > 0 ? s + 2 : g.len - s - 2)));
  let ux = b.x - a.x;
  let uy = b.y - a.y;
  const d = Math.hypot(ux, uy) || 1;
  ux /= d;
  uy /= d;
  // each direction its own lane: to the right of the way it goes
  return { x: a.x - uy * LANE, y: a.y + ux * LANE, ux, uy };
}

export interface DrawOptions {
  view: 'physical' | 'logical';
  /** static arrows instead of moving dots (reduced motion) */
  reduce: boolean;
  color: (protocol: string) => string;
  /** cables (relations) with traffic not drawn as dots, lately: lit, with a short count ("OSPF ×3") */
  activity?: Activity[];
  /** a protocol's short name for those counts */
  name?: (protocol: string) => string;
}

/** A hop to draw: its flight, where the pacing says it is, and how it is marked. */
export interface DrawItem {
  f: Flight;
  st: PaceState;
  /** the cable it continues from (the crossing of a switch) */
  prev?: Track;
  /** someone else's conversation is followed: drawn faint */
  faded?: boolean;
  /** of the conversation followed: drawn with its trail */
  followed?: boolean;
  /** of a Send test: its label says "Test", its label is placed first */
  test?: boolean;
  /** the scenario's while Network events hold the front: drawn grey, moving, with a short grey label of its kind where there is room, not a hit target */
  bg?: boolean;
}

export interface DrawResult {
  /** dots drawn */
  drawn: number;
  /** dots not drawn (no place for their label) */
  left: number;
  /** the devices sending (a dot just left them) and receiving (a dot just arrived) */
  senders: string[];
  receivers: string[];
}

/** Where a track starts and ends: its two devices where it has them (a cable's ends, a relation's devices; not a network or a hub). */
export type TrackEnds = (t: Track) => { from: string | null; to: string | null };

/** A packet's hit area around its dot, in screen pixels (whatever the zoom): its radius, at least this. */
export const HIT_PX = 12;

/** A dot drawn this frame (diagram coordinates), for hit testing. */
interface DotAt {
  id: number;
  x: number;
  y: number;
}

/**
 * The packet a point is on: the nearest dot within the hit radius (`px` screen pixels at zoom `k`),
 * ties to the lower flight id (the earlier message); null none.
 */
export function nearestDot(dots: DotAt[], x: number, y: number, k: number, px = HIT_PX): DotAt | null {
  const r = px / Math.max(k, 1e-6);
  let best: DotAt | null = null;
  let bd = Infinity;
  for (const d of dots) {
    const dist = Math.hypot(d.x - x, d.y - y);
    if (dist > r) continue;
    if (dist < bd - 1e-9 || (Math.abs(dist - bd) <= 1e-9 && best && d.id < best.id)) {
      best = d;
      bd = dist;
    }
  }
  return best;
}

export class SimAnimator {
  /** the dots of the last frame on screen, and the pointer (diagram coordinates, the zoom) when it is over the diagram */
  private hits: DotAt[] = [];
  private pointer: { x: number; y: number; k: number } | null = null;
  private halo: SVGGElement | null = null;
  /** the packet the pointer is on (its flight), null none */
  hovered: number | null = null;
  private scene: Element | null = null;
  private dots: SVGGElement | null = null;
  private labels: SVGGElement | null = null;
  private obstacles: BoxIndex = new BoxIndex();
  private last: { items: DrawItem[]; opts: DrawOptions } | null = null;
  /** the device nodes marked as sending or receiving */
  private marked: Element[] = [];

  constructor(
    private doc: Document,
    private ends?: TrackEnds,
  ) {}

  /** A new scene (after every render): the layers again, and what labels must avoid. */
  setScene(scene: Element | null): void {
    if (scene === this.scene && this.dots && this.dots.isConnected) return;
    this.scene = scene;
    this.dots = this.labels = null;
    this.marked = [];
    this.obstacles = new BoxIndex();
    if (!scene) return;
    const texts = scene.querySelectorAll('text, .node > rect');
    for (let i = 0; i < texts.length; i++) {
      const e = texts[i] as SVGGraphicsElement;
      if (typeof e.getBBox !== 'function') continue;
      try {
        const b = e.getBBox();
        if (b.width > 0 && b.height > 0) this.obstacles.add({ x: b.x, y: b.y, w: b.width, h: b.height });
      } catch (err) {
        /* not rendered */
      }
    }
    const dots = this.doc.createElementNS(SVG, 'g') as SVGGElement;
    dots.setAttribute('class', 'layer-sim');
    dots.setAttribute('aria-hidden', 'true');
    const before = scene.querySelector(':scope > .layer-nodes');
    if (before) scene.insertBefore(dots, before);
    else scene.appendChild(dots);
    const labels = this.doc.createElementNS(SVG, 'g') as SVGGElement;
    labels.setAttribute('class', 'layer-sim-labels');
    labels.setAttribute('aria-hidden', 'true');
    scene.appendChild(labels);
    this.dots = dots;
    this.labels = labels;
  }

  clear(): void {
    this.mark([], []);
    this.hits = [];
    this.hovered = null;
    this.halo = null;
    if (this.dots && this.dots.parentNode) this.dots.parentNode.removeChild(this.dots);
    if (this.labels && this.labels.parentNode) this.labels.parentNode.removeChild(this.labels);
    this.dots = this.labels = null;
    this.scene = null;
    this.last = null;
  }

  /**
   * A moving dot's label place, by flight: the candidate (side and distance
   * from its dot) it got when it appeared, kept for the rest of its way.
   */
  private slots = new Map<number, number>();
  /** the background dot that carries the short label of its cable and kind, while it is on its way */
  private bgOwners = new Map<string, number>();

  /** The label place of a moving dot: the one it got when it appeared (the first free one then, else the first), kept since. */
  private slotOf(id: number, cands: Box[], placed: BoxIndex, marks: BoxIndex): number {
    let s = this.slots.get(id);
    if (s === undefined) {
      s = Math.max(0, placeIndex(cands, this.obstacles, placed, marks));
      this.slots.set(id, s);
    }
    return s;
  }

  /** the indicators' boxes, read again only when their layer is redrawn */
  private markCache: { layer: Element | null; boxes: BoxIndex } = { layer: null, boxes: new BoxIndex() };

  /** The boxes of the simulation's indicators on the diagram (statuses, querier marks, snooping badges): labels keep clear of them. */
  private markBoxes(): BoxIndex {
    const layer = this.scene ? this.scene.querySelector(':scope > .layer-sim-power') : null;
    if (layer === this.markCache.layer) return this.markCache.boxes;
    const boxes = new BoxIndex();
    if (layer) {
      const rs = layer.querySelectorAll('rect');
      for (let i = 0; i < rs.length; i++) {
        try {
          const b = (rs[i] as SVGGraphicsElement).getBBox();
          if (b.width > 0 && b.height > 0) boxes.add({ x: b.x, y: b.y, w: b.width, h: b.height });
        } catch (err) {
          /* not rendered */
        }
      }
    }
    this.markCache = { layer, boxes };
    return boxes;
  }

  /** Draw the hops as the pacing places them now. */
  draw(items: DrawItem[], opts: DrawOptions): DrawResult {
    this.last = { items, opts };
    if (!this.scene || !this.dots || !this.labels) return { drawn: 0, left: 0, senders: [], receivers: [] };
    while (this.dots.firstChild) this.dots.removeChild(this.dots.firstChild);
    while (this.labels.firstChild) this.labels.removeChild(this.labels.firstChild);
    this.hits = [];
    this.halo = null;
    const r = this.paint(this.dots, this.labels, items, opts, opts.reduce, true);
    this.mark(r.senders, r.receivers);
    this.drawHover();
    return r;
  }

  /** The pointer moved over the diagram (diagram coordinates, the zoom), or left it (null): the packet it is on, outlined. */
  pointerAt(p: { x: number; y: number; k: number } | null): number | null {
    this.pointer = p;
    this.drawHover();
    return this.hovered;
  }

  /** The packet at a point (diagram coordinates, the zoom): as the hover outline shows it. */
  flightAt(x: number, y: number, k: number): number | null {
    const d = nearestDot(this.hits, x, y, k);
    return d ? d.id : null;
  }

  /** Where a packet's dot is drawn now (diagram coordinates), null when it isn't. */
  dotOf(id: number): { x: number; y: number } | null {
    const d = this.hits.find((x) => x.id === id);
    return d ? { x: d.x, y: d.y } : null;
  }

  /**
   * The outline of the packet under the pointer: a ring around its dot, light and dark (both themes,
   * not by colour alone), sized in screen pixels; it moves nothing and catches no pointer.
   */
  private drawHover(): void {
    if (this.halo && this.halo.parentNode) this.halo.parentNode.removeChild(this.halo);
    this.halo = null;
    const p = this.pointer;
    const d = p ? nearestDot(this.hits, p.x, p.y, p.k) : null;
    this.hovered = d ? d.id : null;
    // (the whole canvas shows the hand: the hit area reaches beyond the dot)
    const svg = this.scene ? (this.scene as SVGGraphicsElement).ownerSVGElement || this.scene : null;
    if (svg) svg.classList.toggle('sim-dot-hover', !!d);
    if (!d || !p || !this.dots) return;
    const g = this.doc.createElementNS(SVG, 'g') as SVGGElement;
    g.setAttribute('class', 'sim-hit');
    g.setAttribute('data-hover', String(d.id));
    const r = (HIT_PX * 0.75) / p.k;
    for (const cls of ['sim-hit-under', 'sim-hit-ring']) {
      const c = this.doc.createElementNS(SVG, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', d.x.toFixed(1));
      c.setAttribute('cy', d.y.toFixed(1));
      c.setAttribute('r', r.toFixed(2));
      c.setAttribute('stroke-width', ((cls === 'sim-hit-under' ? 4 : 2) / p.k).toFixed(2));
      g.appendChild(c);
    }
    this.dots.appendChild(g);
    this.halo = g;
  }

  /** A static picture of what is on its way now, for an export: arrows where the dots are, with labels; the lost marks. */
  exportLayer(): SVGGElement | null {
    if (!this.last || !this.scene) return null;
    const g = this.doc.createElementNS(SVG, 'g') as SVGGElement;
    g.setAttribute('class', 'layer-sim');
    const labels = this.doc.createElementNS(SVG, 'g') as SVGGElement;
    this.paint(g, labels, this.last.items, this.last.opts, true, false);
    g.appendChild(labels);
    return g;
  }

  /** Mark the sending and receiving devices in the diagram (screen only: an export removes the marks). */
  private mark(senders: string[], receivers: string[]): void {
    for (const n of this.marked) n.classList.remove('sim-tx', 'sim-rx');
    this.marked = [];
    if (!this.scene) return;
    const add = (dev: string, cls: string): void => {
      const n = (this.scene as Element).querySelector(`.node[data-ref="device:${cssEsc(dev)}"]`);
      if (!n) return;
      n.classList.add(cls);
      this.marked.push(n);
    };
    for (const d of senders) add(d, 'sim-tx');
    for (const d of receivers) add(d, 'sim-rx');
  }

  /** the label place of each cable's activity (its ref): the side it got first, kept while the cable's geometry stays */
  private actSlots = new Map<string, { geom: string; slot: number }>();

  /**
   * Cable activity: each cable (relation, network line) with traffic not drawn as dots lately is lit
   * along its way, in its busiest protocol's colour, with a short count ("OSPF ×3 · ARP ×1") where a
   * label finds room. It never moves and holds nothing: a sign of what the scenario does meanwhile.
   *
   * It stands for the cable, not for a direction: its lane is that of the drawn line's own direction
   * (never of the hop that happened to be counted first, which alternates with two-way traffic), and its
   * label keeps the side it got when the cable lit up — chosen again only when the cable's geometry
   * changes (a device dragged, another view).
   */
  private paintActivity(dots: SVGGElement, labels: SVGGElement, opts: DrawOptions, placed: BoxIndex): void {
    const scene = this.scene as Element;
    const name = opts.name || ((p: string): string => p);
    const lit = new Set<string>();
    for (const a of opts.activity || []) {
      if (a.view !== opts.view || !a.counts.length) continue;
      const found = findTrack(scene, a.track);
      if (!found) continue;
      const geo: Geo = { path: found.path, len: found.len, dir: 1 };
      lit.add(a.ref);
      const color = opts.color(a.counts[0][0]);
      const path = trail(this.doc, geo, 1, color);
      path.setAttribute('class', 'sim-activity');
      path.setAttribute('data-activity', a.ref);
      dots.appendChild(path);
      const text = a.counts.slice(0, 2).map(([p, n]) => `${name(p)} ×${n}`).join(' · ') + (a.counts.length > 2 ? ` +${a.counts.length - 2}` : '');
      const p = at(geo, 0.5);
      const w = textWidth(text, FONT) + 4;
      const cands = candidates(p.x, p.y, p.ux, p.uy, w, FONT + 4, 1);
      const start = at(geo, 0);
      const end = at(geo, 1);
      const geom = `${a.view}|${Math.round(start.x)},${Math.round(start.y)}|${Math.round(end.x)},${Math.round(end.y)}|${Math.round(geo.len)}`;
      let slot = this.actSlots.get(a.ref);
      if (!slot || slot.geom !== geom) {
        const k = placeIndex(cands, this.obstacles, placed);
        // (no free place: no label this time, and the choice is made again next time)
        if (k < 0) continue;
        slot = { geom, slot: k };
        this.actSlots.set(a.ref, slot);
      }
      const box = cands[slot.slot];
      if (!box) continue;
      placed.add(box);
      const lab = label(this.doc, text, box, false, color);
      lab.classList.add('sim-activity-label');
      lab.setAttribute('data-activity', a.ref);
      labels.appendChild(lab);
    }
    // a cable that is dark again chooses its label's side afresh when it lights up next time
    for (const ref of Array.from(this.actSlots.keys())) if (!lit.has(ref)) this.actSlots.delete(ref);
  }

  private paint(dots: SVGGElement, labels: SVGGElement, items: DrawItem[], opts: DrawOptions, arrows: boolean, live: boolean): DrawResult {
    const scene = this.scene as Element;
    const placed = new BoxIndex();
    let drawn = 0;
    let left = 0;
    const senders = new Set<string>();
    const receivers = new Set<string>();
    // the trails of the conversation followed, under the dots
    if (live) {
      for (const it of items) {
        if (!it.followed || it.f.view !== opts.view || it.st.phase === 'waiting' || it.st.phase === 'gone' || it.st.phase === 'transit') continue;
        const geo = findTrack(scene, it.f.track);
        if (geo) dots.appendChild(trail(this.doc, geo, it.st.frac, opts.color(it.f.protocol)));
      }
    }
    // cable activity: the traffic not drawn as dots (bundled, or the background while a Network event runs), lit under the dots
    if (live && opts.activity) this.paintActivity(dots, labels, opts, placed);
    // a Send test's hops first (their labels always find room), then the earliest: what started first keeps its place
    // (the background's short labels after every label of the foreground: they take only the room left)
    const list = items.filter((it) => it.f.view === opts.view).sort((a, b) => Number(!!a.bg) - Number(!!b.bg) || Number(!!b.test) - Number(!!a.test) || a.f.t0 - b.f.t0 || a.f.id - b.f.id);
    // the indicators drawn on the diagram during the simulation (statuses, querier marks, snooping badges): no label over them
    const marks = this.markBoxes();
    const bgLabelled = new Set<string>();
    // the dots on their way now (a label place is kept for these; the others' are forgotten)
    const moving = new Set<number>();
    for (const it of list) if (it.st.phase === 'moving' || it.st.phase === 'transit') moving.add(it.f.id);
    if (live && !arrows) {
      for (const id of Array.from(this.slots.keys())) if (!moving.has(id)) this.slots.delete(id);
      for (const [k, id] of Array.from(this.bgOwners)) if (!moving.has(id)) this.bgOwners.delete(k);
    }
    for (const it of list) {
      const f = it.f;
      const st = it.st;
      if (st.phase === 'waiting' || st.phase === 'gone') continue;
      const geo = findTrack(scene, f.track);
      if (!geo) continue;
      const color = opts.color(f.protocol);
      const ends = this.ends ? this.ends(f.track) : { from: null, to: null };
      if (st.phase === 'arrived') {
        // the arrival pulse at the receiver (no label: the message has arrived)
        if (ends.to) receivers.add(ends.to);
        if (live && !arrows) {
          const p = at(geo, 1);
          dots.appendChild(pulse(this.doc, p.x, p.y, color, st.pulse));
        }
        continue;
      }
      const lost = st.phase === 'lost';
      // a still arrow (reduced motion) stands where its label finds room: the middle first
      const fracs = arrows && !lost && live ? [0.5, 0.35, 0.65, 0.2, 0.8] : [st.frac];
      let p = at(geo, fracs[0]);
      if (st.phase === 'transit' && it.prev && !arrows) {
        // across the switch: from where the cable before it ended to where this one starts
        const g0 = findTrack(scene, it.prev);
        if (g0) {
          const a = at(g0, 1);
          const b = at(geo, 0);
          p = { x: a.x + (b.x - a.x) * st.cross, y: a.y + (b.y - a.y) * st.cross, ux: b.ux, uy: b.uy };
        }
      }
      if (st.phase === 'moving' && st.frac < 0.25 && ends.from) senders.add(ends.from);
      if (st.phase === 'transit' && ends.from) senders.add(ends.from);
      // the background: a grey dot on its way, nothing to point at (the log has it), with a short grey label of its kind —
      // one per cable and kind (the earliest), and only where it touches no other label, text, box or indicator
      if (it.bg) {
        if (lost) continue;
        const shape = arrows ? arrow(this.doc, p, color, f.cast || 'unicast') : dot(this.doc, p.x, p.y, color, f.cast || 'unicast');
        shape.classList.add('sim-bg');
        shape.setAttribute('aria-hidden', 'true');
        // (under the foreground's dots)
        dots.insertBefore(shape, dots.firstChild);
        drawn++;
        const kind = bgKind(f.protocol, f.label, f.flags);
        const k = f.track.ref + '|' + kind;
        // one dot of a cable and kind carries the label while it is on its way (then the next one): it never hops between dots
        const owner = this.bgOwners.get(k);
        if (live && (owner === undefined || !moving.has(owner))) this.bgOwners.set(k, f.id);
        const mine = live ? this.bgOwners.get(k) === f.id : !bgLabelled.has(k);
        if (mine && !bgLabelled.has(k) && st.phase === 'moving') {
          bgLabelled.add(k);
          const bw = textWidth(kind, BG_FONT) + 4;
          const bh = BG_FONT + 4;
          const cands = candidates(p.x, p.y, p.ux, p.uy, bw, bh, 1);
          // moving: the place it got when it appeared, kept (it may pass over something for a moment); still: where it touches nothing
          const bbox = live && !arrows ? cands[this.slotOf(f.id, cands, placed, marks)] : placeLabel(cands, this.obstacles, placed, marks);
          if (bbox) {
            placed.add(bbox);
            const lab = label(this.doc, kind, bbox, false, 'none');
            if (live && !arrows) {
              lab.setAttribute('data-for', String(f.id));
              lab.setAttribute('data-slot', String(this.slots.get(f.id)));
            }
            lab.setAttribute('class', 'sim-bg-label');
            lab.setAttribute('aria-hidden', 'true');
            labels.insertBefore(lab, labels.firstChild);
          }
        }
        continue;
      }
      const name = (it.test ? 'Test · ' : '') + f.label;
      const text = lost ? `✕ lost: ${name}` : name + (f.encap && f.encap.length ? ` ‹${f.encap.slice().reverse().join(' in ')}›` : '');
      const w = textWidth(text, FONT) + 4;
      const h = FONT + 4;
      let box: Box | null;
      if (live && !arrows && !lost) {
        // a moving dot: its label where it got its place when it appeared, at the same side and distance all the way —
        // it moves with the dot and may pass over a text, a box or another label for a moment, never jumping away from it
        const cands = candidates(p.x, p.y, p.ux, p.uy, w, h, 1);
        box = cands[this.slotOf(f.id, cands, placed, marks)];
      } else {
        box = placeLabel(candidates(p.x, p.y, p.ux, p.uy, w, h, 1), this.obstacles, placed, marks);
        for (let k = 1; !box && k < fracs.length; k++) {
          const q = at(geo, fracs[k]);
          box = placeLabel(candidates(q.x, q.y, q.ux, q.uy, w, h, 1), this.obstacles, placed, marks);
          if (box) p = q;
        }
      }
      // a moving dot stays on its way even where its label has no room for a moment (the label comes back with room)
      if (!box && (arrows || lost)) {
        left++;
        continue;
      }
      if (box) placed.add(box);
      drawn++;
      const cast = f.cast || 'unicast';
      const fade = live && !arrows && st.alpha < 1 ? st.alpha : 1;
      let shape: SVGElement;
      if (lost) shape = lostMark(this.doc, p.x, p.y);
      else {
        shape = arrows ? arrow(this.doc, p, color, cast) : dot(this.doc, p.x, p.y, color, cast);
        shape.setAttribute('data-flight', String(f.id));
        if (live) this.hits.push({ id: f.id, x: p.x, y: p.y });
        shape.setAttribute('data-cast', cast);
      }
      const lab = box ? label(this.doc, text, box, lost, color) : null;
      // (whose label it is and the place it keeps: for the tests and the reader of the SVG; no hit target)
      if (lab && live && !arrows && !lost) {
        lab.setAttribute('data-for', String(f.id));
        lab.setAttribute('data-slot', String(this.slots.get(f.id)));
      }
      for (const e of lab ? [shape, lab] : [shape]) {
        if (it.faded) e.classList.add('faded');
        if (it.followed) e.classList.add('followed');
        if (it.test) e.classList.add('sim-test');
        if (fade < 1) e.setAttribute('opacity', fade.toFixed(2));
      }
      dots.appendChild(shape);
      if (lab) labels.appendChild(lab);
    }
    return { drawn, left, senders: Array.from(senders), receivers: Array.from(receivers) };
  }
}

/** a background label's font size */
const BG_FONT = 8.5;

/**
 * A background message's kind in a word or two, for its short grey label:
 * the protocol, with the message type where it tells the kind apart (IGMP
 * Query / Report / Leave, OSPF Hello …); a multicast stream's datagrams are
 * UDP. Never addresses or interfaces (the inspector and the log have them).
 */
export function bgKind(protocol: string, label: string, flags?: string): string {
  const name = BG_NAMES[protocol] || protocol.toUpperCase().slice(0, 10);
  // a TCP segment (of whatever protocol): its flags, from its header
  if (flags !== undefined) return `${name} ${flags}`;
  const m = /\b(Query|Report|Leave|Hello|Join|Prune|Register|Request|Reply|Discover|Offer|Ack|Update|Keepalive|BPDU)\b/.exec(label);
  const type = m ? m[1] : '';
  if (protocol === 'igmp' || protocol === 'mld' || protocol === 'pim' || protocol === 'ospf' || protocol === 'bgp' || protocol === 'stp' || protocol === 'bfd') return type ? `${name} ${type}` : name;
  return name;
}

const BG_NAMES: { [p: string]: string } = { mqtt: 'MQTT', mcast: 'UDP', igmp: 'IGMP', mld: 'MLD', arp: 'ARP', garp: 'ARP', ndp: 'NDP', dhcp: 'DHCP', dhcpv6: 'DHCPv6', dns: 'DNS', icmp: 'ICMP', tcp: 'TCP', udp: 'UDP', ospf: 'OSPF', bgp: 'BGP', pim: 'PIM', stp: 'STP', lacp: 'LACP', lldp: 'LLDP', bfd: 'BFD', vrrp: 'VRRP', demand: 'Traffic', https: 'HTTPS', http: 'HTTP' };

/** The way a followed message has come along a track so far. */

function trail(doc: Document, g: Geo, frac: number, color: string): SVGPathElement {
  const n = Math.max(2, Math.ceil(g.len / 12));
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const p = at(g, (i / n) * Math.max(0, Math.min(1, frac)));
    pts.push(`${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  }
  const path = doc.createElementNS(SVG, 'path') as SVGPathElement;
  path.setAttribute('class', 'sim-trail');
  path.setAttribute('d', 'M' + pts.join('L'));
  path.setAttribute('stroke', color);
  return path;
}

/** The arrival pulse: a ring that grows and fades. */
function pulse(doc: Document, x: number, y: number, color: string, k: number): SVGCircleElement {
  const c = doc.createElementNS(SVG, 'circle') as SVGCircleElement;
  c.setAttribute('class', 'sim-pulse');
  c.setAttribute('cx', x.toFixed(1));
  c.setAttribute('cy', y.toFixed(1));
  c.setAttribute('r', (4 + 10 * k).toFixed(1));
  c.setAttribute('stroke', color);
  c.setAttribute('opacity', (1 - k).toFixed(2));
  return c;
}

function label(doc: Document, text: string, b: Box, lost: boolean, color: string): SVGGElement {
  const g = doc.createElementNS(SVG, 'g') as SVGGElement;
  g.setAttribute('class', 'sim-label' + (lost ? ' lost' : ''));
  const r = doc.createElementNS(SVG, 'rect');
  r.setAttribute('x', b.x.toFixed(1));
  r.setAttribute('y', b.y.toFixed(1));
  r.setAttribute('width', b.w.toFixed(1));
  r.setAttribute('height', b.h.toFixed(1));
  r.setAttribute('rx', '3');
  r.setAttribute('stroke', color);
  const t = doc.createElementNS(SVG, 'text');
  t.setAttribute('x', (b.x + 2).toFixed(1));
  t.setAttribute('y', (b.y + b.h - 4).toFixed(1));
  t.textContent = text;
  g.appendChild(r);
  g.appendChild(t);
  return g;
}

/** A dot: a circle (unicast), a square (broadcast) or a diamond (multicast). */
export function dot(doc: Document, x: number, y: number, color: string, cast: string): SVGElement {
  if (cast === 'unicast') {
    const c = doc.createElementNS(SVG, 'circle');
    c.setAttribute('class', 'sim-dot');
    c.setAttribute('cx', x.toFixed(1));
    c.setAttribute('cy', y.toFixed(1));
    c.setAttribute('r', '4');
    c.setAttribute('fill', color);
    return c;
  }
  const s = cast === 'broadcast' ? 4 : 5.5;
  const d = cast === 'broadcast' ? `M${(x - s).toFixed(1)} ${(y - s).toFixed(1)}h${2 * s}v${2 * s}h${-2 * s}Z` : `M${x.toFixed(1)} ${(y - s).toFixed(1)}l${s} ${s}l${-s} ${s}l${-s} ${-s}Z`;
  const p = doc.createElementNS(SVG, 'path');
  p.setAttribute('class', 'sim-dot');
  p.setAttribute('d', d);
  p.setAttribute('fill', color);
  return p;
}

function arrow(doc: Document, p: { x: number; y: number; ux: number; uy: number }, color: string, cast: string): SVGElement {
  const L = 9;
  const W = 4.5;
  const tip = { x: p.x + (p.ux * L) / 2, y: p.y + (p.uy * L) / 2 };
  const bx = tip.x - p.ux * L;
  const by = tip.y - p.uy * L;
  const a = doc.createElementNS(SVG, 'path') as SVGPathElement;
  a.setAttribute('class', 'sim-arrow');
  a.setAttribute('fill', color);
  a.setAttribute('d', `M${tip.x.toFixed(1)} ${tip.y.toFixed(1)}L${(bx - p.uy * W).toFixed(1)} ${(by + p.ux * W).toFixed(1)}L${(bx + p.uy * W).toFixed(1)} ${(by - p.ux * W).toFixed(1)}Z`);
  if (cast === 'unicast') return a;
  // a broadcast's or multicast's arrow carries its dot's shape at its tail
  const g = doc.createElementNS(SVG, 'g');
  g.setAttribute('class', 'sim-arrow-cast');
  g.appendChild(a);
  const tail = dot(doc, bx - p.ux * 3, by - p.uy * 3, color, cast);
  tail.setAttribute('class', 'sim-arrow-tail');
  g.appendChild(tail);
  return g;
}

function lostMark(doc: Document, x: number, y: number): SVGGElement {
  const g = doc.createElementNS(SVG, 'g') as SVGGElement;
  g.setAttribute('class', 'sim-lost');
  const c = doc.createElementNS(SVG, 'circle');
  c.setAttribute('cx', x.toFixed(1));
  c.setAttribute('cy', y.toFixed(1));
  c.setAttribute('r', '6');
  const t = doc.createElementNS(SVG, 'path');
  t.setAttribute('d', `M${(x - 3).toFixed(1)} ${(y - 3).toFixed(1)}l6 6m0-6l-6 6`);
  g.appendChild(c);
  g.appendChild(t);
  return g;
}
