/**
 * The protocols of the simulation: a session per relation and pair of its
 * devices (each side its own view of it), started at boot, exchanging the
 * messages of the protocol's profile (model/sim-profiles.ts) through the
 * engine, with the timers the model sets or the profile's defaults (marked
 * "default" in the event log), and reacting to failures as the profile
 * says. Besides the relations: the first-hop redundancy groups of the
 * interfaces (VRRP …), LACP on the members of every aggregate, gratuitous
 * ARP when an interface comes up, and the model's traffic demands. Pure
 * and deterministic (the jitter comes from the engine's seeded random).
 *
 * The behaviours themselves are in proto-*.ts; this module builds the
 * sessions, sends and dispatches their messages, draws them in the
 * logical view along their relation, and answers the engine (what is up,
 * which virtual addresses a device holds).
 */
import { IpAddr } from '../../model/ip';
import { lookupProtocol, protocolBase } from '../../model/protocols';
import { SimProfile, customProfile, simProfile } from '../../model/sim-profiles';
import { Model, Relation, relationDevices } from '../../model/types';
import { compareAddr, formatAddr } from '../ipmath';
import { relParam } from '../routing';
import { Engine, Frame, Protocols, fmtSec } from './engine';
import { L3Iface, SimDevice, SimAddr } from './net';
import { ParamChange, Resolved, formatValue, sourceText } from './params';
import { Msg, Pkt, SessionStatus } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Behaviours whose sessions need a common network (hellos to a link-local group, single-hop BFD). */
const LINK_LOCAL = ['ospf', 'isis', 'eigrp', 'rip', 'pim', 'ldp', 'bfd', 'igmp'];

/** One side of a session: the device, the interface it uses and its address there. */
export interface Side {
  dev: string;
  l3: L3Iface;
  addr: IpAddr;
}

/** One device's view of a session with a peer. */
export interface Sess {
  key: string;
  protocol: string;
  profile: SimProfile;
  rel: Relation;
  dev: string;
  peer: string;
  local: Side;
  remote: Side;
  /** the side that starts the handshake (the relation's earlier endpoint) */
  initiator: boolean;
  state: string;
  up: boolean;
  since: number;
  /** the last time anything was heard from the peer */
  heard: number;
  /** bumped whenever the session restarts: timers of an older generation do nothing */
  gen: number;
  /** protocol-specific state */
  x: { [k: string]: unknown };
}

/** A behaviour: what a protocol's sessions do (proto-*.ts). */
export interface Behaviour {
  /** at boot: start the session (its first messages, its timers) */
  start(P: ProtocolSim, s: Sess): void;
  /** a message of the session arrived */
  rx(P: ProtocolSim, s: Sess, msg: Msg, pkt: Pkt | null, l3: L3Iface | null): void;
  /** its own interface went down (or came up again) */
  iface?(P: ProtocolSim, s: Sess, up: boolean): void;
  /** is the session's adjacency up for routing (default: s.up) */
  adjUp?(P: ProtocolSim, s: Sess): boolean;
  /** parameters changed: its status details again */
  refresh?(P: ProtocolSim, s: Sess): void;
}

export interface TimerValue {
  ms: number;
  /** the built-in default (no configured, device or simulation value) */
  dflt: boolean;
  /** "10 s (configured)", "40 s (4 × hello, simulation)", "300 ms (default, …)" */
  text: string;
  source: 'configured' | 'device' | 'simulation' | 'default';
}

/**
 * The simulation parameter (params.ts) a profile's timer follows: the
 * parameter, and for a derived timer (OSPF dead = 4 × hello) the factor.
 * A timer that has none keeps its profile's default.
 */
const TIMER_PARAMS: { [k: string]: { key: string; factor?: number } } = {
  'ospf.hello': { key: 'ospf-hello' },
  'ospf.dead': { key: 'ospf-hello', factor: 4 },
  'bgp.keepalive': { key: 'bgp-keepalive' },
  'bgp.hold': { key: 'bgp-keepalive', factor: 3 },
  'evpn.keepalive': { key: 'bgp-keepalive' },
  'evpn.hold': { key: 'bgp-keepalive', factor: 3 },
  'l3vpn.keepalive': { key: 'bgp-keepalive' },
  'l3vpn.hold': { key: 'bgp-keepalive', factor: 3 },
  'bfd.interval': { key: 'bfd-interval' },
  'bfd.multiplier': { key: 'bfd-multiplier' },
  'vrrp.hello': { key: 'vrrp-advert' },
  'carp.hello': { key: 'vrrp-advert' },
  'ipsec.dpd': { key: 'dpd-interval' },
  'ipsec.dpd-retries': { key: 'dpd-retries' },
  'ipsec.child-lifetime': { key: 'child-lifetime' },
  'ipsec.ike-lifetime': { key: 'ike-lifetime' },
  'ha-sync.dead': { key: 'ha-failover' },
  'snmp.hello': { key: 'snmp-interval' },
};

/** A periodic timer: rescheduled when its interval changes (a parameter changed). */
interface Periodic {
  alive: () => boolean;
  interval: () => number;
  fn: () => void;
  /** when it last ran (or was set up) */
  last: number;
  /** the interval it is scheduled with */
  iv: number;
  token: number;
}

/** A message's data: who sent it and for which session. */
interface MsgData {
  from: string;
  [k: string]: unknown;
}

export class ProtocolSim implements Protocols {
  readonly e: Engine;
  readonly m: Model;
  readonly sessions = new Map<string, Sess>();
  /** sessions by relation */
  readonly byRel = new Map<string, Sess[]>();
  readonly behaviours = new Map<string, Behaviour>();
  /** owners of virtual addresses: "dev:iface" → the addresses held now */
  readonly vips = new Map<string, Array<{ addr: IpAddr; mac: string; protocol: string }>>();
  /** extra state the behaviours keep per device or group */
  readonly shared = new Map<string, unknown>();
  /** status rows that are not sessions (FHRP groups, LACP members, demands) */
  readonly extraStatus: Array<() => SessionStatus[]> = [];
  /** handlers of messages that are not a relation's session (FHRP, LACP, demands, STP, PIM data) */
  readonly handlers = new Map<string, (dev: string, l3: L3Iface | null, msg: Msg, pkt: Pkt | null, frame: Frame | null) => void>();
  /** handlers of a protocol's messages that belong to no session (a PIM Register to the RP) */
  readonly fallback = new Map<string, (dev: string, l3: L3Iface | null, msg: Msg, pkt: Pkt | null) => void>();
  readonly ifaceHooks: Array<(dev: string, l3: L3Iface, up: boolean) => void> = [];
  readonly linkHooks: Array<(ref: string, up: boolean) => void> = [];
  readonly bootHooks: Array<() => void> = [];
  /** a device was powered off (false) or has booted (true) */
  readonly deviceHooks: Array<(dev: string, up: boolean) => void> = [];
  private periodics: Periodic[] = [];

  constructor(engine: Engine, behaviours: { [id: string]: Behaviour }) {
    this.e = engine;
    this.m = engine.model;
    engine.protocols = this;
    for (const k of Object.keys(behaviours)) this.behaviours.set(k, behaviours[k]);
  }

  // ------------------------------------------------------------ building

  /** The profile a relation's protocol simulates (a custom one for a protocol without a built-in profile). */
  profileOf(r: Relation): SimProfile {
    return relationProfile(this.m, r);
  }

  sd(dev: string): SimDevice {
    return this.e.net.devices.get(dev) as SimDevice;
  }

  /** The sides of a pair of a relation: the endpoints' interfaces when written, else a network they share, else their loopbacks (or first addresses). */
  pairSides(r: Relation, a: string, b: string): { a: Side; b: Side; shared: boolean } | null {
    const sa = this.sd(a);
    const sb = this.sd(b);
    if (!sa || !sb) return null;
    const pick = (sd: SimDevice, dev: string): L3Iface[] => {
      const eps = r.endpoints.filter((x) => x.device === dev && x.iface !== undefined).map((x) => x.iface as string);
      const all = Array.from(sd.l3.values()).sort((x, y) => cmp(x.id, y.id));
      if (eps.length) {
        const out = eps.map((i) => sd.l3.get(i)).filter((x): x is L3Iface => !!x);
        // a tunnel endpoint without an address of its own: its tunnel's source
        return out;
      }
      return all;
    };
    const la = pick(sa, a);
    const lb = pick(sb, b);
    const overNets = r.over.map((o) => this.m.index.networks.get(o)).filter((n) => !!n && n.cidr).map((n) => (n as { cidr: string }).cidr);
    // a network both are in (one in the relation's `over` first)
    let best: { a: Side; b: Side; score: number } | null = null;
    for (const x of la) {
      for (const xa of x.addrs) {
        for (const y of lb) {
          for (const ya of y.addrs) {
            if (xa.addr.version !== ya.addr.version || x.kind === 'loopback' || y.kind === 'loopback') continue;
            if (!sameNet(xa, ya)) continue;
            const score = (overNets.some((c) => netText(xa) === c) ? 1000 : 0) + (xa.addr.version === 4 ? 100 : 0) + xa.net.prefix;
            if (!best || score > best.score) best = { a: { dev: a, l3: x, addr: xa.addr }, b: { dev: b, l3: y, addr: ya.addr }, score };
          }
        }
      }
    }
    if (best) return { a: best.a, b: best.b, shared: true };
    // not on a common network: loopbacks (BGP between loopbacks …), else the endpoints' own or first addresses
    const firstOf = (list: L3Iface[], version?: 4 | 6): Side | null => {
      const order = list.slice().sort((x, y) => Number(y.kind === 'loopback') - Number(x.kind === 'loopback') || cmp(x.id, y.id));
      for (const l of order) for (const ad of l.addrs) if (!version || ad.addr.version === version) return { dev: l.device, l3: l, addr: ad.addr };
      return null;
    };
    // a tunnel endpoint: its own addresses (the tunnel's inside), else its source's
    const fa = firstOf(la, 4) || firstOf(la);
    const fb = fa ? firstOf(lb, fa.addr.version) : null;
    if (fa && fb) return { a: fa, b: fb, shared: false };
    return null;
  }

  /** Build the sessions of every relation (each pair, each side). */
  build(): void {
    for (const r of this.m.relations.slice().sort((x, y) => cmp(x.id, y.id))) {
      const profile = this.profileOf(r);
      if (!this.behaviours.has(profile.behaviour)) continue;
      const devs = relationDevices(r);
      if (devs.length < 2) continue;
      const pairs: Array<[string, string]> = [];
      if (profile.behaviour === 'service' || profile.behaviour === 'custom' || r.direction === 'unidirectional') {
        // from the clients (every endpoint but the last) to the server (the last); one way when unidirectional
        const last = devs[devs.length - 1];
        for (const c of devs.slice(0, -1)) pairs.push([c, last]);
      } else {
        for (let i = 0; i < devs.length; i++) for (let j = i + 1; j < devs.length; j++) pairs.push([devs[i], devs[j]]);
      }
      for (const [a, b] of pairs) {
        const sides = this.pairSides(r, a, b);
        if (!sides) {
          // a protocol of the model's own between devices without addresses: its packets go as frames over their cable (proto-other.ts installCustomL2)
          if (profile.behaviour === 'custom' && this.m.links.some((l) => (l.a.device === a && l.b.device === b) || (l.a.device === b && l.b.device === a))) continue;
          this.e.note('note', profile.id, a, b, 'not simulated', '', `${r.id}: ${a} and ${b} have no addresses to exchange ${profile.label} messages with`, 0);
          continue;
        }
        // link-local protocols (hellos to a multicast group, single-hop BFD) only pair devices on a common network
        if (!sides.shared && LINK_LOCAL.indexOf(profile.behaviour) >= 0 && !(profile.behaviour === 'ldp' && profile.id !== 'ldp')) {
          this.e.note('note', profile.id, a, b, 'no adjacency', '', `${r.id}: ${a} and ${b} have no network in common, so no ${profile.label} adjacency forms between them`, 0);
          continue;
        }
        // IKE protects a tunnel from the outside: between the tunnel's source and destination, never inside it
        if (profile.behaviour === 'ike') {
          const outer = (x: Side, y: Side): Side => {
            if (x.l3.kind !== 'tunnel') return x;
            const ends = this.e.tunnelEnds(x.dev, x.l3.id);
            const own = ends.length ? Array.from(this.sd(x.dev).l3.values()).find((l) => l.kind !== 'tunnel' && l.addrs.some((a) => compareAddr(a.addr, ends[0].src) === 0)) : undefined;
            void y;
            return ends.length && own ? { dev: x.dev, l3: own, addr: ends[0].src } : x;
          };
          sides.a = outer(sides.a, sides.b);
          sides.b = outer(sides.b, sides.a);
        }
        this.add(r, profile, sides.a, sides.b, true);
        this.add(r, profile, sides.b, sides.a, false);
      }
    }
  }

  private add(r: Relation, profile: SimProfile, local: Side, remote: Side, initiator: boolean): Sess {
    const key = `${profile.id}|${r.id}|${local.dev}|${remote.dev}`;
    const s: Sess = { key, protocol: profile.id, profile, rel: r, dev: local.dev, peer: remote.dev, local, remote, initiator, state: profile.states[0] || 'Down', up: false, since: 0, heard: -1, gen: 0, x: {} };
    this.sessions.set(key, s);
    if (!this.byRel.has(r.id)) this.byRel.set(r.id, []);
    (this.byRel.get(r.id) as Sess[]).push(s);
    return s;
  }

  /** A session of a device with a peer in a relation. */
  sess(protocol: string, rel: string, dev: string, peer: string): Sess | undefined {
    return this.sessions.get(`${protocol}|${rel}|${dev}|${peer}`);
  }

  /** Start: every interface comes up at t = 0 (with a gratuitous ARP), then every session after a small jitter. */
  start(): void {
    this.build();
    // interfaces up, as on a freshly booted network
    for (const d of this.e.net.devices.values()) {
      const ifs = Array.from(d.l3.values()).filter((l) => l.kind !== 'tunnel').map((l) => l.id).sort(cmp);
      if (ifs.length) this.e.note('link', 'link', d.id, '', 'interfaces up', 'up', `${d.id}: ${ifs.join(', ')} up (fresh start: empty ARP, neighbour and MAC tables, every adjacency down)`, 0);
    }
    for (const h of this.bootHooks) h();
    const list = Array.from(this.sessions.values()).sort((a, b) => cmp(a.key, b.key));
    for (const s of list) {
      this.timersNote(s);
      const jitter = 200 + Math.floor(this.e.random() * 1500);
      this.e.at(jitter, () => this.startSession(s));
    }
    // the tables' timers: a sweep every second
    const sweep = (): void => {
      this.e.sweep();
      this.e.after(1000, sweep);
    };
    this.e.at(1000, sweep);
    this.e.startConfigured();
  }

  /** Start a session once (a message that arrives before its own start starts it first). */
  private startSession(s: Sess): void {
    if (s.x.started) return;
    s.x.started = true;
    (this.behaviours.get(s.profile.behaviour) as Behaviour).start(this, s);
  }

  // ------------------------------------------------------------ timers

  /**
   * A timer of a session's profile, in the order of precedence of params.ts:
   * the relation's own value for this device (configured), else the
   * parameter it follows (the device's attribute, the simulation's value or
   * its default; a derived timer is its factor × that), else the profile's
   * default. A count (a multiplier, retries) is kept as n × 1000.
   */
  timer(s: Sess | null, profile: SimProfile, key: string, device?: string): TimerValue {
    const def = profile.timers.find((t) => t.key === key);
    const count = /multiplier|retries/.test(key);
    const show = (ms: number): string => (count ? String(Math.round(ms / 1000)) : fmtSec(ms));
    const dev = device || (s ? s.dev : undefined);
    const own = (k: string, param?: string): number | null => {
      if (!s || !param) return null;
      const v = relParam(s.rel, param, dev || s.dev);
      if (v === undefined) return null;
      const c = /multiplier|retries/.test(k);
      const ms = c ? (/^[0-9]+$/.test(v.trim()) ? Number(v) * 1000 : null) : parseDuration(v, k === 'interval' ? 'ms' : 's');
      return ms !== null && ms > 0 ? ms : null;
    };
    const ms = own(key, def && def.param);
    if (ms !== null) return { ms, dflt: false, text: `${show(ms)} (configured)`, source: 'configured' };
    const map = TIMER_PARAMS[profile.id + '.' + key];
    if (map) {
      // a derived timer follows its base's configured value too (OSPF: dead = 4 × the relation's hello)
      if (map.factor) {
        const baseKey = Object.keys(TIMER_PARAMS).find((k) => k.indexOf(profile.id + '.') === 0 && TIMER_PARAMS[k].key === map.key && !TIMER_PARAMS[k].factor);
        const bdef = baseKey ? profile.timers.find((t) => t.key === baseKey.slice(profile.id.length + 1)) : undefined;
        const base = bdef ? own(bdef.key, bdef.param) : null;
        if (base !== null) return { ms: base * map.factor, dflt: false, text: `${show(base * map.factor)} (${map.factor} × the configured ${bdef ? bdef.label.toLowerCase() : 'base'})`, source: 'configured' };
      }
      const r = this.e.params.get(map.key, dev);
      const v = Number(r.value) * (r.def.kind === 'count' ? 1000 : 1) * (map.factor || 1);
      return { ms: v, dflt: r.source === 'default', text: `${show(v)} (${map.factor ? map.factor + ' × ' + r.def.label.replace(/ interval| time$/i, '').toLowerCase() + ', ' : ''}${r.source === 'default' ? 'default, ' + r.def.source : sourceText(r)})`, source: r.source };
    }
    const dflt = def ? def.seconds * 1000 : 1000;
    return { ms: dflt, dflt: true, text: `${show(dflt)} (default${def ? ', ' + def.source : ''})`, source: 'default' };
  }

  /** A simulation parameter in effect for a device (params.ts), for behaviours whose timers are not a profile's. */
  param(key: string, dev?: string): Resolved {
    return this.e.params.get(key, dev);
  }

  paramText(r: Resolved): string {
    return `${formatValue(r.def, r.value)} (${sourceText(r)})`;
  }

  /**
   * Run fn every interval() ms while alive() (first after `first` ms; 0: at
   * once). The interval is read again after every run, and a parameter
   * change reschedules the next run at once (from the last run with the new
   * interval, or now when that is past).
   */
  periodic(alive: () => boolean, interval: () => number, fn: () => void, first = 0): void {
    const p: Periodic = { alive, interval, fn, last: this.e.now, iv: interval(), token: 0 };
    if (this.periodics.length > 64 && this.periodics.length % 64 === 0) this.periodics = this.periodics.filter((x) => x.alive());
    this.periodics.push(p);
    if (first <= 0) this.fire(p, 0);
    else this.schedule(p, this.e.now + first);
  }

  private schedule(p: Periodic, t: number): void {
    const tok = ++p.token;
    this.e.at(t, () => this.fire(p, tok));
  }

  private fire(p: Periodic, tok: number): void {
    if (p.token !== tok || !p.alive()) return;
    p.fn();
    p.last = this.e.now;
    p.iv = Math.max(1, p.interval());
    this.schedule(p, p.last + p.iv);
  }

  /** Parameters changed: periodic timers whose interval changed are rescheduled now; the sessions' details again. */
  paramsChanged(changes: ParamChange[]): void {
    void changes;
    this.periodics = this.periodics.filter((p) => p.alive());
    for (const p of this.periodics) {
      const iv = Math.max(1, p.interval());
      if (iv === p.iv) continue;
      p.iv = iv;
      this.schedule(p, Math.max(this.e.now, p.last + iv));
    }
    for (const s of Array.from(this.sessions.values()).sort((a, b) => cmp(a.key, b.key))) {
      const b = this.behaviours.get(s.profile.behaviour);
      if (b && b.refresh && s.x.started) b.refresh(this, s);
    }
  }

  // ------------------------------------------------------------ devices powered off and on

  /** A device was powered off: its sessions go down (their timers stop); the peers notice by their own timers or the dark cable. */
  deviceDown(dev: string): void {
    for (const s of Array.from(this.sessions.values()).sort((a, b) => cmp(a.key, b.key))) {
      if (s.dev !== dev) continue;
      this.restart(s);
      this.setState(s, s.profile.states[0] || 'Down', false, `${dev} was powered off`);
      s.x = {};
    }
    for (const k of Array.from(this.vips.keys())) if (k.indexOf(dev + ':') === 0) this.vips.delete(k);
    for (const h of this.deviceHooks) h(dev, false);
  }

  /** A device has booted: its sessions start afresh. */
  deviceUp(dev: string): void {
    for (const h of this.deviceHooks) h(dev, true);
    for (const s of Array.from(this.sessions.values()).sort((a, b) => cmp(a.key, b.key))) {
      if (s.dev !== dev) continue;
      this.restart(s);
      s.x = {};
      s.heard = -1;
      const jitter = 100 + Math.floor(this.e.random() * 400);
      const g = s.gen;
      this.e.after(jitter, () => {
        if (s.gen === g) this.startSession(s);
      });
    }
  }

  /** The event log's note of the timers a session uses (where each comes from). */
  private timersNote(s: Sess): void {
    if (!s.initiator && s.profile.behaviour !== 'ospf' && s.profile.behaviour !== 'bfd') return;
    const parts = s.profile.timers.filter((t) => t.key !== 'retries' && t.key !== 'dpd-retries').map((t) => `${t.label.toLowerCase()} ${this.timer(s, s.profile, t.key).text}`);
    if (!parts.length) return;
    this.e.note('note', s.protocol, s.dev, s.peer, 'timers', '', `${s.profile.label} ${s.rel.id} at ${s.dev}: ${parts.join('; ')}`, 0);
  }

  // ------------------------------------------------------------ states

  /** A session's state changes (logged; routing is recomputed when its adjacency comes up or goes down). */
  setState(s: Sess, state: string, up: boolean, why: string): void {
    if (s.state === state && s.up === up) return;
    const was = this.adjUpOf(s);
    s.state = state;
    s.up = up;
    s.since = this.e.now;
    this.e.note('state', s.protocol, s.dev, s.peer, state, state, `${s.profile.label} ${s.rel.id}: ${s.dev} → ${s.peer} ${state}${why ? ' (' + why + ')' : ''}`);
    if (was !== this.adjUpOf(s)) this.e.routingChanged();
  }

  private adjUpOf(s: Sess): boolean {
    const b = this.behaviours.get(s.profile.behaviour);
    return b && b.adjUp ? b.adjUp(this, s) : s.up;
  }

  /** Restart a session (timers of the old generation do nothing). */
  restart(s: Sess): void {
    s.gen++;
  }

  /**
   * A session's dead timer: `dead` runs once nothing was heard from the peer
   * for `ms`. Every call (on each message heard) moves the deadline; one
   * timer per session and key, re-armed until the deadline passes.
   */
  armDead(s: Sess, ms: number, dead: () => void, key = 'dead'): void {
    const k = '__' + key;
    const st = (s.x[k] as { at: number; gen: number; pending: boolean } | undefined) || { at: 0, gen: s.gen, pending: false };
    s.x[k] = st;
    st.at = this.e.now + ms;
    st.gen = s.gen;
    if (st.pending) return;
    st.pending = true;
    const fire = (): void => {
      if (st.gen !== s.gen) {
        st.pending = false;
        return;
      }
      if (this.e.now >= st.at) {
        st.pending = false;
        dead();
        return;
      }
      this.e.at(st.at, fire);
    };
    this.e.at(st.at, fire);
  }

  /** Run fn after ms if the session is still in the same generation. */
  later(s: Sess, ms: number, fn: () => void): void {
    const g = s.gen;
    this.e.after(ms, () => {
      if (s.gen === g) fn();
    });
  }

  // ------------------------------------------------------------ messages

  /** A message of a session. */
  msg(s: Sess, type: string, detail: string, data: { [k: string]: unknown } = {}): Msg {
    const label = `${s.profile.label.replace(/ \(.*\)$/, '').replace(/ \/ .*$/, '')} ${type}`;
    return { protocol: s.protocol, type, label, detail: `${s.profile.label} ${type}: ${detail}`, relation: s.rel.id, data: { from: s.dev, ...data } };
  }

  /** Unicast to the peer (its address), along the routing tables. */
  unicast(s: Sess, type: string, detail: string, data: { [k: string]: unknown } = {}, state = ''): void {
    const m = this.msg(s, type, `${s.dev} (${formatAddr(s.local.addr)}) → ${s.peer} (${formatAddr(s.remote.addr)}), ${s.profile.proto}; ${detail}`, data);
    this.e.note('message', s.protocol, s.dev, s.peer, type, state, m.detail);
    const pkt = this.e.newPacket(s.local.addr, s.remote.addr, s.local.l3.vrf, m, [s.rel.id]);
    this.lane(s.rel, s.dev, s.peer, m, this.e.estimate(s.dev, s.remote.addr));
    this.e.send(s.dev, pkt);
  }

  /** Multicast to a group out of the session's interface (OSPF Hello …): the peers on the segment receive it. */
  multicast(s: Sess, group: IpAddr, type: string, detail: string, data: { [k: string]: unknown } = {}, state = ''): void {
    const m = this.msg(s, type, `${s.dev} (${formatAddr(s.local.addr)}) → ${formatAddr(group)} on ${s.local.l3.id}, ${s.profile.proto}; ${detail}`, data);
    this.e.note('message', s.protocol, s.dev, s.peer, type, state, m.detail);
    const pkt = this.e.newPacket(s.local.addr, group, s.local.l3.vrf, m, [s.rel.id], 1);
    // the logical view: towards every peer of the relation on that segment
    const peers = (this.byRel.get(s.rel.id) || []).filter((x) => x.dev === s.dev).map((x) => x.peer);
    for (const p of peers) this.lane(s.rel, s.dev, p, m, s.local.l3.kind === 'tunnel' ? this.e.estimate(s.dev, (this.sess(s.protocol, s.rel.id, s.dev, p) as Sess).remote.addr) : 2 * this.e.hopTime());
    this.e.send(s.dev, pkt, s.local.l3);
  }

  /** A link-local layer-2 PDU out of a port (LACP, LLDP …). */
  onPort(protocol: string, dev: string, port: string, dstMac: string, type: string, label: string, detail: string, data: { [k: string]: unknown }, peer: string, rel?: Relation): void {
    const sd = this.sd(dev);
    const l3mac = this.e.net.macs.get(dev + ':' + port);
    const src = l3mac ? l3mac.mac : sd.bridgeId.split('.')[1] || '00:00:00:00:00:00';
    const m: Msg = { protocol, type, label, detail, relation: rel ? rel.id : undefined, data: { from: dev, port, ...data } };
    this.e.note('message', protocol, dev, peer, type, '', detail);
    if (rel) this.lane(rel, dev, peer, m, this.e.hopTime());
    this.e.sendOnPort(dev, port, { src, dst: dstMac, msg: m, l2: true });
  }

  /** The logical view's dot of a message along its relation: its lane (two devices) or its hub's spokes. */
  lane(rel: Relation, from: string, to: string, m: Msg, ms: number): void {
    const t0 = this.e.now;
    const t1 = t0 + Math.max(this.e.hopTime(), ms);
    const devs = relationDevices(rel);
    if (devs.length < 3) {
      this.e.flight(t0, t1, m, 'logical', { ref: 'relation:' + rel.id, from, to });
      return;
    }
    const mid = (t0 + t1) / 2;
    const f = this.e.flight(t0, mid, m, 'logical', { ref: 'relation:' + rel.id, from, to: 'hub' });
    this.e.flight(mid, t1, m, 'logical', { ref: 'relation:' + rel.id, from: 'hub', to }, f.id);
  }

  // ------------------------------------------------------------ the engine asks

  ip(dev: string, l3: L3Iface, pkt: Pkt): void {
    this.dispatch(dev, l3, pkt.msg, pkt, null);
  }

  l2(dev: string, port: string, frame: Frame): void {
    const sd = this.sd(dev);
    const l3 = sd.l3.get(port) || null;
    this.dispatch(dev, l3, frame.msg, null, frame);
  }

  private dispatch(dev: string, l3: L3Iface | null, msg: Msg, pkt: Pkt | null, frame: Frame | null): void {
    const h = this.handlers.get(msg.protocol);
    if (h) {
      h(dev, l3, msg, pkt, frame);
      return;
    }
    const data = (msg.data || {}) as MsgData;
    if (!msg.relation || !data.from) return;
    const s = this.sess(msg.protocol, msg.relation, dev, data.from);
    if (!s) {
      const f = this.fallback.get(msg.protocol);
      if (f) f(dev, l3, msg, pkt);
      return;
    }
    this.startSession(s);
    s.heard = this.e.now;
    const b = this.behaviours.get(s.profile.behaviour) as Behaviour;
    b.rx(this, s, msg, pkt, l3);
  }

  ifaceChange(dev: string, l3: L3Iface, up: boolean): void {
    for (const s of Array.from(this.sessions.values()).sort((a, b) => cmp(a.key, b.key))) {
      if (s.dev !== dev || s.local.l3.id !== l3.id) continue;
      const b = this.behaviours.get(s.profile.behaviour) as Behaviour;
      if (b.iface) b.iface(this, s, up);
    }
    for (const h of this.ifaceHooks) h(dev, l3, up);
    // an interface that comes up again announces itself
    if (up && l3.kind !== 'tunnel' && l3.kind !== 'loopback') for (const a of l3.addrs) this.e.gratuitous(dev, l3, a.addr, l3.mac, `${l3.id} came up`);
  }

  linkChange(ref: string, up: boolean): void {
    for (const h of this.linkHooks) h(ref, up);
  }

  relUp(id: string): boolean {
    const list = this.byRel.get(id);
    if (!list || !list.length) return true;
    return list.some((s) => this.adjUpOf(s));
  }

  adjUp(relation: string, from: string, to: string): boolean {
    const list = this.byRel.get(relation);
    if (!list || !list.length) return true;
    const s = list.find((x) => x.dev === from && x.peer === to);
    const o = list.find((x) => x.dev === to && x.peer === from);
    if (!s && !o) return true;
    return (!!s && this.adjUpOf(s)) && (!o || this.adjUpOf(o));
  }

  owns(dev: string, iface: string): Array<{ addr: IpAddr; mac: string; protocol: string }> {
    return this.vips.get(dev + ':' + iface) || [];
  }

  tunnelUp(dev: string, iface: string): boolean {
    // a tunnel interface is up unless its tunnel's own keepalives say it is down (GRE with keepalives …)
    const rel = this.m.relations.find((r) => (r.category === 'tunnel' || r.category === 'overlay') && r.endpoints.some((x) => x.device === dev && x.iface === iface));
    if (!rel) return true;
    if (!this.e.relationUp(rel.id)) return false;
    const s = (this.byRel.get(rel.id) || []).find((x) => x.dev === dev);
    if (!s || s.profile.behaviour !== 'session' || !s.profile.keepalive) return true;
    return s.up;
  }

  sessionUp(relation: string): boolean {
    const list = this.byRel.get(relation);
    if (!list || !list.length) return true;
    const p = list[0].profile;
    // IPsec carries traffic only once its SAs are established
    if (p.behaviour === 'ike') return list.some((s) => s.up);
    return true;
  }

  // ------------------------------------------------------------ status

  status(): SessionStatus[] {
    const out: SessionStatus[] = [];
    for (const s of Array.from(this.sessions.values()).sort((a, b) => cmp(a.protocol, b.protocol) || cmp(a.rel.id, b.rel.id) || cmp(a.dev, b.dev) || cmp(a.peer, b.peer))) {
      const detail = typeof s.x.detail === 'string' ? (s.x.detail as string) : '';
      out.push({ protocol: s.protocol, name: `${s.rel.id}: ${s.dev} → ${s.peer}`, device: s.dev, peer: s.peer, state: s.state, detail: detail + (s.since ? `${detail ? ' · ' : ''}since ${fmtSec(s.since)}` : ''), up: s.up, relation: s.rel.id });
    }
    for (const f of this.extraStatus) out.push(...f());
    return out;
  }
}

/** The profile a relation's protocol simulates (a custom one for a protocol without a built-in profile). */
export function relationProfile(m: Model, r: Relation): SimProfile {
  const base = protocolBase(m.protocols, r.protocol);
  const p = simProfile(base);
  if (p) return p;
  const def = lookupProtocol(m.protocols, r.protocol, r.category);
  return customProfile('custom:' + base, def.label);
}

function sameNet(a: SimAddr, b: SimAddr): boolean {
  return a.net.prefix === b.net.prefix && compareAddr(a.net, b.net) === 0 && compareAddr(a.addr, b.addr) !== 0;
}

function netText(a: SimAddr): string {
  return formatAddr(a.net) + '/' + a.net.prefix;
}

/** "300ms", "1s", "1.5", "40" → ms (a bare number in `unit`); null when it isn't one. */
export function parseDuration(text: string, unit: 'ms' | 's'): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|s|sec|min|m|h)?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const u = (m[2] || unit).toLowerCase();
  return Math.round(u === 'ms' ? n : u === 'min' || u === 'm' ? n * 60000 : u === 'h' ? n * 3600000 : n * 1000);
}
