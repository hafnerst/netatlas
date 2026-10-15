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
import { Box, BoxIndex, candidates, placeLabel } from './sim-labels';

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

export class SimAnimator {
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
    if (this.dots && this.dots.parentNode) this.dots.parentNode.removeChild(this.dots);
    if (this.labels && this.labels.parentNode) this.labels.parentNode.removeChild(this.labels);
    this.dots = this.labels = null;
    this.scene = null;
    this.last = null;
  }

  /** Draw the hops as the pacing places them now. */
  draw(items: DrawItem[], opts: DrawOptions): DrawResult {
    this.last = { items, opts };
    if (!this.scene || !this.dots || !this.labels) return { drawn: 0, left: 0, senders: [], receivers: [] };
    while (this.dots.firstChild) this.dots.removeChild(this.dots.firstChild);
    while (this.labels.firstChild) this.labels.removeChild(this.labels.firstChild);
    const r = this.paint(this.dots, this.labels, items, opts, opts.reduce, true);
    this.mark(r.senders, r.receivers);
    return r;
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
    // a Send test's hops first (their labels always find room), then the earliest: what started first keeps its place
    const list = items.filter((it) => it.f.view === opts.view).sort((a, b) => Number(!!b.test) - Number(!!a.test) || a.f.t0 - b.f.t0 || a.f.id - b.f.id);
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
      const name = (it.test ? 'Test · ' : '') + f.label;
      const text = lost ? `✕ lost: ${name}` : name + (f.encap && f.encap.length ? ` ‹${f.encap.slice().reverse().join(' in ')}›` : '');
      const w = textWidth(text, FONT) + 4;
      const h = FONT + 4;
      let box = placeLabel(candidates(p.x, p.y, p.ux, p.uy, w, h, 1), this.obstacles, placed);
      for (let k = 1; !box && k < fracs.length; k++) {
        const q = at(geo, fracs[k]);
        box = placeLabel(candidates(q.x, q.y, q.ux, q.uy, w, h, 1), this.obstacles, placed);
        if (box) p = q;
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
        shape.setAttribute('data-cast', cast);
      }
      const lab = box ? label(this.doc, text, box, lost, color) : null;
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
