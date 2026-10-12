/**
 * The traffic animation (Simulate → Traffic): dots that move along the
 * drawn lines of the flows of analysis/traffic.ts, in the view on screen,
 * in the direction the traffic flows. Only in simulation mode.
 *
 *   * The dots run in a layer of their own above the cables and relations
 *     and below every device box and label, so they never cover an address
 *     or a label, and never move a node or change the layout.
 *   * requestAnimationFrame drives them; they stop while the page is hidden
 *     and while paused. At most MAX_DOTS move at once: demands go first,
 *     control traffic gets what is left (a large model shows fewer dots,
 *     never a slower page).
 *   * Under prefers-reduced-motion (and in exported pictures) static arrows
 *     show the direction instead of moving dots.
 *   * A reroute is shown for a moment: the old way faded and dashed, the
 *     new one emphasized. Traffic that is lost gets a marker (✕) at the
 *     last device it reaches.
 *
 * The animation carries no information of its own: the Simulation tab lists
 * the flows, their paths and every change as text.
 */
import { Flow, Track, TrafficChange, TrafficState } from '../analysis/traffic';

/** At most this many dots move at once. */
export const MAX_DOTS = 300;
/** How fast a dot moves, in diagram units per second. */
const SPEED = 85;
/** How long a reroute is shown (old way faded, new way emphasized), in ms. */
export const REROUTE_MS = 4000;
const SVG = 'http://www.w3.org/2000/svg';

/** A drawn line found for a track: the path element and which way along it the traffic goes. */
interface Geo {
  path: SVGPathElement;
  len: number;
  /** +1: along the path's own direction; -1: against it */
  dir: 1 | -1;
}

interface Emitter {
  flow: Flow;
  geo: Geo;
  every: number;
  next: number;
}

interface Dot {
  em: Emitter;
  born: number;
  el: SVGCircleElement;
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
  // a relation: a hub spoke (device → hub), or the lane between two devices
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

const pointAt = (g: Geo, s: number): DOMPoint => g.path.getPointAtLength(g.dir > 0 ? s : g.len - s);

export interface TrafficOptions {
  view: 'physical' | 'logical';
  /** prefers-reduced-motion: arrows instead of moving dots */
  reduce: boolean;
}

export class TrafficAnimator {
  private state: TrafficState | null = null;
  private changes: TrafficChange[] = [];
  private changedAt = 0;
  private scene: Element | null = null;
  private layer: SVGGElement | null = null;
  private emitters: Emitter[] = [];
  private dots: Dot[] = [];
  private raf = 0;
  private last = 0;
  private paused = false;
  private reduce = false;
  private view: 'physical' | 'logical' = 'physical';
  private key = '';
  private overlayTimer: number | null = null;
  /** how many flows got fewer dots than their rate asks for (the dot limit), last frame */
  limited = 0;

  constructor(private doc: Document) {
    doc.addEventListener('visibilitychange', () => this.schedule());
  }

  private win(): Window | null {
    return this.doc.defaultView;
  }

  /**
   * Show these flows (null: none) in a scene, with the changes from the step
   * before (a new step: shown for a moment). Called after every render; does
   * nothing when nothing changed.
   */
  sync(scene: Element | null, state: TrafficState | null, changes: TrafficChange[], opts: TrafficOptions, stepKey: string): void {
    const key = `${stepKey}|${opts.view}|${opts.reduce}`;
    const sceneChanged = scene !== this.scene || !this.layer || !this.layer.isConnected;
    if (key === this.key && !sceneChanged && state === this.state) return;
    const newStep = stepKey !== this.key.split('|')[0];
    this.key = key;
    this.state = state;
    this.view = opts.view;
    this.reduce = opts.reduce;
    if (newStep) {
      this.changes = changes;
      this.changedAt = Date.now();
    }
    this.scene = scene;
    this.build();
  }

  /** Stop and remove everything (no simulation, or traffic switched off). */
  clear(): void {
    this.state = null;
    this.key = '';
    if (this.layer && this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
    this.layer = null;
    this.emitters = [];
    this.dots = [];
    this.stop();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.schedule();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** How many dots move now (for tests and the tab's note). */
  dotCount(): number {
    return this.dots.length;
  }

  /** The layer: after the lines, before the boxes (physical: after the cables; logical: after relations and next-hop lines). */
  private ensureLayer(): SVGGElement | null {
    const scene = this.scene;
    if (!scene) return null;
    if (this.layer && this.layer.isConnected && scene.contains(this.layer)) return this.layer;
    const g = this.doc.createElementNS(SVG, 'g') as SVGGElement;
    g.setAttribute('class', 'layer-traffic');
    g.setAttribute('aria-hidden', 'true');
    const before = scene.querySelector(':scope > .layer-nodes');
    if (before) scene.insertBefore(g, before);
    else scene.appendChild(g);
    this.layer = g;
    return g;
  }

  private build(): void {
    const layer = this.ensureLayer();
    this.emitters = [];
    this.dots = [];
    if (!layer) return;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const st = this.state;
    if (!st || !this.scene) {
      this.stop();
      return;
    }
    const scene = this.scene;
    const now = performance.now();
    // the reroute overlay: the old way faded, the new way emphasized, for a moment
    const recent = Date.now() - this.changedAt < REROUTE_MS;
    if (recent) {
      for (const c of this.changes) {
        if (c.kind !== 'rerouted') continue;
        const tracks = (side: { logical: Track[]; physical: Track[] }): Track[] => (this.view === 'physical' ? side.physical : side.logical);
        for (const t of tracks(c.before)) this.overlay(layer, scene, t, 'traffic-old');
        for (const t of tracks(c.after)) this.overlay(layer, scene, t, 'traffic-new');
      }
      if (this.overlayTimer !== null && this.win()) (this.win() as Window).clearTimeout(this.overlayTimer);
      const left = REROUTE_MS - (Date.now() - this.changedAt);
      if (this.win())
        this.overlayTimer = (this.win() as Window).setTimeout(() => {
          this.overlayTimer = null;
          const ls = this.layer ? this.layer.querySelectorAll('.traffic-old, .traffic-new') : [];
          for (let i = 0; i < ls.length; i++) ls[i].parentNode!.removeChild(ls[i]);
        }, left);
    }
    // lost traffic: a marker at the last device reached
    const stops = new Set<string>();
    for (const f of st.flows) if (f.state === 'lost' && f.stop && f.stop.device) stops.add(f.stop.device);
    for (const d of Array.from(stops).sort()) this.lostMark(layer, scene, d, st.flows.filter((f) => f.state === 'lost' && f.stop && f.stop.device === d));
    // the emitters: one per flow and drawn line; under reduced motion, an arrow each instead
    const seen = new Set<string>();
    for (const f of st.flows) {
      if (f.state !== 'up') continue;
      for (const t of this.view === 'physical' ? f.physical : f.logical) {
        const geo = findTrack(scene, t);
        if (!geo) continue;
        if (this.reduce) {
          const k = `${t.ref}|${geo.dir}|${f.kind}`;
          if (seen.has(k)) continue;
          seen.add(k);
          layer.appendChild(arrowAt(this.doc, geo, f.kind));
          continue;
        }
        const every = 1 / f.rate;
        // the first dots start spread over the line, so it never looks empty
        const em: Emitter = { flow: f, geo, every, next: now };
        this.emitters.push(em);
        // (within the limit as well: demands come first, they are first in the list)
        const n = Math.min(4, Math.floor(geo.len / SPEED / every));
        for (let i = 1; i <= n && this.dots.length < MAX_DOTS; i++) this.spawn(em, now - i * every * 1000);
      }
    }
    this.schedule();
  }

  private overlay(layer: SVGGElement, scene: Element, t: Track, cls: string): void {
    const geo = findTrack(scene, t);
    if (!geo) return;
    const p = this.doc.createElementNS(SVG, 'path');
    p.setAttribute('class', cls);
    p.setAttribute('d', geo.path.getAttribute('d') || '');
    layer.insertBefore(p, layer.firstChild);
  }

  private lostMark(layer: SVGGElement, scene: Element, device: string, flows: Flow[]): void {
    const box = scene.querySelector(`g.node[data-ref="device:${cssEsc(device)}"]`) as SVGGraphicsElement | null;
    if (!box || typeof box.getBBox !== 'function') return;
    const b = box.getBBox();
    const g = this.doc.createElementNS(SVG, 'g');
    g.setAttribute('class', 'traffic-lost');
    g.setAttribute('data-device', device);
    const c = this.doc.createElementNS(SVG, 'circle');
    c.setAttribute('cx', String(Math.round(b.x + b.width)));
    c.setAttribute('cy', String(Math.round(b.y)));
    c.setAttribute('r', '9');
    const t = this.doc.createElementNS(SVG, 'text');
    t.setAttribute('x', String(Math.round(b.x + b.width)));
    t.setAttribute('y', String(Math.round(b.y) + 4));
    t.setAttribute('text-anchor', 'middle');
    t.textContent = '✕';
    const title = this.doc.createElementNS(SVG, 'title');
    title.textContent = `Traffic lost here: ${flows.map((f) => f.label).join(', ')}`;
    g.appendChild(title);
    g.appendChild(c);
    g.appendChild(t);
    layer.appendChild(g);
  }

  private spawn(em: Emitter, born: number): void {
    const el = this.doc.createElementNS(SVG, 'circle') as SVGCircleElement;
    el.setAttribute('class', `traffic-dot ${em.flow.kind}`);
    el.setAttribute('r', em.flow.kind === 'demand' ? '3.4' : '2.3');
    (this.layer as SVGGElement).appendChild(el);
    const d: Dot = { em, born, el };
    this.dots.push(d);
    this.place(d, performance.now());
  }

  private place(d: Dot, now: number): boolean {
    const s = ((now - d.born) / 1000) * SPEED;
    if (s > d.em.geo.len) return false;
    const p = pointAt(d.em.geo, Math.max(0, s));
    d.el.setAttribute('cx', p.x.toFixed(1));
    d.el.setAttribute('cy', p.y.toFixed(1));
    return true;
  }

  private running(): boolean {
    return !this.paused && !this.reduce && this.emitters.length > 0 && this.doc.visibilityState !== 'hidden' && !!this.layer && this.layer.isConnected;
  }

  private schedule(): void {
    const w = this.win();
    if (!w) return;
    if (!this.running()) {
      this.stop();
      return;
    }
    if (this.raf) return;
    this.last = performance.now();
    // spawning starts again where it was (no burst after a pause)
    for (const e of this.emitters) e.next = Math.max(e.next, this.last);
    this.raf = w.requestAnimationFrame((t) => this.frame(t));
  }

  private stop(): void {
    const w = this.win();
    if (this.raf && w) w.cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame(now: number): void {
    this.raf = 0;
    if (!this.running()) return;
    const dt = now - this.last;
    this.last = now;
    // a paused or hidden page: the dots continue from where they were
    if (dt > 250) for (const d of this.dots) d.born += dt;
    // move, and drop the dots at the end of their line
    this.dots = this.dots.filter((d) => {
      if (this.place(d, now)) return true;
      d.el.parentNode && d.el.parentNode.removeChild(d.el);
      return false;
    });
    // new dots: demands first, then control traffic, while under the limit
    let limited = 0;
    for (const e of this.emitters) {
      if (e.next > now) continue;
      if (this.dots.length >= MAX_DOTS) {
        limited++;
        e.next = now + e.every * 1000;
        continue;
      }
      this.spawn(e, now);
      e.next += e.every * 1000;
      if (e.next < now) e.next = now + e.every * 1000;
    }
    this.limited = limited;
    this.schedule();
  }

  /** A static picture of the traffic for an export: an arrow per drawn line and direction (and the lost markers). */
  exportLayer(): SVGGElement | null {
    if (!this.state || !this.scene) return null;
    const g = this.doc.createElementNS(SVG, 'g') as SVGGElement;
    g.setAttribute('class', 'layer-traffic');
    const seen = new Set<string>();
    for (const f of this.state.flows) {
      if (f.state !== 'up') continue;
      for (const t of this.view === 'physical' ? f.physical : f.logical) {
        const geo = findTrack(this.scene, t);
        if (!geo) continue;
        const k = `${t.ref}|${geo.dir}|${f.kind}`;
        if (seen.has(k)) continue;
        seen.add(k);
        g.appendChild(arrowAt(this.doc, geo, f.kind));
      }
    }
    if (this.layer) {
      const marks = this.layer.querySelectorAll('.traffic-lost');
      for (let i = 0; i < marks.length; i++) g.appendChild(marks[i].cloneNode(true));
    }
    return g;
  }
}

/** An arrow in the middle of a line (a demand's a little before it, so the two never sit on each other), pointing the way the traffic goes. */
function arrowAt(doc: Document, geo: Geo, kind: 'control' | 'demand'): SVGPathElement {
  const at = geo.len * (kind === 'demand' ? 0.42 : 0.58);
  const a = pointAt(geo, Math.max(0, at - 4));
  const b = pointAt(geo, Math.min(geo.len, at + 4));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const L = kind === 'demand' ? 10 : 7;
  const W = kind === 'demand' ? 5 : 3.5;
  const tip = { x: (a.x + b.x) / 2 + (ux * L) / 2, y: (a.y + b.y) / 2 + (uy * L) / 2 };
  const bx = tip.x - ux * L;
  const by = tip.y - uy * L;
  const p = doc.createElementNS(SVG, 'path') as SVGPathElement;
  p.setAttribute('class', `traffic-arrow ${kind}`);
  p.setAttribute('d', `M${tip.x.toFixed(1)} ${tip.y.toFixed(1)}L${(bx - uy * W).toFixed(1)} ${(by + ux * W).toFixed(1)}L${(bx + uy * W).toFixed(1)} ${(by - ux * W).toFixed(1)}Z`);
  return p;
}
