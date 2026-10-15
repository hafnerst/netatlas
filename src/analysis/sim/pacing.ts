/**
 * Pacing: how the protocol simulation is shown over time, so that every
 * message can be followed on its whole way. DOM-free (the browser draws
 * what it says; tests drive it in Node).
 *
 * The display clock. It runs with real time × the speed (0.25× … 4×).
 * Every message hop (a flight: one cable in the physical view, a relation
 * or a network line in the logical view) gets its own stretch of it:
 *
 *   - Readable (the default): about 1 s per hop, longer for a slower link
 *     and shorter for a faster one, relative to the model's typical hop
 *     (1 s × (1 + 0.6 · log10(latency ÷ typical)), clamped to 0.6–3 s), so
 *     a WAN link visibly takes longer than a LAN cable and every message
 *     stays readable;
 *   - Proportional: the hop's simulated time × a scale ("1 ms = 1 s"), at
 *     least 0.2 s and at most 30 s.
 *
 * A hop starts when its frame is sent, or, when it continues a hop that is
 * still on screen (the next cable after a switch, the second half of a
 * network line), when that one has arrived; between two cables of a
 * switch it first crosses the switch (0.25 s).
 *
 * The simulated clock follows the display, never the other way round: it
 * may run up to (but not past) the moment the first message on screen
 * arrives, so that nothing it would cause happens before its dot gets
 * there; meanwhile it moves through that message's simulated time in step
 * with its dot. With nothing on screen it jumps to the next message that
 * will be shown ("skip idle time", on by default; the jump is reported),
 * or, with skipping off, runs at the speed (1 s of simulated time per
 * second at 1×). Only how far the simulation has got at a moment depends
 * on this, never what happens or in which order: the engine runs the same
 * events whatever the pacing (tests compare the results).
 *
 * Following a message: its conversation (the message and its replies: an
 * ARP request and its reply, a ping and its echo, a TCP connection's
 * segments; the same protocol between the same two ends) alone holds the
 * clock back; the others still show but no longer hold it.
 *
 * At most `limit` hops are on screen at once (with their labels); one
 * beyond the limit is not drawn and does not hold the clock (the event log
 * lists it; `notDrawn` counts them for a note).
 */
import { Flight, Headers } from './types';

export type PaceMode = 'readable' | 'proportional';

export const PACE_SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];
/** Proportional: display ms per simulated ms ("1 ms = 0.1 s", "1 ms = 1 s", "1 ms = 10 s"). */
export const PACE_SCALES: readonly number[] = [100, 1000, 10000];
/** Readable: the time of a typical hop, and the clamps (display ms at 1×). */
export const HOP_MS = 1000;
export const HOP_MIN = 600;
export const HOP_MAX = 3000;
/** Proportional: the shortest and the longest hop shown. */
export const PROP_MIN = 200;
export const PROP_MAX = 30000;
/** A lost message's ✕ stays this long. */
export const LOST_MS = 1000;
/** The arrival pulse at the receiver, and the fade-in at the sender. */
export const PULSE_MS = 450;
export const FADE_MS = 200;
/** Through a switch between two cables. */
export const TRANSIT_MS = 250;
/** A skipped idle stretch is reported when it is at least this long (simulated ms). */
export const SKIP_REPORT = 500;
/** The longest jump at once (simulated ms: 10 min); when it finds nothing to show, the next one waits IDLE_REST of display time. */
export const IDLE_HORIZON = 600000;
export const IDLE_REST = 1000;

const EPS = 1e-6;

/** Readable: the display time of a hop of `lat` ms where a typical hop takes `ref` ms. */
export function readableHop(lat: number, ref: number): number {
  const x = lat > 0 && ref > 0 ? lat / ref : 1;
  return Math.max(HOP_MIN, Math.min(HOP_MAX, HOP_MS * (1 + 0.6 * Math.log10(x))));
}

/** Proportional: `scale` display ms per simulated ms, within the bounds. */
export function proportionalHop(lat: number, scale: number): number {
  return Math.max(PROP_MIN, Math.min(PROP_MAX, lat * scale));
}

/** "1 ms = 1 s", "1 ms = 0.1 s". */
export function scaleText(scale: number): string {
  const s = scale / 1000;
  return `1 ms = ${s >= 1 ? s : s.toFixed(1)} s`;
}

/** What a message belongs to: its protocol and its two ends, either way round (a request and its reply share it). */
export function conversationKey(protocol: string, h: Headers | undefined, label: string): string {
  const pair = (a: string, b: string): string => (a < b ? a + '|' + b : b + '|' + a);
  if (!h) return protocol + '|' + label;
  if (h.arp) return 'arp|' + pair(h.arp.senderIp, h.arp.targetIp);
  const ip = h.l3.length ? h.l3[h.l3.length - 1] : null;
  if (ip && h.l4 && (h.l4.proto === 'tcp' || h.l4.proto === 'udp')) {
    const l4 = h.l4 as { proto: string; src?: number; dst?: number };
    return `${h.l4.proto}|${pair(ip.src + ':' + (l4.src || ''), ip.dst + ':' + (l4.dst || ''))}`;
  }
  if (ip) return `${protocol}|${pair(ip.src, ip.dst)}`;
  return `${protocol}|${pair(h.l2.src, h.l2.dst)}`;
}

/** One hop on screen. */
export interface PaceItem {
  f: Flight;
  /** the hop's simulated time as sent (a later loss shortens the flight's own t1) */
  lat: number;
  /** display clock: shown from (the crossing of a switch first, then the cable) */
  d0: number;
  /** the crossing before the cable (0: none) */
  transit: number;
  /** the time of the hop itself */
  hop: number;
  /** drawn (within the limit) */
  drawn: boolean;
  /** its conversation (Follow message) */
  key: string;
  /** the hop it continues, while that is on screen */
  parent?: PaceItem;
}

/** Where a hop is on screen at a moment. */
export interface PaceState {
  phase: 'waiting' | 'transit' | 'moving' | 'lost' | 'arrived' | 'gone';
  /** along the cable or relation, 0 … 1 (lost: where it was lost) */
  frac: number;
  /** across the switch, 0 … 1 (transit) */
  cross: number;
  /** fade-in, 0 … 1 */
  alpha: number;
  /** the arrival pulse, 0 … 1 (arrived) */
  pulse: number;
}

export interface PacerHost {
  /** the simulation's clock and events */
  engine: {
    now: number;
    nextTime(): number | null;
    runUntil(t: number, stop: () => boolean): void;
    run(t: number): void;
    readonly flightSerial: number;
    flightsSince(serial: number): Flight[];
  };
  /** is a flight one whose dot is drawn (its view, a protocol shown) */
  shown(f: Flight): boolean;
  /** a typical hop's simulated time in a view (ms) */
  typical(view: Flight['view']): number;
  /** a flight's headers (the conversation key) */
  headers?(f: Flight): Headers | undefined;
}

export class Pacer {
  mode: PaceMode = 'readable';
  speed = 1;
  /** proportional: display ms per simulated ms */
  scale = 1000;
  skipIdle = true;
  /** the display clock (ms at 1×) */
  clock = 0;
  /** the hops shown, in the order they were sent */
  items: PaceItem[] = [];
  /** the last idle stretch skipped (simulated ms) and when (display clock) */
  skipped: { ms: number; at: number } | null = null;
  /** the conversation followed */
  follow: { key: string; label: string } | null = null;
  /** hops not drawn since the start (more than `limit` at once) */
  notDrawn = 0;
  private byId = new Map<number, PaceItem>();
  private serial: number;
  private idleBudget = 0;
  /** no idle jump before this (display clock): the last one found nothing to show */
  private restUntil = -Infinity;

  constructor(
    private host: PacerHost,
    public limit = 48,
  ) {
    this.serial = host.engine.flightSerial;
  }

  /** "Readable · 1 s per hop · 1×", "Proportional · 1 ms = 1 s · 2×". */
  describe(): string {
    const sp = `${this.speed}×`;
    return this.mode === 'readable' ? `Readable · ${HOP_MS / 1000} s per hop · ${sp}` : `Proportional · ${scaleText(this.scale)} · ${sp}`;
  }

  /** The display time of a hop of `lat` simulated ms in a view. */
  hopTime(lat: number, view: Flight['view']): number {
    return this.mode === 'readable' ? readableHop(lat, this.host.typical(view)) : proportionalHop(lat, this.scale);
  }

  find(id: number): PaceItem | undefined {
    return this.byId.get(id);
  }

  /** The display clock reaches a hop's far end (or where it is lost). */
  arrival(it: PaceItem): number {
    const f = it.f;
    const frac = f.dropped !== undefined ? this.lostAt(it) : 1;
    return it.d0 + it.transit + it.hop * frac;
  }

  /** The display clock at which a hop is gone from the screen. */
  end(it: PaceItem): number {
    return this.arrival(it) + (it.f.dropped !== undefined ? LOST_MS : PULSE_MS);
  }

  private lostAt(it: PaceItem): number {
    const f = it.f;
    return it.lat > 0 ? Math.max(0, Math.min(1, ((f.dropped as number) - f.t0) / it.lat)) : 1;
  }

  /** Where a hop is now. */
  state(it: PaceItem, at = this.clock): PaceState {
    const s: PaceState = { phase: 'waiting', frac: 0, cross: 0, alpha: 0, pulse: 0 };
    if (it.f.hidden || at < it.d0) return s;
    s.alpha = Math.min(1, (at - it.d0) / FADE_MS);
    if (at < it.d0 + it.transit) {
      s.phase = 'transit';
      s.cross = (at - it.d0) / it.transit;
      return s;
    }
    // (the same boundary as onItsWay: at its arrival it has arrived)
    const arr = this.arrival(it);
    if (it.f.dropped !== undefined && at >= arr - EPS) {
      s.frac = this.lostAt(it);
      s.phase = at < this.end(it) ? 'lost' : 'gone';
      return s;
    }
    if (at < arr - EPS) {
      s.phase = 'moving';
      s.frac = it.hop > 0 ? Math.max(0, Math.min(1, (at - it.d0 - it.transit) / it.hop)) : 1;
      return s;
    }
    s.frac = 1;
    s.alpha = 1;
    const p = (at - this.arrival(it)) / PULSE_MS;
    s.phase = p < 1 ? 'arrived' : 'gone';
    s.pulse = Math.min(1, p);
    return s;
  }

  /** Does this hop hold the simulated clock back (drawn, shown, of the conversation followed if any)? */
  private holds(it: PaceItem): boolean {
    return this.drawnShown(it) && (!this.follow || it.key === this.follow.key);
  }

  private drawnShown(it: PaceItem): boolean {
    return it.drawn && !it.f.hidden && this.host.shown(it.f);
  }

  /** Is a hop still on its way on screen (before its arrival)? */
  private onItsWay(it: PaceItem): boolean {
    return this.clock < this.arrival(it) - EPS;
  }

  /** The simulated time the clock must stay below: the earliest arrival of what is on its way on screen (Infinity: nothing). */
  gate(): { t: number; item: PaceItem | null } {
    let t = Infinity;
    let item: PaceItem | null = null;
    for (const it of this.items) {
      if (!this.holds(it) || !this.onItsWay(it)) continue;
      const g = it.f.dropped !== undefined ? (it.f.dropped as number) : it.f.t0 + it.lat;
      if (g < t) {
        t = g;
        item = it;
      }
    }
    return { t, item };
  }

  /** Is anything on its way that holds the clock? */
  busy(): boolean {
    return this.gate().item !== null;
  }

  /** Take in the flights sent since the last look. */
  private register(): void {
    const e = this.host.engine;
    const fresh = e.flightsSince(this.serial).reverse();
    this.serial = e.flightSerial;
    for (const f of fresh) {
      if (this.byId.has(f.id)) continue;
      // a creation-time loss puts the flight's end where it was lost: midway
      const lat = f.dropped !== undefined && f.dropped > f.t0 ? 2 * (f.dropped - f.t0) : Math.max(0, f.t1 - f.t0);
      // what arrived before the display saw it (a jump of the tests, runTo) is history: not drawn
      if ((f.dropped !== undefined ? f.dropped : f.t0 + lat) < e.now - EPS) continue;
      const parent = f.parent !== undefined ? this.byId.get(f.parent) : undefined;
      const after = parent ? this.arrival(parent) : -Infinity;
      const d0 = Math.max(this.clock, after);
      // between two cables: across the switch that forwarded it
      const transit = parent && f.view === 'physical' && parent.f.view === 'physical' && parent.f.track.ref !== f.track.ref ? TRANSIT_MS : 0;
      const live = this.items.filter((x) => x.drawn && x.f.view === f.view && this.clock < this.end(x)).length;
      const drawn = live < this.limit;
      if (!drawn && this.host.shown(f)) this.notDrawn++;
      const h = this.host.headers ? this.host.headers(f) : undefined;
      const it: PaceItem = { f, lat, d0, transit, hop: this.hopTime(lat, f.view), drawn, key: conversationKey(f.protocol, h, f.label), parent };
      this.items.push(it);
      this.byId.set(f.id, it);
    }
  }

  /** Forget what has left the screen. */
  private prune(): void {
    const keep: PaceItem[] = [];
    for (const it of this.items) {
      if (this.clock < this.end(it) + EPS) keep.push(it);
      else this.byId.delete(it.f.id);
    }
    this.items = keep;
  }

  /** Real time passed (ms): the display moves on, and the simulation as far as it lets it. */
  frame(wallMs: number): void {
    const d = Math.max(0, wallMs) * this.speed;
    this.clock += d;
    this.idleBudget += d;
    this.pump();
    this.prune();
  }

  /**
   * Run the simulation as far as the display allows: up to the first
   * arrival on screen, through it in step with its dot; with nothing on
   * screen to the next message shown (skipping) or at the speed.
   */
  pump(): void {
    const e = this.host.engine;
    this.register();
    for (let guard = 0; guard < 400; guard++) {
      const g = this.gate();
      if (g.item) {
        this.idleBudget = 0;
        // the clock moves through the most urgent hop in step with its dot, never to its arrival
        const it = g.item;
        const st = this.state(it);
        const p = st.phase === 'moving' ? st.frac : 0;
        const target = Math.min(it.f.t0 + p * it.lat, g.t - EPS);
        if (target <= e.now) return;
        let moved = false;
        e.runUntil(target, () => {
          this.register();
          // a hop sent meanwhile that arrives sooner sets the pace from now on
          moved = this.gate().t < g.t;
          return moved;
        });
        this.register();
        if (!moved) return;
        continue;
      }
      // idle: nothing on screen holds the clock
      const from = e.now;
      if (this.skipIdle) {
        if (this.clock < this.restUntil) return;
        this.advance(from + IDLE_HORIZON);
        if (e.now - from >= SKIP_REPORT) this.skipped = { ms: e.now - from, at: this.clock };
        if (!this.items.some((it) => this.drawnShown(it) && this.onItsWay(it))) this.restUntil = this.clock + IDLE_REST;
        // (following: what shows now is not of the conversation; it is seen at its own pace)
        return;
      }
      if (this.idleBudget <= EPS) return;
      this.advance(from + this.idleBudget);
      this.idleBudget = Math.max(0, this.idleBudget - (e.now - from));
      if (!this.busy()) return;
    }
  }

  /** Run towards t, stopping at the first moment a hop is sent that is drawn (followed or not: the next thing to see). */
  private advance(t: number): void {
    const e = this.host.engine;
    const shownNow = (): boolean => this.items.some((it) => this.drawnShown(it) && this.onItsWay(it));
    e.runUntil(t, () => {
      this.register();
      return shownNow();
    });
    this.register();
  }

  /**
   * Step (paused): to the next message event. The earliest hop on its way
   * arrives (and what it causes starts); with none on its way, the
   * simulation runs to the next message shown, which appears at its
   * sender.
   */
  step(): void {
    this.register();
    let next = Infinity;
    for (const it of this.items) if (this.holds(it) && this.onItsWay(it)) next = Math.min(next, this.arrival(it));
    if (next < Infinity) {
      this.clock = Math.max(this.clock, next);
      this.idleBudget = 0;
      const skip = this.skipIdle;
      // the arrival's consequences start now; the next quiet stretch waits for the next Step
      this.skipIdle = false;
      this.pump();
      this.skipIdle = skip;
    } else {
      const from = this.host.engine.now;
      this.advance(from + IDLE_HORIZON);
      const ms = this.host.engine.now - from;
      if (ms >= SKIP_REPORT) this.skipped = { ms, at: this.clock };
    }
    this.prune();
  }

  /** Follow a hop's conversation (null: stop following). */
  followFlight(id: number | null): boolean {
    if (id === null) {
      this.follow = null;
      return true;
    }
    const it = this.byId.get(id);
    if (!it) return false;
    this.follow = { key: it.key, label: it.f.label };
    return true;
  }

  /** The hops of the followed conversation still kept (their trail). */
  followed(): PaceItem[] {
    const f = this.follow;
    return f ? this.items.filter((it) => it.key === f.key) : [];
  }

  /** The simulation was moved on by other means (runTo): what arrived meanwhile is history, on screen or not. */
  resync(): void {
    this.register();
    const now = this.host.engine.now;
    this.items = this.items.filter((it) => {
      const keep = (it.f.dropped !== undefined ? it.f.dropped : it.f.t0 + it.lat) >= now - EPS;
      if (!keep) this.byId.delete(it.f.id);
      return keep;
    });
  }
}
