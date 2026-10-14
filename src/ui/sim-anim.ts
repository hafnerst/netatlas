/**
 * The protocol simulation in the diagram: a dot per message in flight
 * (analysis/sim: one per cable in the physical view, per relation or
 * network line in the logical view), moving the way the message goes, with
 * a label "protocol message" beside it. Both directions of a line have
 * their own lane; frames on a cable are spaced out over time (the
 * engine), and labels are placed where they touch no text, device
 * box or other label (sim-labels.ts); a dot whose label has no place, and
 * the dots beyond MAX_DOTS, are not drawn (the window says how many; the
 * event log has them all). The dots sit above the lines and below the
 * boxes; the labels above everything, with a halo. Nothing here changes
 * the model or the layout.
 *
 * Reduced motion and exports: no moving dots, a static arrow with its
 * label for every message in flight at that moment. A message lost to a
 * failure is marked ✕ where it was lost, for a moment.
 */
import { textWidth } from '../layout/geometry';
import { Flight, Track } from '../analysis/sim/types';
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
  t: number;
  /** is a flight's protocol shown (the window's checkboxes) */
  shown: (f: Flight) => boolean;
  /** static arrows instead of moving dots */
  reduce: boolean;
  color: (protocol: string) => string;
}

export interface DrawResult {
  /** dots drawn */
  drawn: number;
  /** dots of shown protocols not drawn (the limit, or no place for their label) */
  left: number;
}

export class SimAnimator {
  private scene: Element | null = null;
  private dots: SVGGElement | null = null;
  private labels: SVGGElement | null = null;
  private obstacles: BoxIndex = new BoxIndex();
  private last: { flights: Flight[]; opts: DrawOptions } | null = null;

  constructor(private doc: Document) {}

  /** A new scene (after every render): the layers again, and what labels must avoid. */
  setScene(scene: Element | null): void {
    if (scene === this.scene && this.dots && this.dots.isConnected) return;
    this.scene = scene;
    this.dots = this.labels = null;
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
    if (this.dots && this.dots.parentNode) this.dots.parentNode.removeChild(this.dots);
    if (this.labels && this.labels.parentNode) this.labels.parentNode.removeChild(this.labels);
    this.dots = this.labels = null;
    this.scene = null;
    this.last = null;
  }

  /** Draw the flights at a moment. */
  draw(flights: Flight[], opts: DrawOptions): DrawResult {
    this.last = { flights, opts };
    if (!this.scene || !this.dots || !this.labels) return { drawn: 0, left: 0 };
    while (this.dots.firstChild) this.dots.removeChild(this.dots.firstChild);
    while (this.labels.firstChild) this.labels.removeChild(this.labels.firstChild);
    return this.paint(this.dots, this.labels, flights, opts, opts.reduce);
  }

  /** A static picture of what is in flight now, for an export (arrows with labels; the lost marks). */
  exportLayer(): SVGGElement | null {
    if (!this.last || !this.scene) return null;
    const g = this.doc.createElementNS(SVG, 'g') as SVGGElement;
    g.setAttribute('class', 'layer-sim');
    const labels = this.doc.createElementNS(SVG, 'g') as SVGGElement;
    this.paint(g, labels, this.last.flights, this.last.opts, true);
    g.appendChild(labels);
    return g;
  }

  private paint(dots: SVGGElement, labels: SVGGElement, flights: Flight[], opts: DrawOptions, arrows: boolean): DrawResult {
    const scene = this.scene as Element;
    const placed = new BoxIndex();
    let drawn = 0;
    let left = 0;
    // the earliest first: what started first keeps its place
    const list = flights.filter((f) => f.view === opts.view && opts.shown(f)).sort((a, b) => a.t0 - b.t0 || a.id - b.id);
    for (const f of list) {
      const lost = f.dropped !== undefined && opts.t >= f.dropped;
      if (!lost && (opts.t < f.t0 || opts.t > f.t1)) continue;
      if (drawn >= MAX_DOTS) {
        left++;
        continue;
      }
      const geo = findTrack(scene, f.track);
      if (!geo) continue;
      const frac = lost ? ((f.dropped as number) - f.t0) / Math.max(1, f.t1 - f.t0 || 1) : arrows ? 0.5 : (opts.t - f.t0) / Math.max(1, f.t1 - f.t0);
      const p = at(geo, lost ? Math.min(1, frac) : frac);
      const text = lost ? `✕ lost: ${f.label}` : f.label + (f.encap && f.encap.length ? ` ‹${f.encap.slice().reverse().join(' in ')}›` : '');
      const w = textWidth(text, FONT) + 4;
      const h = FONT + 4;
      const side: 1 | -1 = 1;
      const box = placeLabel(candidates(p.x, p.y, p.ux, p.uy, w, h, side), this.obstacles, placed);
      if (!box) {
        left++;
        continue;
      }
      placed.add(box);
      drawn++;
      const color = opts.color(f.protocol);
      if (lost) dots.appendChild(lostMark(this.doc, p.x, p.y));
      else if (arrows) dots.appendChild(arrow(this.doc, p, color));
      else {
        const c = this.doc.createElementNS(SVG, 'circle');
        c.setAttribute('class', 'sim-dot');
        c.setAttribute('cx', p.x.toFixed(1));
        c.setAttribute('cy', p.y.toFixed(1));
        c.setAttribute('r', '4');
        c.setAttribute('fill', color);
        dots.appendChild(c);
      }
      labels.appendChild(label(this.doc, text, box, lost, color));
    }
    return { drawn, left };
  }
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

function arrow(doc: Document, p: { x: number; y: number; ux: number; uy: number }, color: string): SVGPathElement {
  const L = 9;
  const W = 4.5;
  const tip = { x: p.x + (p.ux * L) / 2, y: p.y + (p.uy * L) / 2 };
  const bx = tip.x - p.ux * L;
  const by = tip.y - p.uy * L;
  const a = doc.createElementNS(SVG, 'path') as SVGPathElement;
  a.setAttribute('class', 'sim-arrow');
  a.setAttribute('fill', color);
  a.setAttribute('d', `M${tip.x.toFixed(1)} ${tip.y.toFixed(1)}L${(bx - p.uy * W).toFixed(1)} ${(by + p.ux * W).toFixed(1)}L${(bx + p.uy * W).toFixed(1)} ${(by - p.ux * W).toFixed(1)}Z`);
  return a;
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
