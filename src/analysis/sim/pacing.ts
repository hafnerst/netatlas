/**
 * Pacing: how the protocol simulation is shown over time, so that every
 * message can be followed on its whole way. DOM-free (the browser draws
 * what it says; tests drive it in Node).
 *
 * The display clock. It runs with real time × the speed (0.1× … 4×).
 * Every message hop (a flight: one cable in the physical view, a relation
 * or a network line in the logical view) gets its own stretch of it:
 *
 *   - Readable (the default): about 3 s per hop, longer for a slower link
 *     and shorter for a faster one, relative to the model's typical hop
 *     (3 s × (1 + 0.6 · log10(latency ÷ typical)), clamped to 2–6 s), so
 *     a WAN link visibly takes longer than a LAN cable and every message
 *     stays readable;
 *   - Proportional: the hop's simulated time × a scale ("1 ms = 1 s"), at
 *     least 0.2 s and at most 30 s;
 *   - either way a dot never moves faster than MAX_SPEED on screen (70 px
 *     per second at 100 % zoom): a long line takes longer.
 *
 * A hop starts when its frame is sent, or, when it continues a hop that is
 * still on screen (the next cable after a switch, the second half of a
 * network line), when that one has arrived; between two cables of a
 * switch it first crosses the switch (0.6 s). The arrival pulse and a lost
 * message's ✕ stay 1.5 s.
 *
 * Two clocks. The simulated clock runs at its own rate, × the speed: 1 s of
 * simulated time per second in Readable and Real time pacing, 1 ÷ the scale
 * in Proportional (its slow motion: "1 ms = 1 s"). The display clock moves
 * the dots. Cable latencies, protocol timers, retransmissions, application
 * intervals and retries are simulated time only; a dot's 3 s on screen is
 * never 3 s of modelled network delay.
 *
 * The barrier (Readable and Proportional). A delivery a dot shows waits for
 * it: the engine stops before that arrival (Engine.hold, asked event by
 * event) until the dot has reached its receiver on screen, then processes it
 * at its own simulated time — the learning, the answer, the next hop come
 * after the dot, never before it. Everything after the held event waits too
 * (nothing runs around it, so the order of events is never changed); what
 * is on screen meanwhile goes on moving, so independent exchanges sent
 * before it are in flight together, and the clock then counts on from where
 * it waited (no burst). Waited for (`gated`, decided when a hop is taken
 * in): every hop drawn as a dot in the view on screen — a Network event's,
 * the conversation followed, the scenario's drawn ones — and one datagram of
 * each stream after each Network event (its example: hop by hop). Not: what
 * is not drawn (another view, a hidden protocol or sender, bundled into
 * cable activity, the steady state below), the scenario's muted background
 * while Network events hold the front, the rest of a stream (a flow),
 * anything lost or hidden, and anything at all in Real time pacing (an
 * overview). A change of what is shown goes through reshow: a dot of what
 * was delivered meanwhile is history and leaves the screen. Headless runs,
 * runTo and an experiment's result never wait (Engine.run).
 *
 * The steady state. A kind of the scenario's message (its protocol, its
 * type and a TCP segment's flags) drawn once is cable activity the next
 * times — another host's DHCP Discover, a Hello again, the next periodic
 * test — not waited for, until the next Network event makes the scenario
 * news again (`summarizeRepeats`; an experiment shows everything). The
 * startup is shown one of each kind, step by step; then the simulation
 * runs at its rate with the cables lit.
 *
 * A frame does at most JUMP_BUDGET ms of simulation work; what it can't do
 * in time is left behind (said: `behind`, never caught up in a burst), so
 * heavy traffic never freezes the page. With nothing on screen (no dot on
 * its way, no cable lit) and skipping idle time on, the default, it jumps
 * to the next message that will be shown; the jump is reported.
 *
 * The display follows the events, in their causal order. A hop starts on
 * screen when its frame is sent, or later when it must: a hop that
 * continues another (the next cable after a switch) when that one has
 * arrived; a hop sent because another one arrived (the engine's
 * Flight.cause: a router forwarding it on, the answer to a request, the ARP
 * request a packet needs and the packet its reply releases) when that one
 * has arrived; and the first hop of a message that answers another of its
 * conversation (the same protocol between the same two ends, from the other
 * side) when that one has arrived. So each operation's steps show one after the other while
 * different operations overlap. The tables and the log are never ahead of a
 * dot waited for; a hop not waited for that would start more than
 * LAG_MAX after it happened is not drawn as a dot (cable activity) — except
 * a Network event's and the conversation followed; one that goes on with
 * what is drawn (the next cable of a message on screen, the next message of
 * a conversation on screen: a TCP handshake's SYN-ACK and ACK after its SYN)
 * has LAG_CONT, so an exchange on screen is not cut in the middle. Only how far the
 * simulation has got at a moment depends on the pacing, never what happens
 * or in which order: the engine runs the same events whatever the pacing
 * (tests compare the results).
 *
 * Following a message: its conversation is always drawn (beyond the
 * bundling and the dot limit) and keeps its trail; its deliveries wait
 * for their dots like any drawn hop's.
 *
 * Foreground and background. The traffic of Network events (its flights
 * carry the operation's id: a send's messages and their answers, a join's
 * reports, a leave, a stream's datagrams and every copy of them) is the
 * foreground: always drawn, with labels and a trail, inspectable. While
 * such an operation runs (`host.foreground`), or a hop of one is still on
 * screen, the scenario is the background: its dots go on moving, drawn
 * muted (grey) and not clickable (`background`); its events happen on the
 * same clock, in the log and the tables.
 *
 * Bundling. At most CONV_LIMIT of the scenario's conversations are drawn as
 * dots at once, each to its end — and up to CONV_DIVERSE more for protocols
 * with nothing on screen, so a startup burst of one protocol (DHCP, ARP)
 * never hides another's message (an IGMP query, a Hello); a hop of another
 * conversation is cable activity (a cable lit, "OSPF ×3"; `notDrawn` counts them for a note). At
 * most `limit` hops start on screen at once whatever their conversations; a
 * hop that goes on with what is drawn (the next cable of a message, the next
 * message of its conversation) is drawn beyond it, so nothing on screen is
 * cut in the middle (the conversations on screen are at most CONV_LIMIT +
 * CONV_DIVERSE).
 *
 * Streams and repeating applications, started from Network events or the
 * model, run on the simulated clock: the pacing changes how fast they are
 * shown, never which datagrams exist.
 *
 * Step (paused): the next delivery on screen happens and what it causes at
 * once appears; nothing later. Next exchange (paused): on to the end of the
 * exchange that is first on screen (all its hops arrived), or of the next
 * one to start.
 *
 * An experiment playing (analysis/sim/experiment.ts) is shown with the same
 * pacing, three things apart: only its traffic is shown (the host's `shown`
 * says which; the rest runs, hidden, and takes no place: no dot, no cable
 * activity, nothing on screen to wait for, so an idle stretch of it is
 * skipped like nothing); a hop never waits on screen for a hidden one it
 * continues or was caused by (`hiddenHoldsNothing`); nothing is muted
 * (`mute` off: what is shown is all the experiment's); and the clock stops
 * at the experiment's end (`host.until`). An idle jump also stops at the
 * run's notable moments (`host.notable`: a step due, a device done booting)
 * and the display rests there a moment, so that a state change without
 * traffic — a cold start's devices booting — is seen, not skipped.
 *
 * The browser's loop (sim-controller.ts) starts the display clock with the
 * first frame drawn and counts a frame at most FRAME_MAX, so that the
 * first hops get the same screen time as later ones.
 */
import { Flight, Headers } from './types';

export type PaceMode = 'readable' | 'proportional' | 'realtime';

export const PACE_SPEEDS: readonly number[] = [0.1, 0.25, 0.5, 1, 2, 4];
/** Proportional: display ms per simulated ms ("1 ms = 0.1 s", "1 ms = 1 s", "1 ms = 10 s"). */
export const PACE_SCALES: readonly number[] = [100, 1000, 10000];
/** Readable: the time of a typical hop, and the clamps (display ms at 1×). */
export const HOP_MS = 3000;
export const HOP_MIN = 2000;
export const HOP_MAX = 6000;
/** The fastest a dot moves on screen (px per second at 100 % zoom, i.e. diagram units per second): a long line takes longer. */
export const MAX_SPEED = 70;
/** Proportional: the shortest and the longest hop shown. */
export const PROP_MIN = 200;
export const PROP_MAX = 30000;
/** Bundling: at most this many conversations drawn as dots at once (the scenario's; a Network event's traffic always is). */
export const CONV_LIMIT = 6;
/** Beyond it, this many more for a protocol with nothing on screen (an IGMP query, a Hello, in a burst of DHCP and ARP: every protocol shows). */
export const CONV_DIVERSE = 3;
/** Cable activity: a hop not drawn as a dot lights its cable this long (display ms). */
export const ACTIVITY_MS = 3000;
/** Real time: each hop shows this long (display ms), a sign of its traffic. */
export const RT_HOP = 800;
/** A lost message's ✕ stays this long. */
export const LOST_MS = 1500;
/** The arrival pulse at the receiver, and the fade-in at the sender. */
export const PULSE_MS = 1500;
export const FADE_MS = 300;
/** Through a switch between two cables. */
export const TRANSIT_MS = 600;
/** A hop that would start on screen more than this after it happened (display ms) is cable activity instead of a dot (not a Network event's, not the conversation followed). */
export const LAG_MAX = 15000;
/** The same for a hop that goes on with what is on screen (the next cable of a drawn message, the next message of a drawn conversation): bounded too, further. */
export const LAG_CONT = 60000;
/** A skipped idle stretch is reported when it is at least this long (simulated ms). */
export const SKIP_REPORT = 500;
/** The longest jump at once (simulated ms: 10 min); when it finds nothing to show, the next one waits IDLE_REST of display time. */
export const IDLE_HORIZON = 600000;
export const IDLE_REST = 1000;
/**
 * The longest step of the display clock in one animation frame (real ms;
 * the browser's loop caps it): a longer frame (a stall, a busy main thread)
 * counts this much, so that a dot never jumps ahead; the pacing stays the
 * same whatever the frame rate above 10 frames a second.
 */
export const FRAME_MAX = 100;
/** Real ms of simulation work a jump may take per frame. */
export const JUMP_BUDGET = 25;

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

/**
 * What a message belongs to: its protocol and its two ends, either way round
 * (a request and its reply share it). TCP and UDP: the transport and both
 * ends with their ports (the innermost header: an encapsulated connection's
 * own), so two connections between the same hosts are two conversations; an
 * ICMP echo: its identifier with the two addresses.
 */
export function conversationKey(protocol: string, h: Headers | undefined, label: string): string {
  const pair = (a: string, b: string): string => (a < b ? a + '|' + b : b + '|' + a);
  if (!h) return protocol + '|' + label;
  if (h.arp) return 'arp|' + pair(h.arp.senderIp, h.arp.targetIp);
  const ip = h.l3.length ? h.l3[h.l3.length - 1] : null;
  if (ip && h.l4 && (h.l4.proto === 'tcp' || h.l4.proto === 'udp' || (h.l4.proto === 'icmp' && h.l4.echoId !== undefined))) return flowKey(h.l4.proto, ip.src, ip.dst, h.l4);
  if (ip) return `${protocol}|${pair(ip.src, ip.dst)}`;
  return `${protocol}|${pair(h.l2.src, h.l2.dst)}`;
}

/**
 * A transport conversation's key from its addresses and ports (TCP, UDP;
 * an ICMP echo by its identifier), either way round: what the packet
 * inspector's headers give, and what the transport gives the dots of the
 * logical view (which have no frame) — so Follow message is the same in
 * both views.
 */
export function flowKey(proto: string, src: string, dst: string, l4: { sport?: number; dport?: number; echoId?: number }): string {
  if (proto === 'icmp') return `icmp|${l4.echoId}|${src < dst ? src + '|' + dst : dst + '|' + src}`;
  const a = src + ':' + (l4.sport !== undefined ? l4.sport : '');
  const b = dst + ':' + (l4.dport !== undefined ? l4.dport : '');
  return `${proto}|${a < b ? a + '|' + b : b + '|' + a}`;
}

/**
 * What the simulation waits for on screen, in words, from the held hop
 * itself: "waiting for packet arrival", and what for when its message says
 * (an ARP or NDP message: neighbor resolution; a TCP segment with SYN:
 * establishing TCP, or retransmitting SYN when it is one; an IGMP or MLD
 * report or leave: a membership report in transit).
 */
export function holdText(f: Flight): string {
  const p = f.protocol;
  let what = '';
  if (p === 'arp' || p === 'ndp') what = 'neighbor resolution';
  else if (f.flags && f.flags.indexOf('S') >= 0) what = / \(retransmission\)/.test(f.label) ? 'retransmitting SYN' : 'establishing TCP';
  else if ((p === 'igmp' || p === 'mld') && /Report|Leave|Done/.test(f.label)) what = 'membership report in transit';
  return what ? `waiting for packet arrival (${what})` : 'waiting for packet arrival';
}

/** A kind of message in a view (its protocol, its type, a TCP segment's flags): another of it is the steady state. */
export function repeatKey(f: Flight): string {
  return `${f.view}|${f.protocol}|${f.type !== undefined ? f.type : f.label}|${f.flags || ''}`;
}

/** The key a hop's conversation has: its transport's when it has one (both views), else its headers'. */
export function flightKey(f: Flight, h: Headers | undefined): string {
  return f.conv || conversationKey(f.protocol, h, f.label);
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
  /** of a Send test: always drawn, and while the test runs it alone sets the pace */
  test: boolean;
  /** the hop it continues, while that is on screen */
  parent?: PaceItem;
  /** a multicast datagram's hop shown as its stream's example (hop by hop, gated), not as the flow */
  example?: boolean;
  /** the simulation waits for its arrival on screen (decided when it is taken in: Pacer.gated) */
  gate?: boolean;
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
    /** true when it stopped before a delivery the presentation holds */
    runUntil(t: number, stop: () => boolean): boolean;
    run(t: number): void;
    readonly flightSerial: number;
    flightsSince(serial: number): Flight[];
    /** the presentation's hold the engine asks before a delivery (the pacing installs it; null: none) */
    hold: ((flight: number) => boolean) | null;
    /** the flight of the delivery next due that is held, if any */
    heldNext(): number | null;
  };
  /** is a flight one whose dot is drawn (its view, a protocol shown) */
  shown(f: Flight): boolean;
  /** a typical hop's simulated time in a view (ms) */
  typical(view: Flight['view']): number;
  /** the length of a flight's line in the diagram (its units: px at 100 % zoom); null when it is not drawn in the view on screen */
  length?(f: Flight): number | null;
  /** a flight's headers (the conversation key) */
  headers?(f: Flight): Headers | undefined;
  /** is a Send test running (sent, not yet answered or failed, not waiting for a DHCP lease)? */
  testRunning?(): boolean;
  /** is a Network event running with traffic of its own (a send, a stream, a join)? Its traffic is then the foreground. */
  foreground?(): boolean;
  /** the simulated time the clock never runs past (an experiment's end); null or none: no end */
  until?(): number | null;
  /** counts the Network events submitted: after a new one, the scenario's messages are news again (drawn, not the steady state) */
  epoch?(): number;
  /** the next moment after `t` an idle jump stops at and rests (an experiment's step, a boot's end); null or none: none */
  notable?(t: number): number | null;
}

/** A cable (or relation) with traffic not drawn as dots, lately: its protocols and how many hops of each. */
export interface Activity {
  ref: string;
  view: Flight['view'];
  track: Flight['track'];
  counts: Array<[string, number]>;
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
  /** hops not drawn since the start (bundled, the background, beyond `limit`): cable activity */
  notDrawn = 0;
  /** bundling: at most this many conversations drawn at once */
  convLimit = CONV_LIMIT;
  /** a Network event's traffic is the foreground now (refreshed as the clock moves) */
  fgNow = false;
  /** the scenario's hops are muted while Network events hold the front (an experiment: off, everything shown is its own) */
  mute = true;
  /** a hop waits on screen only for a shown hop it continues or was caused by (an experiment: hidden traffic holds nothing) */
  hiddenHoldsNothing = false;
  /** the simulation can't keep up with its rate (simulated ms behind, lately; 0: in step) */
  behind = 0;
  /** the display clock and simulated time the rate counts from, and where it left the simulation (moved since by other means: a Step, a jump: counted from there) */
  private rt: { clock: number; now: number; left: number; rate: number } | null = null;
  /** the hops counted as cable activity, with when (display clock) */
  private act: Array<{ f: Flight; at: number }> = [];
  private byId = new Map<number, PaceItem>();
  private serial: number;
  private idleBudget = 0;
  /** no idle jump before this (display clock): the last one found nothing to show */
  private restUntil = -Infinity;
  /** where an idle jump that its budget cut short started (it goes on towards the same end next frame); null: none */
  private jumpStart: number | null = null;

  /** the scenario's hops are the muted background now (a Network event holds the front): they hold no delivery */
  private bgNow = false;
  /** a kind of scenario message drawn before (since the last Network event) is the steady state: cable activity (an experiment: off) */
  summarizeRepeats = true;
  /** the kinds of the scenario's messages drawn as dots since the last Network event (repeatKey), and that event's count */
  private seen = new Set<string>();
  /** the transport conversations (Flight.conv) drawn as their kind's example: shown whole */
  private detailed = new Set<string>();
  private seenEpoch = -1;
  /** scenario hops summarized as repeats since the start */
  repeats = 0;

  constructor(
    private host: PacerHost,
    public limit = 48,
  ) {
    this.serial = host.engine.flightSerial;
    host.engine.hold = (id) => this.holds(id);
  }

  /** The pacing lets go of the engine (the simulation stopped, exited or replaced): nothing is held any more. */
  detach(): void {
    if (this.host.engine.hold) this.host.engine.hold = null;
  }

  /** "Readable · 3 s per hop · 1×", "Proportional · 1 ms = 1 s · 2×", "Real time · 1×"; "· your events in front" while they are; what a delivery waits for on screen. */
  describe(): string {
    const sp = `${this.speed}×`;
    const behind = this.behind > 0 ? ' · behind' : '';
    const base = this.mode === 'readable' ? `Readable · ${HOP_MS / 1000} s per hop · ${sp}` : this.mode === 'proportional' ? `Proportional · ${scaleText(this.scale)} · ${sp}` : `Real time · ${sp}${behind}`;
    const h = this.holding();
    const wait = h ? ` · ${holdText(h.f)}` : '';
    return (this.fgNow ? `${base} · your events in front` : base) + wait;
  }

  /**
   * Is a hop's arrival gated — does the simulation wait for its dot before it
   * delivers it? Every hop drawn and shown as a dot, in Readable and
   * Proportional pacing (Real time is an overview: it waits for nothing):
   * the scenario's, a Network event's, the conversation followed. Not: what
   * is not drawn (another view, a hidden protocol, bundled into cable
   * activity, beyond the limit), what is lost or hidden, the scenario's
   * muted background while Network events hold the front, and multicast
   * data (a stream is a flow; its datagrams follow the forwarding state as
   * it is when each copy is forwarded, which the gated reports change).
   */
  gated(it: PaceItem): boolean {
    const f = it.f;
    return !!it.gate && this.mode !== 'realtime' && !f.hidden && f.dropped === undefined && this.host.shown(f);
  }

  /**
   * Is a new hop one the simulation waits for — decided once, when it is taken in: a dot not waited for then (another
   * pacing, the muted background) was not waited for, and never is later; it can only stop being waited for (lost,
   * hidden, no longer shown, Real time). See gated.
   */
  private gates(it: PaceItem): boolean {
    const f = it.f;
    if (this.mode === 'realtime' || !it.drawn || f.hidden || f.dropped !== undefined || (f.protocol === 'mcast' && !it.example)) return false;
    if (!this.host.shown(f)) return false;
    return !(this.bgNow && !it.test && !(this.follow && this.follow.key === it.key));
  }

  /** The engine asks before a delivery: is that flight's dot still on its way on screen (registered first, if it is new)? */
  private holds(id: number): boolean {
    if (this.mode === 'realtime') return false;
    if (this.host.engine.flightSerial !== this.serial) this.register();
    const it = this.byId.get(id);
    return !!it && this.gated(it) && this.clock < this.arrival(it) - EPS;
  }

  /** The hop whose arrival the simulation waits for now (null: it waits for none). */
  holding(): PaceItem | null {
    const id = this.host.engine.heldNext();
    return id === null ? null : this.byId.get(id) || null;
  }

  /** The display time of a hop of `lat` simulated ms in a view. */
  hopTime(lat: number, view: Flight['view'], length?: number | null): number {
    if (this.mode === 'realtime') return RT_HOP;
    const t = this.mode === 'readable' ? readableHop(lat, this.host.typical(view)) : proportionalHop(lat, this.scale);
    // never faster than MAX_SPEED on screen
    return length ? Math.max(t, (length / MAX_SPEED) * 1000) : t;
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

  /**
   * Is a hop the background now: the scenario's while a Network event runs
   * or its traffic is still on screen. Drawn muted and not clickable; it
   * goes on moving.
   */
  background(it: PaceItem): boolean {
    return this.mute && !it.test && this.fgActive();
  }

  /** Does Network events' traffic hold the front now: an operation running, or a hop of one still on screen (on its way or about to start)? */
  fgActive(): boolean {
    if (this.fgNow) return true;
    for (const it of this.items) if (it.test && this.drawnShown(it) && this.pending(it)) return true;
    return false;
  }

  /** Is a Network event's traffic the foreground now (asked of the host; kept until the clock moves again)? */
  private refreshForeground(): void {
    this.fgNow = !!this.host.foreground && this.host.foreground();
    this.bgNow = this.mute && this.fgActive();
  }

  private drawnShown(it: PaceItem): boolean {
    return it.drawn && !it.f.hidden && this.host.shown(it.f);
  }

  /** Is a hop still on its way on screen (before its arrival)? */
  private onItsWay(it: PaceItem): boolean {
    return this.clock < this.arrival(it) - EPS;
  }

  /** Is a hop still to come or on its way on screen (not yet arrived)? */
  private pending(it: PaceItem): boolean {
    return this.onItsWay(it);
  }

  /** Is anything drawn still to come or on its way on screen, or a cable lit by traffic not drawn as dots (the steady state goes on at its rate meanwhile, never skipped)? */
  busy(): boolean {
    return this.items.some((it) => this.drawnShown(it) && this.pending(it)) || this.lit();
  }

  /** Is a cable lit by traffic not drawn as dots now (cable activity, shown for ACTIVITY_MS)? */
  private lit(): boolean {
    const a = this.act.length ? this.act[this.act.length - 1] : null;
    return !!a && this.clock - a.at <= ACTIVITY_MS && this.host.shown(a.f);
  }

  /** Take in the flights sent since the last look; returns the new hops. */
  private register(): PaceItem[] {
    const e = this.host.engine;
    const fresh = e.flightsSince(this.serial).reverse();
    this.serial = e.flightSerial;
    const added: PaceItem[] = [];
    // the hops on screen now, per view (only shown ones count against the limit), and their conversations
    const live = { physical: 0, logical: 0 };
    const convs = { physical: new Set<string>(), logical: new Set<string>() };
    // the protocols with a conversation on screen, per view
    const protos = { physical: new Set<string>(), logical: new Set<string>() };
    // the drawn hops still on their way, by conversation (an answer's first hop waits for them): one pass, not one per new hop
    const onWay = new Map<string, PaceItem[]>();
    const wayOf = (x: PaceItem): void => {
      const l = onWay.get(x.key);
      if (l) l.push(x);
      else onWay.set(x.key, [x]);
    };
    // a Network event changed the network (a failure, a restore, a join …): what the scenario does now is news, drawn again
    const ep = this.host.epoch ? this.host.epoch() : 0;
    if (ep !== this.seenEpoch || this.seen.size + this.detailed.size > 4000) {
      this.seenEpoch = ep;
      this.seen.clear();
      this.detailed.clear();
    }
    if (fresh.length)
      for (const x of this.items) {
        if (x.drawn && this.onItsWay(x)) wayOf(x);
        if (x.drawn && this.clock < this.end(x) && this.host.shown(x.f)) {
          live[x.f.view]++;
          // (a conversation takes a place while a hop of it is on its way; its arrival's pulse doesn't)
          if (!x.test && this.onItsWay(x)) {
            convs[x.f.view].add(x.key);
            protos[x.f.view].add(x.f.protocol);
          }
        }
      }
    for (const f of fresh) {
      if (this.byId.has(f.id)) continue;
      // a creation-time loss puts the flight's end where it was lost: midway
      const lat = f.dropped !== undefined && f.dropped > f.t0 ? 2 * (f.dropped - f.t0) : Math.max(0, f.t1 - f.t0);
      // what arrived before the display saw it (a jump of the tests, runTo) is history: not drawn
      if ((f.dropped !== undefined ? f.dropped : f.t0 + lat) < e.now - EPS) continue;
      const pAny = f.parent !== undefined ? this.byId.get(f.parent) : undefined;
      const test = f.test !== undefined;
      const h = this.host.headers ? this.host.headers(f) : undefined;
      const key = flightKey(f, h);
      // multicast data (a stream's datagrams and their copies): each copy on its cable from the moment it is forwarded, not after
      // the copy before it has arrived on screen — a stream is a flow on every cable of its tree at once, and a change of the tree
      // (a join, a leave taking effect) shows with the next datagram instead of after a backlog of earlier ones. One datagram of
      // each stream after each Network event (a join, a leave …) is its example: shown hop by hop like any message, each copy
      // after the one it was forwarded from has arrived, the simulation waiting for it — the tree as it is now, seen growing
      const sample = f.protocol === 'mcast' && this.streamExample(f, pAny, key);
      const flow = f.protocol === 'mcast' && !sample;
      // (a hidden hop holds nothing when hidden traffic must not delay what is shown)
      const parent = pAny && (!this.hiddenHoldsNothing || this.host.shown(pAny.f)) ? pAny : undefined;
      let after = parent && !flow ? this.arrival(parent) : -Infinity;
      // what caused it (a frame it forwards, the request it answers, the ARP reply that released it) arrives first, in the same view
      const cAny = f.cause !== undefined ? this.byId.get(f.cause) : undefined;
      const cause = cAny && (!this.hiddenHoldsNothing || this.host.shown(cAny.f)) ? cAny : undefined;
      if (!parent && !flow && cause && cause.f.view === f.view) after = Math.max(after, this.arrival(cause));
      // an answer (its first hop) after the message it answers has arrived on screen: a hop of its conversation (and of the same Network event, if any) from the other side,
      // in the same view (the other view's hops are not on this screen: as the cause, they hold nothing here)
      if (!parent && f.sender !== undefined)
        for (const x of onWay.get(key) || []) if (x.f.view === f.view && x.f.test === f.test && x.f.sender !== undefined && x.f.sender !== f.sender && this.onItsWay(x)) after = Math.max(after, this.arrival(x));
      const d0 = Math.max(this.clock, after);
      // between two cables: across the switch that forwarded it
      const transit = parent && !flow && f.view === 'physical' && parent.f.view === 'physical' && parent.f.track.ref !== f.track.ref ? TRANSIT_MS : 0;
      // a hop that is not shown (another view, a hidden protocol, a non-sender) takes no place; a Network event's is always drawn
      const shown = this.host.shown(f);
      // the scenario's: bundled, a few conversations at a time (muted while a Network event runs); one that would show long after it happened is cable activity
      const followed = !!this.follow && this.follow.key === key;
      const room = live[f.view] < this.limit;
      // (a protocol with nothing on screen gets a place beyond the limit, a few at most)
      const conv = convs[f.view].has(key) || convs[f.view].size < this.convLimit || (!protos[f.view].has(f.protocol) && convs[f.view].size < this.convLimit + CONV_DIVERSE);
      // a hop that goes on with what is drawn (the next cable of a message on screen, the next message of a conversation on
      // screen: a SYN-ACK after its SYN, the handshake's ACK after that) is drawn whatever the limit (it takes over from the hop
      // before it; the conversations on screen are few) as long as it is not more than LAG_CONT behind, so an exchange on screen
      // is never cut in the middle; anything else needs room and is cable activity beyond LAG_MAX
      const goesOn = (!!parent && parent.drawn) || convs[f.view].has(key);
      const late = d0 - this.clock > (goesOn ? LAG_CONT : LAG_MAX);
      // the steady state: a kind of message drawn before (its protocol, type and TCP flags, in this view) since the last Network
      // event — a Hello, another host's DHCP Discover, a periodic test again — is cable activity, unless it goes on with what is drawn
      // (then whole): one of each kind is seen walking, and the simulation does not wait for the rest
      // (goes on: the next cable of a message drawn, or the next segment of a connection shown as its kind's example — not
      // merely the same addresses: every host's DHCP has the same ones)
      const rk = repeatKey(f);
      const example = (!!parent && parent.drawn) || (f.conv !== undefined && this.detailed.has(f.conv));
      const repeat = this.summarizeRepeats && !test && !followed && !example && this.seen.has(rk);
      if (repeat && shown) this.repeats++;
      const drawn = !shown || test || followed || (!repeat && conv && !late && (goesOn || room));
      if (shown) {
        if (drawn) {
          if (!test) {
            this.seen.add(rk);
            if (f.conv !== undefined) this.detailed.add(f.conv);
          }
          live[f.view]++;
          if (!test) {
            convs[f.view].add(key);
            protos[f.view].add(f.protocol);
          }
        } else {
          this.notDrawn++;
          this.act.push({ f, at: this.clock });
        }
      }
      const it: PaceItem = { f, lat, d0, transit, hop: this.hopTime(lat, f.view, this.host.length ? this.host.length(f) : null), drawn, key, test, parent: pAny };
      if (sample) it.example = true;
      if (this.gates(it)) it.gate = true;
      this.items.push(it);
      if (drawn) wayOf(it);
      this.byId.set(f.id, it);
      added.push(it);
    }
    return added;
  }

  /** Take in what was sent just now (a Send test, also while paused): on screen from now, without moving the simulation on. */
  take(): void {
    this.register();
  }

  /** The cables (and relations) of a view with traffic not drawn as dots, lately: by protocol, how many hops. */
  activity(view: Flight['view']): Activity[] {
    const by = new Map<string, Activity & { m: Map<string, number> }>();
    for (const a of this.act) {
      if (a.f.view !== view || this.clock - a.at > ACTIVITY_MS) continue;
      const ref = a.f.track.ref;
      let x = by.get(ref);
      if (!x) by.set(ref, (x = { ref, view, track: a.f.track, counts: [], m: new Map() }));
      x.m.set(a.f.protocol, (x.m.get(a.f.protocol) || 0) + 1);
    }
    return Array.from(by.values())
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
      .map((x) => ({ ref: x.ref, view: x.view, track: x.track, counts: Array.from(x.m.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) }));
  }

  /** Is a multicast datagram's hop its stream's example: the first one since the last Network event, and every copy forwarded from it? */
  private streamExample(f: Flight, parent: PaceItem | undefined, key: string): boolean {
    if (f.parent !== undefined) return !!parent && !!parent.example;
    const k = 'stream|' + f.view + '|' + key;
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }

  /** Forget what has left the screen. */
  private prune(): void {
    if (this.act.length && this.clock - this.act[0].at > ACTIVITY_MS) this.act = this.act.filter((a) => this.clock - a.at <= ACTIVITY_MS);
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

  /** Simulated ms per display ms: 1 in Readable and Real time (and while a stream of Network events runs), 1 ÷ the scale in Proportional. */
  rate(): number {
    return this.mode === 'proportional' ? 1 / this.scale : 1;
  }

  /**
   * Run the simulation with the display clock at its rate, held by nothing.
   * A frame does at most JUMP_BUDGET ms of simulation work; what it can't do
   * in time is left behind (said, never caught up in a burst): the clock
   * goes on from where it got. With nothing on screen and idle skipping on,
   * on to the next message that will be shown (bounded per frame too).
   */
  pump(): void {
    const e = this.host.engine;
    this.refreshForeground();
    this.register();
    const rate = this.rate();
    if (!this.rt || Math.abs(e.now - this.rt.left) > EPS || this.rt.rate !== rate) this.rt = { clock: this.clock, now: e.now, left: e.now, rate };
    const cap = this.cap();
    const target = Math.min(cap, this.rt.now + (this.clock - this.rt.clock) * rate);
    if (target > e.now + EPS) {
      const until = Date.now() + JUMP_BUDGET;
      const held = e.runUntil(target, () => {
        this.register();
        return Date.now() > until;
      });
      this.register();
      // waiting for a dot to arrive (a presentation hold, not a lag): the clock counts on from here once it is there,
      // so the simulated time it waited is not made up in a burst afterwards
      if (held) {
        this.behind = 0;
        this.rt = { clock: this.clock, now: e.now, left: e.now, rate };
        return;
      }
      if (e.now < target - 1) {
        this.behind = target - e.now;
        this.rt = { clock: this.clock, now: e.now, left: e.now, rate };
        return;
      }
      this.behind = 0;
      this.rt.left = e.now;
    }
    // idle: nothing on screen (nothing still to come on it): on to the next message that will be shown (never in Real time, nor while a stream keeps real time)
    if (!this.skipIdle || this.mode === 'realtime' || this.busy() || this.behind > 0) return;
    if (this.clock < this.restUntil) return;
    const from = e.now;
    if (from >= cap - EPS) return;
    // a jump cut short by its budget goes on towards the same end next frame (a new jump would never rest)
    const start = this.jumpStart !== null && this.jumpStart <= from && from < this.jumpStart + IDLE_HORIZON ? this.jumpStart : from;
    const note = this.host.notable ? this.host.notable(from) : null;
    const stopAt = note !== null && note !== undefined && note > from ? note : Infinity;
    const horizon = Math.min(cap, start + IDLE_HORIZON, stopAt);
    this.advance(horizon);
    // (a notable moment reached without traffic: rest there, so that what changed is seen)
    if (stopAt < Infinity && e.now >= stopAt - EPS && !this.busy()) this.restUntil = this.clock + IDLE_REST;
    const shown = this.busy();
    this.jumpStart = !shown && e.now < horizon - EPS ? start : null;
    if (e.now - start >= SKIP_REPORT) this.skipped = { ms: e.now - start, at: this.clock };
    // a whole horizon with nothing to show: rest a moment
    if (e.now >= start + IDLE_HORIZON - EPS && !shown) this.restUntil = this.clock + IDLE_REST;
    // the clock counts on from where the jump left it
    this.rt = { clock: this.clock, now: e.now, left: e.now, rate };
  }

  /**
   * Next exchange (paused): on until the exchange first on screen is over (every hop of its
   * conversation arrived, what it caused at once started), or, with none on screen, the next one to
   * start and then to its end.
   */
  stepExchange(): void {
    this.refreshForeground();
    this.register();
    const first = (): string | null => {
      let best: PaceItem | null = null;
      for (const it of this.items) if (this.drawnShown(it) && this.onItsWay(it) && (!best || this.arrival(it) < this.arrival(best))) best = it;
      return best ? best.key : null;
    };
    let key = first();
    if (key === null) {
      this.step();
      key = first();
      if (key === null) return;
    }
    for (let i = 0; i < 200; i++) {
      if (!this.items.some((it) => it.key === key && this.drawnShown(it) && this.onItsWay(it))) break;
      this.step();
    }
  }

  /** Run towards t, stopping at the first moment a hop is sent that is drawn (followed or not: the next thing to see). */
  private advance(t: number): void {
    const e = this.host.engine;
    // what was on its way before is not news; only the hops sent now can stop the jump
    let found = false;
    // a jump is work: at most JUMP_BUDGET ms of it per frame (a model whose messages are mostly hidden has many events between two shown ones); the next frame goes on
    const until = Date.now() + JUMP_BUDGET;
    e.runUntil(t, () => {
      // (a dot, or traffic shown as cable activity: something to see either way)
      for (const it of this.register()) if (it.drawn ? this.drawnShown(it) && this.onItsWay(it) : this.host.shown(it.f) && !it.f.hidden) found = true;
      return found || Date.now() > until;
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
    this.refreshForeground();
    this.register();
    let next = Infinity;
    for (const it of this.items) if (this.drawnShown(it) && this.onItsWay(it)) next = Math.min(next, this.arrival(it));
    if (next < Infinity) {
      this.clock = Math.max(this.clock, next);
      this.idleBudget = 0;
      // the arrival is processed, at its own simulated time, and what it causes at once starts (an answer, the next
      // hop: on screen at its sender); nothing later — the next delivery, a quiet stretch — waits for the next Step
      const e = this.host.engine;
      let due = e.now;
      for (const it of this.items) if (this.drawnShown(it) && Math.abs(this.arrival(it) - next) < EPS && it.f.dropped === undefined) due = Math.max(due, it.f.t1);
      e.runUntil(due, () => {
        this.register();
        return false;
      });
      this.register();
      this.rt = null;
    } else {
      const from = this.host.engine.now;
      this.advance(Math.min(this.cap(), from + IDLE_HORIZON));
      const ms = this.host.engine.now - from;
      if (ms >= SKIP_REPORT) this.skipped = { ms, at: this.clock };
      this.rt = null;
    }
    this.prune();
  }

  /** Hold idle skipping for a moment of display time (an experiment's starting state is seen first). */
  rest(ms = IDLE_REST): void {
    this.restUntil = Math.max(this.restUntil, this.clock + ms);
  }

  /** The simulated time the clock may reach (an experiment's end; Infinity: none). */
  private cap(): number {
    const u = this.host.until ? this.host.until() : null;
    return u === null || u === undefined ? Infinity : u;
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

  /**
   * What is shown changed (the view, the protocols, the senders, the pacing): one path for every such change. A dot of
   * what the simulation has delivered (or lost) already — not held while it was not shown, or not gated in the pacing
   * before — is history now, not a dot still on its way: it leaves the screen. What is still to be delivered keeps its
   * place, and its hold when it is shown now. Nothing is executed, resubmitted or reordered.
   */
  reshow(): void {
    const now = this.host.engine.now;
    this.items = this.items.filter((it) => {
      const due = it.f.dropped !== undefined ? it.f.dropped : it.f.t1;
      const keep = !(due < now - EPS && this.clock < this.arrival(it) - EPS);
      if (!keep) this.byId.delete(it.f.id);
      return keep;
    });
    this.rt = null;
  }

  /** The simulation was moved on by other means (runTo): what arrived meanwhile is history, on screen or not. */
  resync(): void {
    this.jumpStart = null;
    this.rt = null;
    this.register();
    const now = this.host.engine.now;
    this.items = this.items.filter((it) => {
      const keep = (it.f.dropped !== undefined ? it.f.dropped : it.f.t0 + it.lat) >= now - EPS;
      if (!keep) this.byId.delete(it.f.id);
      return keep;
    });
  }
}
