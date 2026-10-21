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
import { IpAddr, parseAddress } from '../../model/ip';
import { lookupProtocol, protocolBase } from '../../model/protocols';
import { SimProfile, customProfile, simProfile } from '../../model/sim-profiles';
import { Model, Relation, relationDevices } from '../../model/types';
import { compareAddr, formatAddr, inPrefix } from '../ipmath';
import { DvTables, isisCircuit, relParam, routingProtocol } from '../routing';
import { RipSim } from './rip';
import { Engine, Frame, IcmpKind, Protocols, fmtSec, hashIndex } from './engine';
import { L3Iface, SimDevice, SimAddr, portKey } from './net';
import { ParamChange, Resolved, formatValue, ifaceRef, relRef, sourceText } from './params';
import { L4, Msg, Pkt, SessionStatus, SnoopResult } from './types';
import { serviceRelations, upstreamOf } from './service-relations';
import type { Transport } from './transport';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Behaviours whose sessions need a common network (hellos to a link-local group, single-hop BFD). */
const LINK_LOCAL = ['ospf', 'isis', 'eigrp', 'rip', 'pim', 'ldp', 'bfd', 'igmp'];

/**
 * What a router knows of another router (or of itself) in one routing
 * instance (a protocol in a VRF, `inst` "ospf|"): that origin's adjacencies
 * of the instance that are up ("relation|peer") and its interfaces that
 * are up, with the origin's sequence number of the instance and the time
 * it made the record. A router computes its routes from the records it has
 * (Engine.recompute): an origin's change reaches it only with an
 * advertisement of that instance that carries the new record.
 */
export interface RouteRec {
  origin: string;
  inst: string;
  seq: number;
  at: number;
  adj: string[];
  up: string[];
}

function sameRec(a: RouteRec, b: RouteRec): boolean {
  return a.adj.join(',') === b.adj.join(',') && a.up.join(',') === b.up.join(',');
}

function copyRec(r: RouteRec): RouteRec {
  return { origin: r.origin, inst: r.inst, seq: r.seq, at: r.at, adj: r.adj.slice(), up: r.up.slice() };
}

/** The update message of a routing protocol's advertisements, and the acknowledgment it waits for (none: RIP). */
const UPDATE_OF: { [behaviour: string]: { type: string; ack?: string } } = {
  ospf: { type: 'LSU', ack: 'LSAck' },
  isis: { type: 'LSP', ack: 'PSNP' },
  eigrp: { type: 'Update', ack: 'ACK' },
};
/** An unacknowledged advertisement is sent again after this (OSPF's RxmtInterval 5 s; IS-IS and EIGRP alike in the simulation). */
/** A reliable advertisement (an LSU, LSP, EIGRP Update) unacknowledged is sent again after this (ms). */
export const ADV_RXMT = 5000;
/** EIGRP's active timer (RFC 7868 §5.5: 3 min): a neighbour that has not replied to a Query by then is reset (stuck in active). */
const EIGRP_ACTIVE = 180000;

/** One side of a session: the device, the interface it uses and its address there. */
export interface Side {
  dev: string;
  l3: L3Iface;
  /** its IP address for the session; null: none (IS-IS on an interface of a router without any IP address — its PDUs are frames) */
  addr: IpAddr | null;
}

/**
 * A side's IP address, for what sends or reads IP: every session but
 * IS-IS's on a router without IP addresses has one (pairSides); asking
 * for one that has none is a defect, never a made-up address.
 */
export function ipOf(x: Side): IpAddr {
  if (!x.addr) throw new Error(`${x.dev}:${x.l3.id} has no IP address: a session without one sends and reads no IP`);
  return x.addr;
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
  /** send routing records to the peer its own way (BGP: an UPDATE over its TCP connection); else ProtocolSim's update message */
  advertise?(P: ProtocolSim, s: Sess, recs: RouteRec[], why: string): void;
  /** may this message of the session teach the router now (its state machine's say; default: the session is up) */
  learns?(P: ProtocolSim, s: Sess, msg: Msg): boolean;
  /** the states besides an adjacency that is up in which a change is flooded to the neighbour too (OSPF: Exchange and Loading, RFC 2328 §13.3) */
  floodsDuring?: string[];
  /** send one of its unicast messages its own way (IS-IS: a frame on the link, no IP); else ProtocolSim.unicast */
  send?(P: ProtocolSim, s: Sess, type: string, detail: string, data: { [k: string]: unknown }): void;
}

export interface TimerValue {
  ms: number;
  /** the built-in default (no configured, device or simulation value) */
  dflt: boolean;
  /** "10 s (configured)", "40 s (4 × hello, simulation)", "300 ms (default, …)" */
  text: string;
  source: 'configured' | 'object' | 'device' | 'simulation' | 'default';
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
  /** the device whose jitter stream its timer draws from (the one it runs for) */
  scope: string;
  alive: () => boolean;
  interval: () => number;
  fn: () => void;
  /** when it last ran (or was set up) */
  last: number;
  /** the interval it is scheduled with */
  iv: number;
  token: number;
  /** when it is due, without its jitter (the next one counts from here, so the jitter never adds up) */
  next: number;
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
  /** a protocol's own handling of what arrives (a handler that returns false passes a message on to its relation's session) */
  readonly handlers = new Map<string, (dev: string, l3: L3Iface | null, msg: Msg, pkt: Pkt | null, frame: Frame | null) => void | boolean>();
  /** handlers of a protocol's messages that belong to no session (a PIM Register to the RP) */
  readonly fallback = new Map<string, (dev: string, l3: L3Iface | null, msg: Msg, pkt: Pkt | null) => void>();
  readonly ifaceHooks: Array<(dev: string, l3: L3Iface, up: boolean) => void> = [];
  readonly linkHooks: Array<(ref: string, up: boolean) => void> = [];
  readonly bootHooks: Array<() => void> = [];
  /** a device was powered off (false) or has booted (true) */
  readonly deviceHooks: Array<(dev: string, up: boolean) => void> = [];
  /** the transport layer (transport.ts): a firewall's policy, a sender's own errors, closed ports, the sweep */
  filterHook: ((dev: string, pkt: Pkt, from: L3Iface, to: L3Iface) => boolean) | null = null;
  localErrorHook: ((dev: string, pkt: Pkt, kind: IcmpKind, text: string, mtu?: number) => void) | null = null;
  portHook: ((dev: string, pkt: Pkt, l3: L3Iface) => boolean) | null = null;
  readonly sweepHooks: Array<() => void> = [];
  /** multicast (multicast.ts): a switch's snooping, a router's multicast routing, the RPF check after a route change */
  snoopHook: ((sd: SimDevice, from: string | null, vlan: number, frame: Frame, t: number) => SnoopResult | null) | null = null;
  mrouteHook: ((dev: string, l3: L3Iface, pkt: Pkt) => boolean) | null = null;
  readonly routesHooks: Array<(dev: string) => void> = [];
  /** PIM messages of a session that multicast.ts handles (Join/Prune, Graft): true when it did */
  pimHook: ((s: Sess, msg: Msg, l3: L3Iface | null) => boolean) | null = null;
  /** the transport (transport.ts): the connections of the protocols over TCP (proto-tcp.ts), and every TCP segment it receives */
  transport: Transport | null = null;
  tcpHook: ((dev: string, l3: L3Iface, pkt: Pkt) => void) | null = null;
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
    const fb = fa ? firstOf(lb, ipOf(fa).version) : null;
    if (fa && fb) return { a: fa, b: fb, shared: false };
    return null;
  }

  /**
   * The sides of a relation that asks one exact address (an NTP upstream, service-relations.ts): the server is
   * that address on the interface that has it; the client sends from its address of the same family on a network
   * it shares with that address, else from the one it would use towards the server (pairSides, the same family).
   * Never another address of the server. Null: not such a relation (or the address is gone from the server).
   */
  private exactSides(r: Relation, a: string, b: string): { a: Side; b: Side; shared: boolean } | null {
    const up = upstreamOf(r);
    const target = up ? parseAddress(up) : null;
    if (!target) return null;
    const sb = this.sd(b);
    const sa = this.sd(a);
    if (!sa || !sb) return null;
    const l3 = Array.from(sb.l3.values()).find((l) => l.addrs.some((x) => compareAddr(x.addr, target) === 0));
    if (!l3) return null;
    const server: Side = { dev: b, l3, addr: target as IpAddr };
    const own = Array.from(sa.l3.values()).sort((x, y) => cmp(x.id, y.id));
    for (const l of own) for (const x of l.addrs) if (l.kind !== 'loopback' && x.addr.version === target.version && inPrefix(x.net, target as IpAddr)) return { a: { dev: a, l3: l, addr: x.addr }, b: server, shared: true };
    const p = this.pairSides(r, a, b);
    if (p && ipOf(p.a).version === target.version) return { a: p.a, b: server, shared: false };
    for (const l of own) for (const x of l.addrs) if (l.kind !== 'loopback' && x.addr.version === target.version) return { a: { dev: a, l3: l, addr: x.addr }, b: server, shared: false };
    return null;
  }

  /**
   * IS-IS's circuit between two routers (routing.ts isisCircuit: their
   * interfaces that one's frames reach, over a cable or through bridges,
   * the relation's endpoint interfaces when written) — its adjacency forms
   * there whatever the IP addressing. Each side's address is only for the
   * log and IP next hops: its interface's own, else (unnumbered) the
   * router's identity (a loopback's, else its first address), else none —
   * a router with a NET and no IP address at all still forms the
   * adjacency; no address is made up for it.
   */
  linkSides(r: Relation, a: string, b: string): { a: Side; b: Side } | null {
    const sa = this.sd(a);
    const sb = this.sd(b);
    if (!sa || !sb) return null;
    const eps = (dev: string): string[] | null => {
      const l = r.endpoints.filter((x) => x.device === dev && x.iface !== undefined).map((x) => x.iface as string);
      return l.length ? l : null;
    };
    const own = (sd: SimDevice): IpAddr | null => {
      const all = Array.from(sd.l3.values()).sort((x, y) => Number(y.kind === 'loopback') - Number(x.kind === 'loopback') || cmp(x.id, y.id));
      for (const l of all) for (const ad of l.addrs) if (ad.addr.version === 4) return ad.addr;
      for (const l of all) if (l.addrs.length) return l.addrs[0].addr;
      return null;
    };
    const c = isisCircuit(this.m, a, b, eps(a), eps(b));
    const la = c ? sa.l3.get(c.a) : undefined;
    const lb = c ? sb.l3.get(c.b) : undefined;
    if (!la || !lb) return null;
    return { a: { dev: a, l3: la, addr: la.addrs.length ? la.addrs[0].addr : own(sa) }, b: { dev: b, l3: lb, addr: lb.addrs.length ? lb.addrs[0].addr : own(sb) } };
  }

  /** Build the sessions of every relation (each pair, each side). */
  build(): void {
    // the model's relations, then the exchanges its services imply (service-relations.ts: not drawn, not in the model)
    const owner = (client: string, address: string): string | null => {
      const a = parseAddress(address);
      return a ? this.e.ownerSeenFrom(client, '', a as IpAddr) : null;
    };
    for (const r of this.m.relations.slice().sort((x, y) => cmp(x.id, y.id)).concat(serviceRelations(this.m, owner))) {
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
      for (const [a, b] of pairs) this.buildPair(r, profile, a, b);
    }
  }

  /** the pairs of a relation that wait for a DHCP client's lease (their sessions are built when it has one) */
  private deferred: Array<{ r: Relation; profile: SimProfile; a: string; b: string }> = [];

  /** The sessions of one pair of a relation's endpoints (none: why is noted). */
  private buildPair(r: Relation, profile: SimProfile, a: string, b: string): Sess[] {
    // IS-IS forms its adjacency on the link itself (its PDUs are frames, not IP): the interfaces of a cable between the two,
    // whatever their IP addresses (other subnets, none at all)
    const l2 = profile.behaviour === 'isis' ? this.linkSides(r, a, b) : null;
    const sides = l2 ? { a: l2.a, b: l2.b, shared: true } : this.exactSides(r, a, b) || this.pairSides(r, a, b);
    if (!sides) {
      // a DHCP client without its lease yet: its sessions wait for it
      const lease = [a, b].find((x) => !!this.e.waitsForLease(x));
      if (lease) {
        this.deferred.push({ r, profile, a, b });
        this.e.note('wait', profile.id, a, b, 'waiting', '', `${r.id}: ${profile.label} between ${a} and ${b} waits for ${lease}'s DHCP lease (${lease}:${this.e.waitsForLease(lease)})`, 0);
        return [];
      }
      // a protocol of the model's own between devices without addresses: its packets go as frames over their cable (proto-other.ts installCustomL2)
      if (profile.behaviour === 'custom' && this.m.links.some((l) => (l.a.device === a && l.b.device === b) || (l.a.device === b && l.b.device === a))) return [];
      this.e.note('note', profile.id, a, b, 'not simulated', '', `${r.id}: ${a} and ${b} have no addresses to exchange ${profile.label} messages with`, 0);
      return [];
    }
    // link-local protocols (hellos to a multicast group, single-hop BFD) only pair devices on a common network
    if (!sides.shared && LINK_LOCAL.indexOf(profile.behaviour) >= 0 && !(profile.behaviour === 'ldp' && profile.id !== 'ldp')) {
      this.e.note('note', profile.id, a, b, 'no adjacency', '', `${r.id}: ${a} and ${b} have no network in common, so no ${profile.label} adjacency forms between them`, 0);
      return [];
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
    const s1 = this.add(r, profile, sides.a, sides.b, true);
    const s2 = this.add(r, profile, sides.b, sides.a, false);
    return [s1, s2];
  }

  /** A DHCP client got its lease: the sessions of its relations that waited for it are built and start. */
  private buildDeferred(dev: string): void {
    const ready = this.deferred.filter((x) => (x.a === dev || x.b === dev) && !this.e.waitsForLease(x.a) && !this.e.waitsForLease(x.b));
    if (!ready.length) return;
    this.deferred = this.deferred.filter((x) => ready.indexOf(x) < 0);
    for (const x of ready) for (const s of this.buildPair(x.r, x.profile, x.a, x.b)) {
      this.timersNote(s);
      this.startWhenUp(s);
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

  /**
   * Start, as a freshly booted network: every cable negotiates and its
   * interfaces come up after the link-up delay (announcing themselves with a
   * gratuitous ARP); every session starts as soon as its interface is up,
   * with a small jitter, all of them together: what doesn't depend on
   * anything else runs in parallel from the start.
   */
  start(): void {
    this.build();
    this.e.boot();
    // a freshly booted network: what has no cable to wait for is up at once, the rest when its cable is
    for (const d of this.e.net.devices.values()) {
      const ifs = Array.from(d.l3.values()).filter((l) => l.kind !== 'tunnel').sort((a, b) => cmp(a.id, b.id));
      if (!ifs.length) continue;
      const up = ifs.filter((l) => this.e.isL3Up(d.id, l.id)).map((l) => l.id);
      const later = ifs.filter((l) => !this.e.isL3Up(d.id, l.id)).map((l) => l.id);
      const parts = (up.length ? [`${up.join(', ')} up`] : []).concat(later.length ? [`${later.join(', ')} coming up (the link-up delay)`] : []);
      this.e.note('link', 'link', d.id, '', up.length && !later.length ? 'interfaces up' : 'interfaces coming up', up.length && !later.length ? 'up' : '', `${d.id}: ${parts.join('; ')} (fresh start: empty ARP, neighbour and MAC tables, every adjacency down)`, 0);
    }
    for (const h of this.bootHooks) h();
    const list = Array.from(this.sessions.values()).sort((a, b) => cmp(a.key, b.key));
    for (const s of list) {
      this.timersNote(s);
      this.startWhenUp(s);
    }
    // what waits for its link, said once per interface
    for (const k of Array.from(this.pendingStart.keys()).sort(cmp)) {
      const ss = this.pendingStart.get(k) as Sess[];
      const [dev, iface] = [ss[0].dev, ss[0].local.l3.id];
      const names = Array.from(new Set(ss.map((x) => x.profile.label))).sort(cmp);
      const kind = ss[0].local.l3.kind;
      const what = kind === 'tunnel' ? 'the tunnel to come up (what carries it first)' : `the link${kind === 'aggregate' ? ' and LACP' : ''} to come up (Layer 1: link-up delay ${this.paramText(this.param('link-up-delay', dev, ifaceRef(dev, ss[0].local.l3.ports[0] || iface)))}${kind === 'aggregate' ? '; then LACP bundles its members' : ''})`;
      this.e.note('wait', ss[0].protocol, dev, '', 'waiting', '', `${dev}:${iface}: ${names.join(', ')} wait${ss.length === 1 ? 's' : ''} for ${what}`, 0);
    }
    // the tables' timers: a sweep every second
    const sweep = (): void => {
      this.e.sweep();
      this.e.after(1000, sweep);
    };
    this.e.at(1000, sweep);
    this.e.startConfigured();
  }

  /** the sessions that wait for their interface to come up, by "device:interface" */
  private pendingStart = new Map<string, Sess[]>();
  /** what else waits for an interface ("device:interface") or a cable ("link:id") to come up */
  private pendingUp = new Map<string, Array<() => void>>();

  /**
   * Run `fn` once a device's interface is up: now (with a small jitter) when
   * it is, else as soon as it comes up (Layer 1: nothing is sent before).
   */
  whenIfaceUp(dev: string, iface: string, fn: () => void): void {
    if (this.e.isL3Up(dev, iface) && this.e.addressReady(dev, iface)) {
      this.e.at(this.e.now + this.e.jitter(dev), fn);
      return;
    }
    const k = dev + ':' + iface;
    this.pendingUp.set(k, (this.pendingUp.get(k) || []).concat([fn]));
  }

  /** Run `fn` once the cable at a device's port is up (LACP, the spanning tree, LLDP …). */
  whenPortUp(dev: string, port: string, fn: () => void): void {
    const e = this.e.net.ends.get(portKey(dev, port));
    if (!e || this.e.linkUp(e.link)) {
      this.e.at(this.e.now + this.e.jitter(dev), fn);
      return;
    }
    const k = 'link:' + e.link;
    this.pendingUp.set(k, (this.pendingUp.get(k) || []).concat([fn]));
  }

  /** Run `fn` once the first of a device's cabled ports is up (a switch's own messages: its snooping querier). */
  whenAnyPortUp(dev: string, fn: () => void): void {
    const ports = Array.from(this.e.net.ends.values()).filter((x) => x.device === dev).map((x) => x.port).sort(cmp);
    if (!ports.length) {
      this.e.at(this.e.now + this.e.jitter(dev), fn);
      return;
    }
    let done = false;
    for (const p of ports)
      this.whenPortUp(dev, p, () => {
        if (done) return;
        done = true;
        fn();
      });
  }

  /** What waited for this interface or cable runs now, together (each with its small jitter). */
  private releaseUp(k: string): void {
    const list = this.pendingUp.get(k);
    if (!list) return;
    this.pendingUp.delete(k);
    // (the jitter of the interface's device, or of the cable)
    const scope = k.indexOf('link:') === 0 ? k : k.split(':')[0];
    for (const fn of list) this.e.at(this.e.now + this.e.jitter(scope), fn);
  }

  /** Start a session as soon as its interface is up (with a small jitter); until then it sends nothing. */
  private startWhenUp(s: Sess): void {
    // a tunnel's own session (GRE's keepalives …) runs over the interface of the tunnel's source; what runs inside the tunnel waits for the tunnel
    const iface = this.ownTunnel(s) ? this.underlay(s.dev, s.local.l3.id) : s.local.l3.id;
    if (iface !== s.local.l3.id) {
      if (!iface || this.e.isL3Up(s.dev, iface)) this.e.at(this.e.now + this.e.jitter(s.dev), () => this.startSession(s));
      else this.whenIfaceUp(s.dev, iface, () => this.startSession(s));
      return;
    }
    // (a DHCP client's interface: once it has its lease)
    if (this.e.isL3Up(s.dev, s.local.l3.id) && this.e.addressReady(s.dev, s.local.l3.id)) {
      this.e.at(this.e.now + this.e.jitter(s.dev), () => this.startSession(s));
      return;
    }
    const k = s.dev + ':' + s.local.l3.id;
    const list = this.pendingStart.get(k) || [];
    list.push(s);
    this.pendingStart.set(k, list);
  }

  /** Is a session its tunnel interface's own (the tunnel relation, whose keepalives say whether the tunnel is up)? */
  private ownTunnel(s: Sess): boolean {
    return s.local.l3.kind === 'tunnel' && (s.rel.category === 'tunnel' || s.rel.category === 'overlay');
  }

  /** The interface a tunnel's source address is on (its underlay); null when there is none to wait for. */
  private underlay(dev: string, tun: string): string | null {
    const ends = this.e.tunnelEnds(dev, tun);
    if (!ends.length) return null;
    const sd = this.sd(dev);
    const l = Array.from(sd.l3.values()).find((x) => x.kind !== 'tunnel' && x.addrs.some((a) => compareAddr(a.addr, ends[0].src) === 0));
    return l ? l.id : null;
  }

  /** Start a session once (a message that arrives before its own start starts it first). */
  private startSession(s: Sess): void {
    if (s.x.started) return;
    s.x.started = true;
    const was = this.scopeDev;
    this.scopeDev = s.dev;
    try {
      (this.behaviours.get(s.profile.behaviour) as Behaviour).start(this, s);
    } finally {
      this.scopeDev = was;
    }
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
      const r = this.e.params.get(map.key, dev, null, s ? relRef(s.rel.id) : null);
      const v = Number(r.value) * (r.def.kind === 'count' ? 1000 : 1) * (map.factor || 1);
      return { ms: v, dflt: r.source === 'default', text: `${show(v)} (${map.factor ? map.factor + ' × ' + r.def.label.replace(/ interval| time$/i, '').toLowerCase() + ', ' : ''}${r.source === 'default' ? 'default, ' + r.def.source : sourceText(r)})`, source: r.source };
    }
    const dflt = def ? def.seconds * 1000 : 1000;
    return { ms: dflt, dflt: true, text: `${show(dflt)} (default${def ? ', ' + def.source : ''})`, source: 'default' };
  }

  /** A simulation parameter in effect for a device (params.ts), for behaviours whose timers are not a profile's. */
  /** A parameter in effect for a device, or at one of its objects (`at`: ifaceRef, vlanRef, relRef). */
  param(key: string, dev?: string, at?: string | null): Resolved {
    return this.e.params.get(key, dev, null, at);
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
  /** the device a session start or a message is being handled for: a periodic timer set up meanwhile is that device's (its jitter stream) */
  private scopeDev = '';

  periodic(alive: () => boolean, interval: () => number, fn: () => void, first = 0, scope = this.scopeDev): void {
    const p: Periodic = { scope, alive, interval, fn, last: this.e.now, iv: interval(), token: 0, next: this.e.now };
    if (this.periodics.length > 64 && this.periodics.length % 64 === 0) this.periodics = this.periodics.filter((x) => x.alive());
    this.periodics.push(p);
    if (first <= 0) this.fire(p, 0);
    else this.schedule(p, this.e.now + first);
  }

  private schedule(p: Periodic, t: number): void {
    const tok = ++p.token;
    p.next = t;
    // a small jitter, as real protocols jitter their timers (never adding up: the next one counts from `next`)
    this.e.at(t + this.e.jitter(p.scope), () => this.fire(p, tok));
  }

  private fire(p: Periodic, tok: number): void {
    if (p.token !== tok || !p.alive()) return;
    p.fn();
    p.last = tok === 0 ? this.e.now : p.next;
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
    this.forget(dev);
    for (const h of this.deviceHooks) h(dev, false);
  }

  /**
   * A device has booted: its sessions start afresh — each when its interface is up again (its cable's link-up
   * delay after the boot), as at the start of the simulation, never sending before.
   */
  deviceUp(dev: string): void {
    for (const h of this.deviceHooks) h(dev, true);
    for (const s of Array.from(this.sessions.values()).sort((a, b) => cmp(a.key, b.key))) {
      if (s.dev !== dev) continue;
      this.restart(s);
      s.x = {};
      s.heard = -1;
      this.startWhenUp(s);
    }
  }

  /** The event log's note of the timers a session uses (where each comes from). */
  private timersNote(s: Sess): void {
    if (!s.initiator && s.profile.behaviour !== 'ospf' && s.profile.behaviour !== 'bfd') return;
    const parts = s.profile.timers.filter((t) => t.key !== 'retries' && t.key !== 'dpd-retries').map((t) => `${t.label.toLowerCase()} ${this.timer(s, s.profile, t.key).text}`);
    if (!parts.length) return;
    this.e.note('note', s.protocol, s.dev, s.peer, 'timers', '', `${s.profile.label} ${s.rel.id} at ${s.dev}: ${parts.join('; ')}`, this.e.now);
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
    // a session up: what waited for it (BFD for its client, traffic over a tunnel) goes
    if (up) {
      const go = this.upWaiters.filter((w) => w.when(s));
      if (go.length) {
        this.upWaiters = this.upWaiters.filter((w) => go.indexOf(w) < 0);
        for (const w of go) this.e.at(this.e.now + this.e.jitter(s.dev), w.fn);
      }
      this.e.recheckWaits();
    }
  }

  private adjUpOf(s: Sess): boolean {
    const b = this.behaviours.get(s.profile.behaviour);
    return b && b.adjUp ? b.adjUp(this, s) : s.up;
  }

  /** Is a change flooded to the session's neighbour now: its adjacency is up, or its protocol floods in its present state too (OSPF in Exchange or Loading)? */
  private floodsTo(s: Sess): boolean {
    if (this.adjUpOf(s)) return true;
    const b = this.behaviours.get(s.profile.behaviour);
    return !!b && !!b.floodsDuring && b.floodsDuring.indexOf(s.state) >= 0;
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
    const m: Msg = { protocol: s.protocol, type, label, detail: `${s.profile.label} ${type}: ${detail}`, relation: s.rel.id, data: { from: s.dev, ...data } };
    // what this message of the session waited for (BGP's OPEN: its TCP connection)
    if (s.x.waitedNext) {
      m.waited = s.x.waitedNext as string[];
      delete s.x.waitedNext;
    }
    return m;
  }

  /** A device's sessions. */
  sessionsOf(dev: string): Sess[] {
    return Array.from(this.sessions.values()).filter((s) => s.dev === dev).sort((a, b) => cmp(a.key, b.key));
  }

  /** what waits for a session to come up */
  private upWaiters: Array<{ when: (s: Sess) => boolean; fn: () => void }> = [];

  /** Run `fn` once a session that `when` accepts comes up. */
  whenSessionUp(when: (s: Sess) => boolean, fn: () => void): void {
    this.upWaiters.push({ when, fn });
  }

  /** Start a session now, again (a session that waited: BFD for its client). */
  startNow(s: Sess): void {
    s.x.started = false;
    this.startSession(s);
  }

  /**
   * The transport header of a session's message sent here (unicast or
   * multicast, never over a connection), from its profile's datagram
   * transport ("UDP 3784", "IP 89"; LDP's "UDP/TCP 646": its Hellos are
   * UDP): between peers as the profile says (SimProfile.ports: both from and
   * to the protocol's port, or each from its own ephemeral port to it), to a
   * group the protocol's port; otherwise the client side (the requests'
   * sender, or the relation's earlier endpoint) sends from an ephemeral port
   * to the protocol's port, the other side back. A protocol's TCP messages go over the transport's connections
   * (proto-tcp.ts) with their segments' real flags: no TCP header is made up
   * here (a profile with only TCP gets none).
   */
  l4Of(s: Sess, group = false): L4 | undefined {
    const p = s.profile.proto;
    const udp = /\bUDP(?:\/TCP)?\s+([0-9]{1,5})/.exec(p);
    const ip = /\bIP(?: protocol)?\s+([0-9]{1,3})/.exec(p);
    const first = [udp, ip].filter((x): x is RegExpExecArray => !!x).sort((a, b) => a.index - b.index)[0];
    if (!first) return undefined;
    if (first === ip) return { proto: 'other', num: Number(ip[1]) };
    const port = Number(first[1]);
    const eph = (dev: string): number => 49152 + hashIndex(s.rel.id + '|' + dev, 16000);
    // between peers: both from and to the protocol's port, or each from its own ephemeral port to it (SimProfile.ports);
    // to a group (Hellos): always to the protocol's port
    if (s.profile.ports === 'same' || (group && s.profile.ports !== 'to')) return { proto: 'udp', num: 17, sport: port, dport: port };
    if (s.profile.ports === 'to') return { proto: 'udp', num: 17, sport: eph(s.dev), dport: port };
    const client = s.profile.behaviour === 'service' || s.profile.behaviour === 'custom' ? (s.profile.fromServer ? !s.initiator : s.initiator) : s.initiator;
    const sport = client ? eph(s.dev) : port;
    const dport = client ? port : eph(s.peer);
    return { proto: 'udp', num: 17, sport, dport };
  }

  /** Unicast to the peer (its address), along the routing tables. */
  unicast(s: Sess, type: string, detail: string, data: { [k: string]: unknown } = {}, state = ''): void {
    const to = (s.x.replyTo as IpAddr | undefined) || ipOf(s.remote);
    const at = to === ipOf(s.remote) ? formatAddr(to) : `${formatAddr(to)}, its address as translated on the way`;
    const m = this.msg(s, type, `${s.dev} (${formatAddr(ipOf(s.local))}) → ${s.peer} (${at}), ${s.profile.proto}; ${detail}`, data);
    this.e.note('message', s.protocol, s.dev, s.peer, type, state, m.detail, this.e.now, m);
    const pkt = this.e.newPacket(ipOf(s.local), to, s.local.l3.vrf, m, [s.rel.id], s.profile.ttl || 0);
    pkt.l4 = this.l4Of(s);
    this.lane(s.rel, s.dev, s.peer, m, this.e.estimate(s.dev, to));
    this.e.send(s.dev, pkt);
  }

  /** Multicast to a group out of the session's interface (OSPF Hello …): the peers on the segment receive it. */
  multicast(s: Sess, group: IpAddr, type: string, detail: string, data: { [k: string]: unknown } = {}, state = ''): void {
    const m = this.msg(s, type, `${s.dev} (${formatAddr(ipOf(s.local))}) → ${formatAddr(group)} on ${s.local.l3.id}, ${s.profile.proto}; ${detail}`, data);
    this.e.note('message', s.protocol, s.dev, s.peer, type, state, m.detail, this.e.now, m);
    const pkt = this.e.newPacket(ipOf(s.local), group, s.local.l3.vrf, m, [s.rel.id], 1);
    pkt.l4 = this.l4Of(s, true);
    // the logical view: towards every peer of the relation on that segment
    const peers = (this.byRel.get(s.rel.id) || []).filter((x) => x.dev === s.dev).map((x) => x.peer);
    for (const p of peers) this.lane(s.rel, s.dev, p, m, s.local.l3.kind === 'tunnel' ? this.e.estimate(s.dev, ipOf((this.sess(s.protocol, s.rel.id, s.dev, p) as Sess).remote)) : 2 * this.e.hopTime());
    this.e.send(s.dev, pkt, s.local.l3);
  }

  /** A link-local layer-2 PDU out of a port (LACP, LLDP …). */
  onPort(protocol: string, dev: string, port: string, dstMac: string, type: string, label: string, detail: string, data: { [k: string]: unknown }, peer: string, rel?: Relation): void {
    const sd = this.sd(dev);
    const l3mac = this.e.net.macs.get(dev + ':' + port);
    const src = l3mac ? l3mac.mac : sd.bridgeId.split('.')[1] || '00:00:00:00:00:00';
    const m: Msg = { protocol, type, label, detail, relation: rel ? rel.id : undefined, data: { from: dev, port, ...data } };
    this.e.note('message', protocol, dev, peer, type, '', detail, this.e.now, m);
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
    const was = this.scopeDev;
    this.scopeDev = dev;
    try {
      this.dispatchAt(dev, l3, msg, pkt, frame);
    } finally {
      this.scopeDev = was;
    }
  }

  private dispatchAt(dev: string, l3: L3Iface | null, msg: Msg, pkt: Pkt | null, frame: Frame | null): void {
    // a TCP segment of the transport (a BGP session's, an application's, a test's): its connection takes it
    if (pkt && l3 && pkt.l4 && pkt.l4.proto === 'tcp' && msg.data && (msg.data as { tcp?: boolean }).tcp && this.tcpHook) {
      this.tcpHook(dev, l3, pkt);
      return;
    }
    const h = this.handlers.get(msg.protocol);
    if (h && h(dev, l3, msg, pkt, frame) !== false) return;
    const data = (msg.data || {}) as MsgData;
    // a message of no relation (a PIM Register to the RP)
    if (!msg.relation && data.from) {
      const f = this.fallback.get(msg.protocol);
      if (f) f(dev, l3, msg, pkt);
      return;
    }
    if (!msg.relation || !data.from) return;
    const s = this.sess(msg.protocol, msg.relation, dev, data.from);
    if (!s) {
      const f = this.fallback.get(msg.protocol);
      if (f) f(dev, l3, msg, pkt);
      return;
    }
    // a request to a port the device does not listen on (its own listening services leave it out) is refused
    if (pkt && l3 && this.portHook && !this.portHook(dev, pkt, l3)) return;
    this.startSession(s);
    s.heard = this.e.now;
    // a peer's packets that arrive from another address than its own were translated on the way (NAT): the answers go there,
    // as a server answers a translated client, and the NAT translates them back
    if (pkt && !pkt.encap && formatAddr(pkt.src) !== formatAddr(ipOf(s.remote))) s.x.replyTo = pkt.src;
    const b = this.behaviours.get(s.profile.behaviour) as Behaviour;
    b.rx(this, s, msg, pkt, l3);
    this.learn(s, msg);
  }

  filter(dev: string, pkt: Pkt, from: L3Iface, to: L3Iface): boolean {
    return !this.filterHook || this.filterHook(dev, pkt, from, to);
  }

  localError(dev: string, pkt: Pkt, kind: IcmpKind, text: string, mtu?: number): void {
    if (this.localErrorHook) this.localErrorHook(dev, pkt, kind, text, mtu);
  }

  sweep(): void {
    for (const h of this.sweepHooks) h();
  }

  snoop(sd: SimDevice, from: string | null, vlan: number, frame: Frame, t: number): SnoopResult | null {
    return this.snoopHook ? this.snoopHook(sd, from, vlan, frame, t) : null;
  }

  /** multicast (multicast.ts): has a device's own interface joined a group as a host? */
  joinedHook: ((dev: string, iface: string, group: IpAddr) => boolean) | null = null;

  joined(dev: string, iface: string, group: IpAddr): boolean {
    return !!this.joinedHook && this.joinedHook(dev, iface, group);
  }

  mroute(dev: string, l3: L3Iface, pkt: Pkt): boolean {
    return !!this.mrouteHook && this.mrouteHook(dev, l3, pkt);
  }

  routesChanged(dev: string): void {
    for (const h of this.routesHooks) h(dev);
  }

  ifaceChange(dev: string, l3: L3Iface, up: boolean): void {
    // the sessions that waited for this interface start now, together (a DHCP client's: once it has its lease)
    const ready = up && this.e.addressReady(dev, l3.id);
    const waiting = ready ? this.pendingStart.get(dev + ':' + l3.id) : undefined;
    if (waiting) {
      this.pendingStart.delete(dev + ':' + l3.id);
      for (const s of waiting) this.e.at(this.e.now + this.e.jitter(s.dev), () => this.startSession(s));
    }
    if (ready) {
      this.releaseUp(dev + ':' + l3.id);
      this.buildDeferred(dev);
    }
    for (const s of Array.from(this.sessions.values()).sort((a, b) => cmp(a.key, b.key))) {
      if (s.dev !== dev || s.local.l3.id !== l3.id) continue;
      const b = this.behaviours.get(s.profile.behaviour) as Behaviour;
      if (b.iface) b.iface(this, s, up);
    }
    for (const h of this.ifaceHooks) h(dev, l3, up);
    // an interface that comes up again announces itself
    // (never a tentative IPv6 address: duplicate address detection is still deciding whether it may be used, RFC 4862 §5.4)
    if (up && l3.kind !== 'tunnel' && l3.kind !== 'loopback') for (const a of l3.addrs) if (!(this.e.v6Hook && this.e.v6Hook.unusable(dev, l3, a.addr))) this.e.gratuitous(dev, l3, a.addr, l3.mac, `${l3.id} came up`);
  }

  linkChange(ref: string, up: boolean): void {
    if (up) this.releaseUp(ref);
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
    // IPsec carries traffic only while both ends of a pair have their SAs (each end decides its own: one whose SAs are gone
    // drops what the other still sends until that one's dead peer detection finds out)
    if (p.behaviour === 'ike') return list.some((s) => s.up && list.some((o) => o.dev === s.peer && o.peer === s.dev && o.up));
    return true;
  }

  // ------------------------------------------------------------ learned routing state

  /** RIP's distance-vector tables (rip.ts), once a RIP session exists */
  rip: RipSim | null = null;

  /** The RIP router tables (made with the first RIP session). */
  ripSim(): RipSim {
    if (!this.rip) this.rip = new RipSim(this);
    return this.rip;
  }

  dvTables(protocol: string): DvTables | null {
    return protocol === 'rip' && this.rip ? this.rip : null;
  }

  dvVersion(): number {
    return this.rip ? this.rip.version : 0;
  }

  /**
   * Each router's routing databases, one per routing instance — a routing
   * protocol in a VRF of the router ("ospf|", "bgp|blue") — each with what
   * it learned of every origin's instances, by "origin|origin's instance"
   * (its own record is always current). An instance learns only from its
   * own sessions' advertisements and floods only over them: what OSPF brings
   * never teaches BGP, nor one VRF another. A VRF name means something on
   * its own router only: what one instance takes from another router is
   * decided by the session it arrived on (its protocol), never by two
   * routers' VRFs having the same name.
   */
  private views = new Map<string, Map<string, Map<string, RouteRec>>>();
  /** every origin's last sequence number per instance, "origin|instance" (kept over a reboot: a router's new records outrank its old ones) */
  private recSeq = new Map<string, number>();
  /** reliable advertisements not acknowledged yet, by "session|id" */
  private pendingAdv = new Map<string, number>();
  private advId = 0;
  private routingRel = new Map<string, boolean>();

  /** Is a session one of a routing relation (OSPF, IS-IS, EIGRP, BGP): its advertisements teach routes? (RIP's are its own distance vectors) */
  isRouting(s: Sess): boolean {
    let v = this.routingRel.get(s.rel.id);
    if (v === undefined) this.routingRel.set(s.rel.id, (v = routingProtocol(this.m, s.rel) !== null && ['ospf', 'isis', 'eigrp', 'bgp'].indexOf(s.profile.behaviour) >= 0));
    return v;
  }

  /** The routing instance a session belongs to: its routing protocol and its VRF (on its own router). */
  instanceOf(s: Sess): string {
    return `${routingProtocol(this.m, s.rel)}|${s.local.l3.vrf}`;
  }

  /** The records a router's instance holds (its own among them): what its route computation and its own checks may read. */
  recordsIn(dev: string, inst: string): RouteRec[] {
    const v = this.view(dev, inst);
    if (!v.has(dev + '|' + inst)) this.originateOne(dev, inst);
    return Array.from(v.values()).sort((a, b) => cmp(a.origin, b.origin) || cmp(a.inst, b.inst));
  }

  private view(dev: string, inst: string): Map<string, RouteRec> {
    let byInst = this.views.get(dev);
    if (!byInst) this.views.set(dev, (byInst = new Map()));
    let v = byInst.get(inst);
    if (!v) byInst.set(inst, (v = new Map()));
    return v;
  }

  /** A router's routing instances (those of its routing sessions). */
  private instances(dev: string): string[] {
    return Array.from(new Set(this.sessionsOf(dev).filter((s) => this.isRouting(s)).map((s) => this.instanceOf(s)))).sort(cmp);
  }

  /**
   * What a router has learned, for its route computation (Engine.recompute):
   * every record of every instance it runs (each origin's adjacencies of that
   * instance, and its interfaces as of that record); null when it runs no
   * routing protocol (its routes are its own).
   */
  viewOf(dev: string): RouteRec[] | null {
    const insts = this.instances(dev);
    if (!insts.length) return null;
    const out: RouteRec[] = [];
    for (const inst of insts) out.push(...this.recordsIn(dev, inst));
    return out;
  }

  /** A router's own record of an instance now: its adjacencies of the instance that are up, and its interfaces that are up. */
  private ownRec(dev: string, inst: string): RouteRec {
    const adj = new Set<string>();
    for (const s of this.sessionsOf(dev)) if (this.isRouting(s) && this.instanceOf(s) === inst && this.adjUpOf(s)) adj.add(s.rel.id + '|' + s.peer);
    const sd = this.sd(dev);
    const up = sd ? Array.from(sd.l3.values()).filter((l) => this.e.isL3Up(dev, l.id)).map((l) => l.id).sort(cmp) : [];
    return { origin: dev, inst, seq: 0, at: this.e.now, adj: Array.from(adj).sort(cmp), up };
  }

  private originateOne(dev: string, inst: string): RouteRec | null {
    const rec = this.ownRec(dev, inst);
    const v = this.view(dev, inst);
    const k = dev + '|' + inst;
    const was = v.get(k);
    if (was && sameRec(was, rec)) return null;
    rec.seq = (this.recSeq.get(k) || 0) + 1;
    this.recSeq.set(k, rec.seq);
    v.set(k, rec);
    return rec;
  }

  /**
   * What routing depends on changed (Engine.routingChanged): every router
   * whose own adjacencies or interfaces changed has a new record in each of
   * its instances and advertises it there (OSPF and IS-IS flood it, EIGRP
   * sends it as an update, BGP as an UPDATE): the others learn of the
   * change only when that advertisement reaches them.
   */
  originate(): void {
    const devs = Array.from(new Set(Array.from(this.sessions.values()).filter((s) => this.isRouting(s)).map((s) => s.dev))).sort(cmp);
    for (const dev of devs) {
      if (!this.e.deviceOn(dev)) continue;
      for (const inst of this.instances(dev)) {
        const was = this.view(dev, inst).get(dev + '|' + inst);
        const rec = this.originateOne(dev, inst);
        // (an adjacency lost: what went through it must be found anew — EIGRP asks its other neighbours with a Query)
        const lost = !!was && !!rec && was.adj.some((a) => rec.adj.indexOf(a) < 0);
        if (rec) this.advertise(dev, inst, [rec], null, `${dev}'s ${rec.adj.length ? 'adjacencies or interfaces changed' : 'adjacencies are all down'} (sequence ${rec.seq})`, lost);
      }
    }
  }

  /** The records a session's instance knows at its router (that database), copies: what its synchronisation messages carry. */
  dbOf(s: Sess): RouteRec[] {
    return this.recordsIn(s.dev, this.instanceOf(s)).map(copyRec);
  }

  /** Records of an instance to the router's neighbours over that instance's adjacencies that are up (but the one they came from). */
  private advertise(dev: string, inst: string, recs: RouteRec[], except: Sess | null, why: string, lost = false): void {
    for (const s of this.sessionsOf(dev)) {
      if (!this.isRouting(s) || this.instanceOf(s) !== inst || !this.floodsTo(s) || !s.x.started) continue;
      if (except && s.peer === except.peer && s.rel.id === except.rel.id) continue;
      this.sendRecs(s, recs.map(copyRec), why, lost);
    }
  }

  /**
   * One advertisement of a session: its protocol's update message (OSPF
   * LSU, IS-IS LSP, EIGRP Update, BGP UPDATE) with the records. OSPF, IS-IS
   * and EIGRP send it again every retransmit interval until it is
   * acknowledged (LSAck, PSNP, ACK); BGP over its TCP connection (the
   * transport retransmits). EIGRP, when the change is a lost adjacency,
   * sends a Query instead, which each neighbour must answer with a Reply;
   * one that has not by the active timer is reset (stuck in active).
   */
  private sendRecs(s: Sess, recs: RouteRec[], why: string, lost = false): void {
    const b = this.behaviours.get(s.profile.behaviour) as Behaviour;
    const what = recs.map((r) => `${r.origin}#${r.seq}`).join(', ');
    if (b.advertise) {
      b.advertise(this, s, recs, why);
      return;
    }
    const query = lost && s.profile.behaviour === 'eigrp';
    const kind = query ? { type: 'Query', ack: 'Reply' } : UPDATE_OF[s.profile.behaviour] || { type: 'Update' };
    const type = kind.type;
    const ack = kind.ack;
    const id = ++this.advId;
    const since = this.e.now;
    const send = (n: number): void => {
      const data = { db: recs, dbId: id, dbAck: ack };
      const detail = `${why}: ${what}${n ? ` (sent again: no ${ack} after ${fmtSec(ADV_RXMT)})` : ''}`;
      if (b.send) b.send(this, s, type, detail, data);
      else this.unicast(s, type, detail, data);
    };
    send(0);
    if (!ack) return;
    const key = s.key + '|' + id;
    this.pendingAdv.set(key, s.gen);
    const again = (n: number): void => {
      this.e.after(ADV_RXMT, () => {
        if (this.pendingAdv.get(key) !== s.gen || !this.floodsTo(s)) {
          this.pendingAdv.delete(key);
          return;
        }
        if (query && this.e.now - since >= EIGRP_ACTIVE) {
          this.pendingAdv.delete(key);
          const b2 = this.behaviours.get(s.profile.behaviour) as Behaviour & { down?: (P: ProtocolSim, s: Sess, why: string) => void };
          if (b2.down) b2.down(this, s, `stuck in active: no Reply to its Query within the active timer (${fmtSec(EIGRP_ACTIVE)})`);
          return;
        }
        send(n);
        again(n + 1);
      });
    };
    again(1);
  }

  /**
   * A session's message arrived. An acknowledgment ends the retransmission
   * it answers. Records in it are taken only when the session's state
   * machine says it may learn from this message now (Behaviour.learns:
   * OSPF from Exchange on, IS-IS and EIGRP adjacencies up, BGP Established
   * — a message in another state, a late one after the session went down,
   * teaches nothing and is not acknowledged), and only those of the
   * session's own instance with a higher sequence number than the router
   * has (a stale one changes nothing): they go into that instance's
   * database, its routes are recomputed after its route recomputation
   * delay, and it advertises them on to its other neighbours of the
   * instance.
   */
  learn(s: Sess, msg: Msg): void {
    const d = (msg.data || {}) as { db?: RouteRec[]; dbId?: number; dbAck?: string; acks?: number };
    if (d.acks !== undefined) this.pendingAdv.delete(s.key + '|' + d.acks);
    if (!d.db || !this.isRouting(s)) return;
    const b = this.behaviours.get(s.profile.behaviour) as Behaviour;
    const may = b.learns ? b.learns(this, s, msg) : s.up;
    if (!may) {
      this.e.note('drop', s.protocol, s.dev, s.peer, msg.type, s.state, `${s.profile.label} ${s.rel.id}: ${s.dev} takes nothing from ${s.peer}'s ${msg.type} in state ${s.state} (its records are not learned, not acknowledged)`);
      return;
    }
    if (d.dbId !== undefined && d.dbAck) {
      const ackData = { acks: d.dbId };
      const ackText = `acknowledges ${d.db.map((r) => r.origin + '#' + r.seq).join(', ')}`;
      if (b.send) b.send(this, s, d.dbAck, ackText, ackData);
      else this.unicast(s, d.dbAck, ackText, ackData);
    }
    const inst = this.instanceOf(s);
    const v = this.view(s.dev, inst);
    if (!v.has(s.dev + '|' + inst)) this.originateOne(s.dev, inst);
    const changed: RouteRec[] = [];
    // the session's instance takes what came over it: its own protocol's records (another protocol's never; the origin's VRF
    // is the origin's own name for it, compared with nothing here)
    const proto = inst.slice(0, inst.indexOf('|'));
    for (const r of d.db) {
      if (r.origin === s.dev || r.inst.slice(0, r.inst.indexOf('|')) !== proto) continue;
      const k = r.origin + '|' + r.inst;
      const known = v.get(k);
      if (known && known.seq >= r.seq) continue;
      const c = copyRec(r);
      v.set(k, c);
      changed.push(c);
    }
    if (!changed.length) return;
    this.e.note('route', s.protocol, s.dev, s.peer, 'learned', '', `${s.dev} learned from ${s.peer} (${s.profile.label} ${msg.type}): ${changed.map((r) => `${r.origin} sequence ${r.seq} (${r.adj.length} adjacenc${r.adj.length === 1 ? 'y' : 'ies'})`).join(', ')}; its routes follow after its route recomputation delay`);
    this.e.recomputeSoon(s.dev);
    this.advertise(s.dev, inst, changed, s, `learned from ${s.peer}`);
    // what it learned may change its own record (an OSPF DROther's adjacency through the DR's record): originated anew if so
    const own = this.originateOne(s.dev, inst);
    if (own) this.advertise(s.dev, inst, [own], null, `${s.dev}'s adjacencies changed with what it learned (sequence ${own.seq})`);
  }

  /** A router was powered off: its databases are gone (it learns everything again after it boots). */
  private forget(dev: string): void {
    this.views.delete(dev);
    for (const k of Array.from(this.pendingAdv.keys())) if (k.split('|')[2] === dev) this.pendingAdv.delete(k);
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
