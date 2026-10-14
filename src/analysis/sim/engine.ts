/**
 * The protocol simulation's engine: a discrete-event simulation of the
 * model's network in simulated time (milliseconds), deterministic (the
 * same model and the same actions give the same timeline; the only
 * randomness is a jitter from a fixed seed). It never changes the model.
 *
 * Layer 2. Frames cross a cable in HOP ms, spaced at least GAP ms apart per
 * direction (a frame waits at most MAX_WAIT for its turn).
 * Bridges learn the source MAC per port and VLAN, flood broadcast,
 * multicast and unknown unicast within the VLAN to every other port that
 * carries it, and send known unicast to the learned port only; the link
 * ends' tagging decides what a port carries and whether a frame leaves it
 * tagged (net.ts). A frame never leaves its VLAN on a bridge. Layer-2
 * loops are broken by a spanning tree per VLAN (net.ts spanningTree),
 * whether or not the model runs STP; topology changes flush the MAC tables
 * of the VLANs whose tree changed. A frame's way through the bridges is
 * decided when it is sent (with the MAC tables of that moment).
 *
 * Layer 3. A device sends a unicast IP packet to its next hop (the routing
 * tables of analysis/routing.ts, with what is up in the simulation and the
 * adjacencies the routing protocols have formed) after resolving the next
 * hop's MAC address: ARP (IPv4) or neighbour discovery (IPv6), with an
 * ARP Request or Neighbor Solicitation, then the packet waits; the reply
 * fills the table and releases it. A router decrements the TTL (hop limit)
 * and rewrites the source and destination MAC per hop, and says so in the
 * event log. Multicast (OSPF, VRRP …) goes to the group's multicast MAC
 * without resolution. A route out of a tunnel interface encapsulates the
 * packet (GRE, then ESP when the tunnel is carried over IPsec) towards the
 * tunnel's destination.
 *
 * Tables. Every device that sends or receives IP keeps an ARP table and a
 * neighbour table, empty at the start, filled only by what the simulation
 * resolves; switches keep a MAC table. Their timers (ARP timeout, NDP
 * reachable time, MAC ageing) come from the model or the defaults
 * (model/sim-profiles.ts) and run faster by the timer scale.
 *
 * Failures. One cable or relation at a time. The ports at a failed cable
 * go down (their ARP and neighbour entries, and the MAC entries learned on
 * them, are removed); frames on it, and frames that would still cross it,
 * are dropped where they are. Everything else reacts as its timers say.
 */
import { IpAddr, parseAddress } from '../../model/ip';
import { protocolBase } from '../../model/protocols';
import { ARP_TIMEOUT_DEFAULT, MAC_AGING_DEFAULT, ND_DELAY_DEFAULT, ND_RETRANS_DEFAULT, ND_RETRIES_DEFAULT, NDP_REACHABLE_DEFAULT } from '../../model/sim-profiles';
import { Link, Model, Relation } from '../../model/types';
import { compareAddr, formatAddr } from '../ipmath';
import { RoutingCtx, lookup } from '../routing';
import { declaredUnderlay, encapStack, tunnelRelation, tracePath } from '../trace';
import { BROADCAST, isGroupMac, isMulticastIp, multicastMac, rng, solicitedNode, modelSeed, shortMac } from './mac';
import { BridgePort, CableEnd, L3Iface, SimDevice, SimNet, buildNet, carries, ingressVlan, otherEnd, portKey, spanningTree } from './net';
import { ArpRow, ArpType, Flight, MacRow, Msg, NdState, Pkt, SimEvent, TableTimer, Track } from './types';

/** How long a frame takes over a cable (simulated ms): slow enough to follow on screen. */
export const HOP = 300;
/** The spacing of frames on one cable and direction, and the longest a frame waits for its turn (ms). */
export const GAP = 75;
const MAX_WAIT = 300;
/** Times are kept this long after they end (for the animation and the export). */
const FLIGHT_KEEP = 4000;
/** The event log keeps the last this many events. */
export const LOG_MAX = 20000;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ArpPdu {
  op: 'request' | 'reply';
  sha: string;
  spa: IpAddr;
  tha: string;
  tpa: IpAddr;
  gratuitous?: boolean;
}

export interface NdPdu {
  op: 'NS' | 'NA';
  src: IpAddr;
  target: IpAddr;
  lladdr: string;
  solicited: boolean;
  unsolicited?: boolean;
}

export interface Frame {
  src: string;
  dst: string;
  msg: Msg;
  arp?: ArpPdu;
  nd?: NdPdu;
  ip?: Pkt;
  /** a link-local layer-2 PDU (LACP, LLDP, STP …): never forwarded by a bridge */
  l2?: boolean;
  /** a layer-2 PDU of a routing protocol (IS-IS): bridged like any multicast frame, handed to the protocols */
  pdu?: boolean;
}

/** What the engine asks of the protocols (analysis/sim/protocols.ts). */
export interface Protocols {
  /** an IP packet for this device (one of its addresses, a VIP it holds, a group) */
  ip(dev: string, l3: L3Iface, pkt: Pkt): void;
  /** a link-local layer-2 PDU */
  l2(dev: string, port: string, frame: Frame): void;
  /** a layer-3 interface went down or came up */
  ifaceChange(dev: string, l3: L3Iface, up: boolean): void;
  /** a cable or relation failed or was restored */
  linkChange(ref: string, up: boolean): void;
  /** is a routing adjacency (a relation of OSPF, BGP …) up */
  relUp(id: string): boolean;
  /** is one direction of it up (from learns routes from to) */
  adjUp(relation: string, from: string, to: string): boolean;
  /** the virtual addresses (VRRP …) the device holds on an interface now, with their virtual MAC */
  owns(dev: string, iface: string): Array<{ addr: IpAddr; mac: string; protocol: string }>;
  /** is a tunnel interface up (its tunnel's own keepalives) */
  tunnelUp(dev: string, iface: string): boolean;
  /** is a relation's own state up (a session over it) */
  sessionUp?(relation: string): boolean;
}

interface QItem {
  t: number;
  seq: number;
  fn: () => void;
}

interface ArpEntry {
  ip: IpAddr;
  ipText: string;
  mac: string;
  iface: string;
  vlan: number;
  type: ArpType;
  state: NdState | 'VALID' | 'REFRESHING';
  learned: number;
  refreshed: number;
  /** the time of the state's timeout (NDP DELAY / PROBE, an incomplete entry's retransmission) */
  timer: number;
  tries: number;
  used: boolean;
  /** packets waiting for the address */
  queue: Array<{ pkt: Pkt; send: (mac: string) => void }>;
}

interface MacEntry {
  mac: string;
  vlan: number;
  port: string;
  type: 'dynamic' | 'static';
  learned: number;
  refreshed: number;
}

/** A delivery to a layer-3 interface, pending until its time (a failure on its way cancels it). */
interface Delivery {
  dev: string;
  l3: L3Iface;
  frame: Frame;
  /** the flight of the last cable on its way */
  flight: number;
  cancelled: boolean;
}

export interface EngineOptions {
  /** the ARP / NDP / MAC table timers run this many times faster (1 = real time) */
  timerScale?: number;
}

export class Engine {
  readonly model: Model;
  readonly net: SimNet;
  protocols: Protocols | null = null;
  now = 0;
  timerScale: number;
  readonly random: () => number;
  private q: QItem[] = [];
  private seq = 0;
  private logSeq = 0;
  readonly log: SimEvent[] = [];
  /** events dropped from the log's start (it keeps the last LOG_MAX) */
  logDropped = 0;
  readonly flights: Flight[] = [];
  private flightById = new Map<number, Flight>();
  private flightSeq = 0;
  private pktSeq = 0;
  private cableFree = new Map<string, number>();
  private pending: Delivery[] = [];
  /** the failed cable or relation ("link:x" / "relation:x"), null: none */
  failed: string | null = null;
  /** when it failed */
  failedAt = 0;
  private stp = new Map<number, { root: string; blocked: Set<string> }>();
  private arp = new Map<string, Map<string, ArpEntry>>();
  private macs = new Map<string, Map<string, MacEntry>>();
  private l3State = new Map<string, boolean>();
  private ctxObj: RoutingCtx | null = null;
  /** changes whenever what routing depends on does (interfaces, adjacencies, the failure) */
  routingVersion = 0;
  private estimates = new Map<string, number>();

  constructor(model: Model, opts: EngineOptions = {}) {
    this.model = model;
    this.net = buildNet(model);
    this.timerScale = opts.timerScale || 1;
    this.random = rng(modelSeed(model));
    for (const d of this.net.devices.values()) {
      this.arp.set(d.id, new Map());
      if (d.bridge) this.macs.set(d.id, new Map());
      for (const l3 of d.l3.values()) this.l3State.set(d.id + ':' + l3.id, true);
    }
    for (const d of this.net.devices.values()) if (d.bridge) this.staticMacs(d);
  }

  // ------------------------------------------------------------ time and events

  /** Run fn at simulated time t (never before now). */
  at(t: number, fn: () => void): void {
    const item = { t: Math.max(t, this.now), seq: this.seq++, fn };
    const q = this.q;
    q.push(item);
    let i = q.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (before(q[p], item)) break;
      q[i] = q[p];
      i = p;
    }
    q[i] = item;
  }

  after(dt: number, fn: () => void): void {
    this.at(this.now + dt, fn);
  }

  private pop(): QItem | undefined {
    const q = this.q;
    if (!q.length) return undefined;
    const top = q[0];
    const last = q.pop() as QItem;
    if (q.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        const cand = (k: number): void => {
          if (k < q.length && before(q[k], m === i ? last : q[m])) m = k;
        };
        cand(l);
        cand(r);
        if (m === i) break;
        q[i] = q[m];
        i = m;
      }
      q[i] = last;
    }
    return top;
  }

  /** The time of the next event (null: none). */
  nextTime(): number | null {
    return this.q.length ? this.q[0].t : null;
  }

  /** Process every event up to time t, and set the clock to t. */
  run(t: number): void {
    for (;;) {
      const n = this.nextTime();
      if (n === null || n > t) break;
      const it = this.pop() as QItem;
      this.now = it.t;
      it.fn();
    }
    this.now = Math.max(this.now, t);
    this.prune();
  }

  private prune(): void {
    const keep = this.now - FLIGHT_KEEP;
    let k = 0;
    while (k < this.flights.length && this.flights[k].t1 < keep && this.flights[k].t0 < keep) k++;
    if (k > 200) {
      for (const f of this.flights.splice(0, k)) this.flightById.delete(f.id);
    }
  }

  // ------------------------------------------------------------ the log

  note(kind: SimEvent['kind'], protocol: string, device: string, peer: string, what: string, state: string, detail: string, t = this.now): void {
    this.log.push({ t, seq: this.logSeq++, kind, protocol, device, peer, what, state, detail });
    if (this.log.length > LOG_MAX + 500) {
      const n = this.log.length - LOG_MAX;
      this.log.splice(0, n);
      this.logDropped += n;
    }
  }

  // ------------------------------------------------------------ what is up

  linkUp(id: string): boolean {
    return this.failed !== 'link:' + id;
  }

  relationUp(id: string): boolean {
    return this.failed !== 'relation:' + id;
  }

  /** Is a port up: its cable (if any) has not failed. */
  portUp(dev: string, port: string): boolean {
    const e = this.net.ends.get(portKey(dev, port));
    return !e || this.linkUp(e.link);
  }

  /** Is a layer-3 interface up (see the module comment). */
  l3Up(dev: string, l3: L3Iface): boolean {
    const sd = this.net.devices.get(dev) as SimDevice;
    if (l3.kind === 'loopback') return true;
    if (l3.kind === 'tunnel') return !!this.protocols && this.protocols.tunnelUp(dev, l3.id);
    if (l3.kind === 'svi') {
      // a VLAN interface is up while a port of its bridge carrying the VLAN is
      for (const bp of sd.bridgePorts.values()) if (carries(bp.vlans, l3.vlan) && bp.members.some((m) => this.portUp(dev, m) && this.net.ends.has(portKey(dev, m)))) return true;
      return false;
    }
    const up = l3.ports.filter((p) => this.portUp(dev, p)).length;
    if (l3.kind === 'aggregate') {
      const i = this.model.index.interfaces.get(dev + ':' + l3.id);
      return up >= Math.max(1, (i && i.minLinks) || 1);
    }
    return up > 0 || !l3.ports.length;
  }

  /** The routing context of the simulation's state (a new object when that state changes, so routes are computed again). */
  ctx(): RoutingCtx {
    if (this.ctxObj) return this.ctxObj;
    const self = this;
    this.ctxObj = {
      up(device: string, iface: string): boolean {
        const sd = self.net.devices.get(device);
        const l3 = sd ? sd.l3.get(iface) : undefined;
        if (l3) return self.l3State.get(device + ':' + iface) !== false;
        return self.portUp(device, iface);
      },
      relUp(id: string): boolean {
        if (!self.relationUp(id)) return false;
        return !self.protocols || self.protocols.relUp(id);
      },
      linkUp(id: string): boolean {
        return self.linkUp(id);
      },
      adjUp(relation: string, from: string, to: string): boolean {
        return !self.protocols || self.protocols.adjUp(relation, from, to);
      },
    };
    return this.ctxObj;
  }

  /** What routing depends on changed: routes are computed again. */
  routingChanged(): void {
    this.ctxObj = null;
    this.routingVersion++;
    this.estimates.clear();
  }

  /** Recompute the interfaces' states; report the changes (and flush what an interface going down loses). */
  syncInterfaces(): void {
    let changed = false;
    for (const d of this.net.devices.values()) {
      for (const l3 of Array.from(d.l3.values()).sort((a, b) => cmp(a.id, b.id))) {
        const key = d.id + ':' + l3.id;
        const was = this.l3State.get(key) !== false;
        const is = this.l3Up(d.id, l3);
        if (was === is) continue;
        this.l3State.set(key, is);
        changed = true;
        this.note('link', 'link', d.id, '', `${l3.id} ${is ? 'up' : 'down'}`, is ? 'up' : 'down', is ? `Interface ${d.id}:${l3.id} is up again` : `Interface ${d.id}:${l3.id} went down`);
        if (!is) this.flushIface(d.id, l3.id, 'its interface went down');
        if (this.protocols) this.protocols.ifaceChange(d.id, l3, is);
      }
    }
    if (changed) this.routingChanged();
  }

  isL3Up(dev: string, iface: string): boolean {
    return this.l3State.get(dev + ':' + iface) !== false;
  }

  // ------------------------------------------------------------ spanning tree and MAC tables

  /** The spanning tree of a VLAN (cached until a failure or restore). */
  tree(vlan: number): { root: string; blocked: Set<string> } {
    let t = this.stp.get(vlan);
    if (!t) {
      t = spanningTree(this.net, vlan, (id) => !this.linkUp(id));
      this.stp.set(vlan, t);
    }
    return t;
  }

  /** Is a bridge port blocked for a VLAN by the spanning tree? */
  blocked(dev: string, bp: string, vlan: number): boolean {
    return this.tree(vlan).blocked.has(portKey(dev, bp));
  }

  /** The spanning trees again (after a failure or restore); the MAC tables of the VLANs whose tree changed are flushed. */
  private recomputeTrees(): void {
    const old = this.stp;
    this.stp = new Map();
    for (const [vlan, t] of old) {
      const n = this.tree(vlan);
      const same = n.root === t.root && n.blocked.size === t.blocked.size && Array.from(n.blocked).every((k) => t.blocked.has(k));
      if (same) continue;
      const opened = Array.from(t.blocked).filter((k) => !n.blocked.has(k));
      this.note('link', 'stp', n.root || '', '', 'Topology change', '', `The spanning tree of ${vlan ? 'VLAN ' + vlan : 'the untagged frames'} changed${opened.length ? ': ' + opened.map((k) => k.replace('|', ':')).join(', ') + ' forwarding' : ''}; the MAC tables of the VLAN are flushed`);
      for (const [dev, tab] of this.macs) {
        for (const [k, e] of Array.from(tab)) if (e.type === 'dynamic' && e.vlan === vlan) tab.delete(k);
        void dev;
      }
    }
  }

  private staticMacs(d: SimDevice): void {
    const tab = this.macs.get(d.id) as Map<string, MacEntry>;
    for (const l3 of d.l3.values()) {
      if (l3.kind !== 'svi') continue;
      tab.set(l3.vlan + '|' + l3.mac, { mac: l3.mac, vlan: l3.vlan, port: 'CPU (' + l3.id + ')', type: 'static', learned: 0, refreshed: 0 });
    }
  }

  private learn(d: SimDevice, vlan: number, mac: string, port: string, t: number): void {
    if (isGroupMac(mac)) return;
    const tab = this.macs.get(d.id) as Map<string, MacEntry>;
    const k = vlan + '|' + mac;
    const e = tab.get(k);
    if (e && e.type === 'static') return;
    if (e && e.port === port) {
      e.refreshed = Math.max(e.refreshed, t);
      return;
    }
    if (e) this.note('table', 'stp', d.id, '', 'MAC moved', '', `${mac} (VLAN ${vlan || 'untagged'}) moved from port ${e.port} to ${port}`, t);
    tab.set(k, { mac, vlan, port, type: 'dynamic', learned: t, refreshed: t });
  }

  /** The MAC aging time of a switch (ms of simulated time, scaled). */
  macAging(): number {
    return (MAC_AGING_DEFAULT * 1000) / this.timerScale;
  }

  // ------------------------------------------------------------ layer 2: sending and forwarding frames

  /** the emission being planned: its sender and time (for the logical view's dots of messages without a relation) */
  private emitting: { dev: string; l3: L3Iface; t: number; net: string | null; first: number | null } | null = null;

  /** Send a frame from a layer-3 interface (at now). */
  emit(dev: string, l3: L3Iface, frame: Frame, t = this.now): void {
    const was = this.emitting;
    this.emitting = { dev, l3, t, net: frame.msg.relation ? null : this.networkOf(l3, frame), first: null };
    try {
      this.emitFrame(dev, l3, frame, t);
    } finally {
      this.emitting = was;
    }
  }

  /** The model network a frame from an interface is in (for the logical view's membership lines). */
  private networkOf(l3: L3Iface, frame: Frame): string | null {
    const v = frame.arp ? 4 : frame.ip ? frame.ip.dst.version : frame.nd ? 6 : 0;
    const a = l3.addrs.find((x) => !v || x.addr.version === v);
    if (!a) return null;
    for (const n of this.model.networks.slice().sort((x, y) => cmp(x.id, y.id))) {
      if (!n.cidr) continue;
      const p = parseAddress(n.cidr.split('/')[0]);
      const len = Number(n.cidr.split('/')[1]);
      if (p && p.version === a.addr.version && len === a.net.prefix && compareAddr(p, a.net) === 0) return n.id;
    }
    return null;
  }

  private emitFrame(dev: string, l3: L3Iface, frame: Frame, t: number): void {
    const sd = this.net.devices.get(dev) as SimDevice;
    if (!this.isL3Up(dev, l3.id)) {
      this.note('drop', frame.msg.protocol, dev, '', frame.msg.type, '', `not sent: ${dev}:${l3.id} is down (${frame.msg.label})`, t);
      return;
    }
    if (l3.kind === 'svi') {
      this.bridge(sd, null, l3.vlan, frame, t, undefined, new Set([dev]));
      return;
    }
    const ports = l3.ports.filter((p) => this.portUp(dev, p) && this.net.ends.has(portKey(dev, p)));
    if (!ports.length) return;
    const port = ports.length === 1 ? ports[0] : ports[hashIndex(frame.src + frame.dst + (frame.ip ? frame.ip.flow : ''), ports.length)];
    let tag: number | null = null;
    if (l3.kind === 'subif' && l3.vlan) {
      const e = this.net.ends.get(portKey(dev, port)) as CableEnd;
      const le = e.end === 'a' ? (this.net.links.get(e.link) as { a: { mode?: string; untagged?: number } }).a : (this.net.links.get(e.link) as { b: { mode?: string; untagged?: number } }).b;
      tag = le.untagged === l3.vlan ? null : l3.vlan;
    }
    this.transmit(dev, port, frame, tag, t, undefined, new Set([dev]));
  }

  /**
   * When a frame can start on a cable in one direction: GAP ms after the
   * one before, so that frames on a cable are spaced out over time; it
   * never waits more than MAX_WAIT (a busy cable does not delay traffic).
   */
  private slot(key: string, t: number): number {
    const free = this.cableFree.get(key) || 0;
    const start = free - t > MAX_WAIT ? t : Math.max(t, free);
    this.cableFree.set(key, Math.max(free, start + GAP));
    return start;
  }

  /** A link-local layer-2 PDU out of one port (LACP, LLDP, STP): it reaches the device at the other end only. */
  sendOnPort(dev: string, port: string, frame: Frame): void {
    if (!this.portUp(dev, port)) return;
    const was = this.emitting;
    this.emitting = null;
    try {
      this.transmit(dev, port, frame, null, this.now, undefined, new Set([dev]));
    } finally {
      this.emitting = was;
    }
  }

  /** A frame onto a cable from a port; it arrives HOP ms after it can start (one frame per cable and direction at a time). */
  private transmit(dev: string, port: string, frame: Frame, tag: number | null, t: number, parent: number | undefined, seen: Set<string>): void {
    const e = this.net.ends.get(portKey(dev, port));
    if (!e) return;
    const l = this.net.links.get(e.link) as { direction: string };
    if (l.direction === 'unidirectional' && e.end === 'b') return;
    const key = e.link + '>' + e.end;
    const start = this.slot(key, t);
    const o = otherEnd(this.net, e);
    const f = this.flight(start, start + HOP, frame.msg, 'physical', { ref: 'link:' + e.link, from: e.end, to: o.end }, parent, frameEncap(frame));
    f.encapProtocols = encapProtocols(frame);
    if (!this.linkUp(e.link)) {
      f.dropped = start + HOP / 2;
      f.t1 = f.dropped;
      this.note('drop', frame.msg.protocol, dev, o.device, frame.msg.type, '', `dropped on the failed cable ${e.link}: ${frame.msg.label}`, start);
      return;
    }
    this.arrive(o.device, o.port, frame, tag, start + HOP, f.id, seen);
  }

  private arrive(dev: string, port: string, frame: Frame, tag: number | null, t: number, flight: number, seen: Set<string>): void {
    const sd = this.net.devices.get(dev);
    if (!sd) return;
    if (frame.l2) {
      this.deliverL2(dev, port, frame, t, flight);
      return;
    }
    const bpId = sd.bridge ? sd.portOf.get(port) : undefined;
    if (sd.bridge && bpId !== undefined) {
      if (seen.has(dev)) return;
      const bp = sd.bridgePorts.get(bpId) as BridgePort;
      const vlan = ingressVlan(bp.vlans, tag);
      if (vlan === null) {
        this.note('drop', frame.msg.protocol, dev, '', frame.msg.type, '', `dropped at ${dev}:${port}: ${tag ? 'VLAN ' + tag + ' is not allowed on the port' : 'the trunk has no native VLAN for untagged frames'} (${frame.msg.label})`, t);
        return;
      }
      if (this.blocked(dev, bpId, vlan)) return;
      this.bridge(sd, bpId, vlan, frame, t, flight, new Set(seen).add(dev));
      return;
    }
    // a routed port, a subinterface or an aggregate of a non-bridge (or a routed port of a switch)
    const l3 = this.l3At(sd, port, tag);
    if (!l3) return;
    if (!this.accepts(sd, l3, frame)) return;
    this.deliverL3(dev, l3, frame, t, flight);
  }

  /** The layer-3 interface a frame arriving at a port with a tag belongs to. */
  private l3At(sd: SimDevice, port: string, tag: number | null): L3Iface | undefined {
    const cands = Array.from(sd.l3.values()).filter((l) => l.ports.indexOf(port) >= 0).sort((a, b) => cmp(a.id, b.id));
    if (tag) return cands.find((l) => l.kind === 'subif' && l.vlan === tag);
    const e = this.net.ends.get(portKey(sd.id, port));
    let untagged: number | undefined;
    if (e) {
      const l = this.net.links.get(e.link) as { a: { untagged?: number; mode?: string }; b: { untagged?: number; mode?: string } };
      const le = e.end === 'a' ? l.a : l.b;
      untagged = le.untagged;
    }
    return cands.find((l) => l.kind === 'routed' || l.kind === 'aggregate') || cands.find((l) => l.kind === 'subif' && untagged !== undefined && l.vlan === untagged);
  }

  /** Does a layer-3 interface take a frame: its own MAC, a virtual MAC it holds, a group address. */
  private accepts(sd: SimDevice, l3: L3Iface, frame: Frame): boolean {
    if (isGroupMac(frame.dst)) return true;
    if (frame.dst === l3.mac) return true;
    return !!this.protocols && this.protocols.owns(sd.id, l3.id).some((o) => o.mac === frame.dst);
  }

  /** A bridge forwards a frame in a VLAN (from a port, or from its own VLAN interface when `from` is null). */
  private bridge(sd: SimDevice, from: string | null, vlan: number, frame: Frame, t: number, flight: number | undefined, seen: Set<string>): void {
    if (from !== null) this.learn(sd, vlan, frame.src, from, t);
    // to its own VLAN interface (the switch's management or routing interface)
    if (from !== null) {
      for (const l3 of sd.l3.values()) {
        if (l3.kind !== 'svi' || l3.vlan !== vlan) continue;
        if (this.accepts(sd, l3, frame)) this.deliverL3(sd.id, l3, frame, t, flight !== undefined ? flight : -1);
      }
    }
    const tab = this.macs.get(sd.id) as Map<string, MacEntry>;
    const known = !isGroupMac(frame.dst) ? tab.get(vlan + '|' + frame.dst) : undefined;
    if (known && known.type === 'static') return;
    const fresh = known && t - known.refreshed <= this.macAging();
    const out: BridgePort[] = [];
    if (fresh) {
      const bp = sd.bridgePorts.get((known as MacEntry).port);
      if (!bp || bp.id === from) return;
      out.push(bp);
    } else {
      for (const bp of Array.from(sd.bridgePorts.values()).sort((a, b) => cmp(a.id, b.id))) if (bp.id !== from) out.push(bp);
    }
    for (const bp of out) {
      const c = carries(bp.vlans, vlan);
      if (!c || this.blocked(sd.id, bp.id, vlan)) continue;
      const up = bp.members.filter((m) => this.portUp(sd.id, m) && this.net.ends.has(portKey(sd.id, m)));
      if (!up.length) continue;
      const m = up.length === 1 ? up[0] : up[hashIndex(frame.src + frame.dst, up.length)];
      this.transmit(sd.id, m, frame, c === 'untagged' ? null : vlan, t, flight, seen);
    }
  }

  private deliverL2(dev: string, port: string, frame: Frame, t: number, flight: number): void {
    const d: Delivery = { dev, l3: { device: dev, id: port, kind: 'routed', addrs: [], vrf: '', vlan: 0, ports: [port], mac: '', macSimulated: false }, frame, flight, cancelled: false };
    this.pending.push(d);
    this.at(t, () => {
      this.pending.splice(this.pending.indexOf(d), 1);
      if (d.cancelled || !this.protocols) return;
      this.protocols.l2(dev, port, frame);
    });
  }

  private deliverL3(dev: string, l3: L3Iface, frame: Frame, t: number, flight: number): void {
    // the logical view: a message without a relation goes from its sender to the network and on to this receiver
    const em = this.emitting;
    if (em && em.net && em.dev !== dev && t > em.t) {
      const mid = em.t + Math.min(HOP, (t - em.t) / 2);
      if (em.first === null) em.first = this.flight(em.t, mid, frame.msg, 'logical', { ref: 'network:' + em.net, from: em.dev, to: 'net' }, undefined, frameEncap(frame)).id;
      this.flight(mid, t, frame.msg, 'logical', { ref: 'network:' + em.net, from: 'net', to: dev }, em.first, frameEncap(frame));
    }
    const d: Delivery = { dev, l3, frame, flight, cancelled: false };
    this.pending.push(d);
    this.at(t, () => {
      const i = this.pending.indexOf(d);
      if (i >= 0) this.pending.splice(i, 1);
      if (d.cancelled) return;
      this.receive(dev, l3, frame);
    });
  }

  // ------------------------------------------------------------ flights (the dots)

  flight(t0: number, t1: number, msg: Msg, view: Flight['view'], track: Track, parent?: number, encap?: string[]): Flight {
    const f: Flight = { id: this.flightSeq++, t0, t1, protocol: msg.protocol, label: msg.label, view, track, parent };
    if (encap && encap.length) f.encap = encap;
    this.flights.push(f);
    this.flightById.set(f.id, f);
    return f;
  }

  /** The flights in the air at time t (or ending within `grace` ms before it, for the lost marks). */
  flightsAt(t: number, view: Flight['view'], grace = 0): Flight[] {
    return this.flights.filter((f) => f.view === view && !f.hidden && f.t0 <= t && (f.dropped !== undefined ? f.dropped + 1200 >= t : f.t1 + grace >= t));
  }

  // ------------------------------------------------------------ layer 3: receiving

  private receive(dev: string, l3: L3Iface, frame: Frame): void {
    if (frame.arp) this.arpReceive(dev, l3, frame, frame.arp);
    else if (frame.nd) this.ndReceive(dev, l3, frame, frame.nd);
    else if (frame.ip) this.ipReceive(dev, l3, frame, frame.ip);
    else if (frame.pdu && this.protocols) this.protocols.l2(dev, l3.id, frame);
  }

  /** Is the address one of the device's own in the VRF (or a virtual address it holds)? */
  ownsAddress(dev: string, a: IpAddr, vrf?: string): L3Iface | undefined {
    const sd = this.net.devices.get(dev) as SimDevice;
    for (const l3 of Array.from(sd.l3.values()).sort((x, y) => cmp(x.id, y.id))) {
      if (vrf !== undefined && l3.vrf !== vrf) continue;
      if (!this.isL3Up(dev, l3.id)) continue;
      if (l3.addrs.some((x) => compareAddr(x.addr, a) === 0)) return l3;
      if (this.protocols && this.protocols.owns(dev, l3.id).some((o) => compareAddr(o.addr, a) === 0)) return l3;
    }
    return undefined;
  }

  private ipReceive(dev: string, l3: L3Iface, frame: Frame, pkt: Pkt): void {
    const sd = this.net.devices.get(dev) as SimDevice;
    // a neighbour's packet confirms its entry when it uses it (a refresh of what it sent from)
    const own = this.ownsAddress(dev, pkt.dst, l3.vrf);
    if (isMulticastIp(pkt.dst) || own) {
      if (pkt.encap && pkt.inner) {
        this.decapsulate(dev, l3, pkt);
        return;
      }
      if (this.protocols) this.protocols.ip(dev, own || l3, pkt);
      return;
    }
    if (!sd.routes) {
      // a Layer 2 switch (its management address) or a host: it never routes for others
      if (frame.dst === l3.mac) this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `not routed at ${dev}: ${sd.l2switch ? 'a Layer 2 switch routes nothing' : 'it does not forward traffic for others'} (${formatAddr(pkt.src)} → ${formatAddr(pkt.dst)}, ${pkt.msg.label})`);
      return;
    }
    // a router: forward, with the TTL decremented and the MACs rewritten
    if (pkt.ttl <= 1) {
      this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `TTL expired at ${dev} (${formatAddr(pkt.src)} → ${formatAddr(pkt.dst)}): ${pkt.msg.label}`);
      return;
    }
    const next: Pkt = { ...pkt, ttl: pkt.ttl - 1 };
    this.forward(dev, next, { l3, frame });
  }

  /** The tunnels a packet's outer header ends at: the inner packet continues as if it came in on the tunnel interface. */
  private decapsulate(dev: string, at: L3Iface, pkt: Pkt): void {
    const sd = this.net.devices.get(dev) as SimDevice;
    const inner = pkt.inner as Pkt;
    // the tunnel interface whose source is the outer destination
    const tun = Array.from(sd.l3.values()).find((l) => l.kind === 'tunnel' && this.tunnelEnds(dev, l.id).some((x) => compareAddr(x.dst, pkt.src) === 0)) || Array.from(sd.l3.values()).find((l) => l.kind === 'tunnel');
    if (inner.encap && inner.inner && this.ownsAddress(dev, inner.dst)) {
      this.decapsulate(dev, at, inner);
      return;
    }
    const via = tun || at;
    if (this.ownsAddress(dev, inner.dst) || isMulticastIp(inner.dst)) {
      if (inner.encap && inner.inner) this.decapsulate(dev, via, inner);
      else if (this.protocols) this.protocols.ip(dev, this.ownsAddress(dev, inner.dst) || via, inner);
      return;
    }
    if (sd.routes) this.forward(dev, { ...inner, ttl: inner.ttl - 1 }, { l3: via, frame: null });
  }

  // ------------------------------------------------------------ layer 3: sending

  newPacket(src: IpAddr, dst: IpAddr, vrf: string, msg: Msg, rides: string[] = [], ttl = 64): Pkt {
    return { id: this.pktSeq++, src, dst, ttl, vrf, msg, flow: formatAddr(src) + '>' + formatAddr(dst), rides };
  }

  /**
   * A device sends an IP packet: a unicast one along its routing table
   * (next hop resolved first), a link-local multicast one out of `out`.
   */
  send(dev: string, pkt: Pkt, out?: L3Iface): void {
    if (pkt.rides.some((r) => !this.relationUp(r))) {
      const r = pkt.rides.find((x) => !this.relationUp(x)) as string;
      this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `dropped: ${r} has failed (${pkt.msg.label})`);
      return;
    }
    if (isMulticastIp(pkt.dst)) {
      if (!out) return;
      if (out.kind === 'tunnel') {
        this.intoTunnel(dev, out, pkt);
        return;
      }
      this.emit(dev, out, { src: out.mac, dst: multicastMac(pkt.dst), msg: pkt.msg, ip: pkt });
      return;
    }
    this.forward(dev, pkt, null);
  }

  /** Forward a packet at a device (the sender itself, or a router on the way). */
  private forward(dev: string, pkt: Pkt, came: { l3: L3Iface; frame: Frame | null } | null): void {
    const sd = this.net.devices.get(dev) as SimDevice;
    const own = this.ownsAddress(dev, pkt.dst, pkt.vrf);
    if (own) {
      if (this.protocols) this.protocols.ip(dev, own, pkt);
      return;
    }
    const d = lookup(this.model, dev, pkt.vrf, pkt.dst, this.ctx());
    // a tunnel's outer packet that is not routed in the model (or whose route leads back into the tunnel): its declared underlay
    const intoOwn = d.kind === 'forward' && d.hops.length > 0 && d.hops.every((h) => {
      const l = sd.l3.get(h.iface);
      return !!l && l.kind === 'tunnel' && !!pkt.encap;
    });
    if ((d.kind !== 'forward' || !d.hops.length || intoOwn) && !came && this.viaUnderlay(dev, pkt)) return;
    if (d.kind !== 'forward' || !d.hops.length) {
      this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `dropped at ${dev}: ${d.kind === 'blackhole' ? 'a blackhole route' : 'no route to ' + formatAddr(pkt.dst)}${pkt.vrf ? ' in VRF ' + pkt.vrf : ''} (${pkt.msg.label})`);
      return;
    }
    const hop = d.hops.length === 1 ? d.hops[0] : d.hops[hashIndex(pkt.flow, d.hops.length)];
    const out = sd.l3.get(hop.iface);
    if (!out) return;
    // a next hop outside the model (no device has it): a tunnel's outer packet takes its declared underlay; anything else leaves the model
    if (hop.gateway && !this.ownerOf(hop.gateway)) {
      if (!came && this.viaUnderlay(dev, pkt)) return;
      this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `leaves the model at ${dev}: the next hop ${formatAddr(hop.gateway)} is outside it (${pkt.msg.label})`);
      return;
    }
    if (out.kind === 'tunnel') {
      if (came) this.routeNote(dev, pkt, came, out, '', hop.gateway);
      this.intoTunnel(dev, out, pkt);
      return;
    }
    const nh = hop.gateway || pkt.dst;
    // a next hop that is in the model but not on the egress interface's networks (a route out of an interface to an address behind a provider): a tunnel's outer packet takes its declared underlay
    if (!came && !out.addrs.some((a) => inNetAddr(a, nh)) && this.viaUnderlay(dev, pkt)) return;
    this.resolve(dev, out, nh, pkt, (mac) => {
      if (came) this.routeNote(dev, pkt, came, out, mac, nh);
      this.emit(dev, out, { src: out.mac, dst: mac, msg: pkt.msg, ip: pkt });
    });
  }

  /**
   * A tunnel's outer packet (IKE, ESP, GRE between the tunnel's ends) that
   * the model's routing does not carry: it follows the cables the tunnel's
   * relations are declared `over` (as Trace path does), cable by cable,
   * without being routed or resolved on the way (the devices there are
   * outside the model). False when there is no such way.
   */
  /** The device that has an address (null: none in the model). */
  ownerOf(a: IpAddr): string | null {
    for (const d of this.net.devices.values()) for (const l of d.l3.values()) if (l.addrs.some((x) => compareAddr(x.addr, a) === 0)) return d.id;
    if (this.protocols) for (const d of this.net.devices.values()) for (const l of d.l3.values()) if (this.protocols.owns(d.id, l.id).length) return d.id;
    return null;
  }

  private viaUnderlay(dev: string, pkt: Pkt): boolean {
    const links: string[] = [];
    for (const id of pkt.rides.concat(pkt.msg.relation ? [pkt.msg.relation] : [])) {
      const r = this.model.index.relations.get(id);
      if (!r) continue;
      for (const l of declaredUnderlay(this.model, r).links) if (links.indexOf(l) < 0) links.push(l);
    }
    if (!links.length) return false;
    const owner = Array.from(this.net.devices.values()).find((d) => Array.from(d.l3.values()).some((l) => l.addrs.some((a) => compareAddr(a.addr, pkt.dst) === 0)));
    if (!owner) return false;
    // the shortest way over those cables from this device to the owner
    const prev = new Map<string, { dev: string; link: string; fromEnd: 'a' | 'b' } | null>([[dev, null]]);
    let frontier = [dev];
    while (frontier.length && !prev.has(owner.id)) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const id of links.slice().sort(cmp)) {
          const l = this.net.links.get(id);
          if (!l) continue;
          const end: 'a' | 'b' | '' = l.a.device === cur ? 'a' : l.b.device === cur ? 'b' : '';
          if (!end) continue;
          const far = end === 'a' ? l.b.device : l.a.device;
          if (prev.has(far)) continue;
          prev.set(far, { dev: cur, link: id, fromEnd: end });
          next.push(far);
        }
      }
      frontier = next;
    }
    if (!prev.has(owner.id)) return false;
    const hops: Array<{ link: string; fromEnd: 'a' | 'b' }> = [];
    for (let at = owner.id; prev.get(at); at = (prev.get(at) as { dev: string }).dev) hops.unshift(prev.get(at) as { link: string; fromEnd: 'a' | 'b' });
    const lastHop = hops[hops.length - 1];
    const ll = this.net.links.get(lastHop.link) as Link;
    const lastEnd = lastHop.fromEnd === 'a' ? ll.b : ll.a;
    const port = lastEnd.iface || '@' + lastHop.link;
    const l3 = Array.from(owner.l3.values()).find((l) => l.ports.indexOf(port) >= 0) || Array.from(owner.l3.values()).find((l) => l.addrs.some((a) => compareAddr(a.addr, pkt.dst) === 0));
    const first = this.net.devices.get(dev) as SimDevice;
    const firstPort = (() => {
      const l0 = this.net.links.get(hops[0].link) as Link;
      return (hops[0].fromEnd === 'a' ? l0.a.iface : l0.b.iface) || '';
    })();
    const out = Array.from(first.l3.values()).find((l) => l.ports.indexOf(firstPort) >= 0);
    const frame: Frame = { src: out ? out.mac : '00:00:00:00:00:00', dst: l3 ? l3.mac : BROADCAST, msg: pkt.msg, ip: pkt };
    const rel = pkt.rides.length ? pkt.rides[pkt.rides.length - 1] : pkt.msg.relation || '';
    this.note('route', pkt.msg.protocol, dev, owner.id, 'underlay', '', `${formatAddr(pkt.src)} → ${formatAddr(pkt.dst)} is not routed in the model: it follows the declared underlay of ${rel} (${hops.map((h) => h.link).join(', ')}), outside the model's routing (${pkt.msg.label})`);
    let t = this.now;
    let parent: number | undefined;
    for (let i = 0; i < hops.length; i++) {
      const h = hops[i];
      const l = this.net.links.get(h.link) as Link;
      if (l.direction === 'unidirectional' && h.fromEnd === 'b') return true;
      const key = h.link + '>' + h.fromEnd;
      const start = this.slot(key, t);
      const f = this.flight(start, start + HOP, frame.msg, 'physical', { ref: 'link:' + h.link, from: h.fromEnd, to: h.fromEnd === 'a' ? 'b' : 'a' }, parent, frameEncap(frame));
      f.encapProtocols = encapProtocols(frame);
      if (!this.linkUp(h.link)) {
        f.dropped = start + HOP / 2;
        f.t1 = f.dropped;
        this.note('drop', frame.msg.protocol, dev, owner.id, frame.msg.type, '', `dropped on the failed cable ${h.link}: ${frame.msg.label}`, start);
        return true;
      }
      parent = f.id;
      t = start + HOP;
    }
    if (l3) this.deliverL3(owner.id, l3, frame, t, parent as number);
    return true;
  }

  /** The event log's line for a routed hop: in and out, the MACs before and after, the TTL. */
  private routeNote(dev: string, pkt: Pkt, came: { l3: L3Iface; frame: Frame | null }, out: L3Iface, dstMac: string, nh: IpAddr | undefined): void {
    const inMacs = came.frame ? `src ${came.frame.src} dst ${came.frame.dst}` : 'decapsulated';
    const outMacs = out.kind === 'tunnel' ? `into tunnel ${out.id}` : `src ${out.mac}${out.macSimulated ? ' (simulated)' : ''} dst ${dstMac}`;
    this.note(
      'route',
      pkt.msg.protocol,
      dev,
      '',
      'routed',
      '',
      `${dev} routes ${formatAddr(pkt.src)} → ${formatAddr(pkt.dst)}: in ${came.l3.id} (${inMacs}), out ${out.id} (${outMacs})${nh ? ', next hop ' + formatAddr(nh) : ''}, TTL ${pkt.ttl + 1} → ${pkt.ttl} (${pkt.msg.label})`,
    );
  }

  /** The tunnel's source and destination addresses (per address family). */
  tunnelEnds(dev: string, iface: string): Array<{ src: IpAddr; dst: IpAddr }> {
    const i = this.model.index.interfaces.get(dev + ':' + iface);
    if (!i || i.type !== 'tunnel') return [];
    const srcText = i.source ? (i.source.address !== undefined ? i.source.address : undefined) : undefined;
    const srcs: IpAddr[] = [];
    if (srcText) {
      const a = parseAddr(srcText);
      if (a) srcs.push(a);
    } else if (i.source && i.source.iface) {
      const l = (this.net.devices.get(dev) as SimDevice).l3.get(i.source.iface);
      if (l) for (const x of l.addrs) srcs.push(x.addr);
    }
    const dsts: IpAddr[] = [];
    if (i.destination) {
      if (i.destination.address !== undefined) {
        const a = parseAddr(i.destination.address);
        if (a) dsts.push(a);
      } else if (i.destination.device) {
        const od = this.net.devices.get(i.destination.device);
        const ol = od && i.destination.iface ? od.l3.get(i.destination.iface) : undefined;
        if (ol) for (const x of ol.addrs) dsts.push(x.addr);
        else if (od) {
          // the far end's tunnel source (the interface its tunnel back to us is sourced from)
          for (const l of od.l3.values()) {
            const oi = this.model.index.interfaces.get(od.id + ':' + l.id);
            if (!oi || oi.type !== 'tunnel' || !oi.source || !oi.source.iface) continue;
            const s = od.l3.get(oi.source.iface);
            if (s) for (const x of s.addrs) dsts.push(x.addr);
          }
        }
      }
    }
    const out: Array<{ src: IpAddr; dst: IpAddr }> = [];
    for (const s of srcs) for (const d of dsts) if (s.version === d.version) out.push({ src: s, dst: d });
    return out;
  }

  /** A packet into a tunnel: the tunnel relation's header (GRE …), then ESP when it is carried over IPsec, to the tunnel's destination. */
  private intoTunnel(dev: string, tun: L3Iface, pkt: Pkt): void {
    const ends = this.tunnelEnds(dev, tun.id).filter((e) => e.src.version === pkt.dst.version || true);
    if (!ends.length) {
      this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `dropped at ${dev}: tunnel ${tun.id} has no source or destination address (${pkt.msg.label})`);
      return;
    }
    if (!this.isL3Up(dev, tun.id)) {
      this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `dropped at ${dev}: tunnel ${tun.id} is down (${pkt.msg.label})`);
      return;
    }
    const rel = tunnelRelation(this.model, dev, tun.id);
    const layers = rel ? encapStack(this.model, rel) : [{ label: 'GRE' }];
    let cur = pkt;
    const e = ends[0];
    const rides = pkt.rides.slice();
    for (const layer of layers) {
      if (layer.relation) {
        rides.push(layer.relation);
        if (!this.relationUp(layer.relation)) {
          this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `dropped: ${layer.relation} has failed (${pkt.msg.label})`);
          return;
        }
        if (this.protocols && this.protocols.sessionUp && !this.protocols.sessionUp(layer.relation)) {
          this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `dropped at ${dev}: ${layer.label} (${layer.relation}) is not up (${pkt.msg.label})`);
          return;
        }
      }
      const proto = layer.relation ? this.relProtocol(layer.relation) : 'gre';
      const msg: Msg = { ...pkt.msg, label: pkt.msg.label, detail: `${pkt.msg.detail} — in ${layers.map((l) => l.label).slice(0, layers.indexOf(layer) + 1).join(' in ')} (${formatAddr(e.src)} → ${formatAddr(e.dst)})`, data: { ...(pkt.msg.data || {}), encap: (((pkt.msg.data || {}) as { encap?: string[] }).encap || []).concat([layer.label]), outer: proto } };
      cur = { ...this.newPacket(e.src, e.dst, '', msg, rides.slice()), inner: cur, encap: layer.label };
    }
    this.forward(dev, cur, null);
  }

  relProtocol(id: string): string {
    const r = this.model.index.relations.get(id);
    return r ? this.base(r) : '';
  }

  base(r: Relation): string {
    return protocolBaseOf(this.model, r.protocol);
  }

  // ------------------------------------------------------------ ARP and neighbour discovery

  /** The ARP timeout (ms, unscaled) and where it comes from, for an interface of a device. */
  arpTimeout(dev: string, iface: string): { ms: number; origin: string } {
    const i = this.model.index.interfaces.get(dev + ':' + iface);
    const d = this.model.index.devices.get(dev);
    if (i && i.arpTimeout !== undefined) return { ms: i.arpTimeout * 1000, origin: `configured on ${iface}` };
    if (d && d.arpTimeout !== undefined) return { ms: d.arpTimeout * 1000, origin: 'configured on the device' };
    return { ms: ARP_TIMEOUT_DEFAULT * 1000, origin: 'default (Cisco IOS; RFC 826 sets none)' };
  }

  ndReachable(dev: string, iface: string): { ms: number; origin: string } {
    const i = this.model.index.interfaces.get(dev + ':' + iface);
    const d = this.model.index.devices.get(dev);
    if (i && i.ndpReachableTime !== undefined) return { ms: i.ndpReachableTime * 1000, origin: `configured on ${iface}` };
    if (d && d.ndpReachableTime !== undefined) return { ms: d.ndpReachableTime * 1000, origin: 'configured on the device' };
    return { ms: NDP_REACHABLE_DEFAULT * 1000, origin: 'default (RFC 4861 REACHABLE_TIME)' };
  }

  private entryKey(iface: string, ip: IpAddr): string {
    return iface + '|' + formatAddr(ip);
  }

  /**
   * Resolve a next hop's MAC on an interface, then call `send` with it: at
   * once from a valid entry, else after an ARP Request / Neighbor
   * Solicitation is answered (the packet waits; unanswered after the
   * retries, it is dropped).
   */
  resolve(dev: string, l3: L3Iface, ip: IpAddr, pkt: Pkt, send: (mac: string) => void): void {
    // a virtual address this device holds itself, or its own address: never resolved
    const tab = this.arp.get(dev) as Map<string, ArpEntry>;
    const key = this.entryKey(l3.id, ip);
    const e = tab.get(key);
    if (e && e.type !== 'incomplete' && e.mac) {
      e.used = true;
      if (ip.version === 6 && e.state === 'STALE') {
        // RFC 4861: using a stale entry starts the delay before the first probe
        e.state = 'DELAY';
        e.timer = this.now + ND_DELAY_DEFAULT * 1000;
        this.tableNote(dev, e, 'DELAY', 'used while STALE: probe in 5 s unless confirmed');
      }
      send(e.mac);
      return;
    }
    if (e) {
      e.queue.push({ pkt, send });
      return;
    }
    const n: ArpEntry = { ip, ipText: formatAddr(ip), mac: '', iface: l3.id, vlan: l3.vlan, type: 'incomplete', state: 'INCOMPLETE', learned: this.now, refreshed: this.now, timer: this.now + ND_RETRANS_DEFAULT * 1000, tries: 1, used: true, queue: [{ pkt, send }] };
    tab.set(key, n);
    this.tableNote(dev, n, 'INCOMPLETE', `${pkt.msg.label} waits for ${ip.version === 4 ? 'ARP' : 'neighbour discovery'}`);
    this.solicit(dev, l3, ip, '');
  }

  /** An ARP Request (or Neighbor Solicitation): broadcast / to the solicited-node address, or unicast to `mac` (a refresh, a probe). */
  private solicit(dev: string, l3: L3Iface, ip: IpAddr, mac: string): void {
    const src = l3.addrs.find((a) => a.addr.version === ip.version && inNetAddr(a, ip)) || l3.addrs.find((a) => a.addr.version === ip.version);
    if (!src) return;
    const sim = l3.macSimulated ? ' (simulated)' : '';
    if (ip.version === 4) {
      const label = `ARP Who has ${formatAddr(ip)}? Tell ${formatAddr(src.addr)}`;
      const msg: Msg = { protocol: 'arp', type: 'ARP Request', label, detail: `ARP Request (${mac ? 'unicast refresh' : 'broadcast'}): sender ${formatAddr(src.addr)} at ${l3.mac}${sim}, target ${formatAddr(ip)} at 00:00:00:00:00:00 — to ${mac || BROADCAST}${l3.vlan ? ', VLAN ' + l3.vlan : ''}` };
      this.emit(dev, l3, { src: l3.mac, dst: mac || BROADCAST, msg, arp: { op: 'request', sha: l3.mac, spa: src.addr, tha: '00:00:00:00:00:00', tpa: ip } });
      return;
    }
    const sn = solicitedNode(ip);
    const msg: Msg = { protocol: 'ndp', type: 'Neighbor Solicitation', label: `NDP NS Who has ${formatAddr(ip)}?`, detail: `Neighbor Solicitation (ICMPv6 135): ${formatAddr(src.addr)} at ${l3.mac}${sim} asks for ${formatAddr(ip)} — to ${mac ? 'unicast ' + mac : formatAddr(sn) + ' (' + multicastMac(sn) + ')'}` };
    const pkt = this.newPacket(src.addr, mac ? ip : sn, l3.vrf, msg, [], 255);
    this.emit(dev, l3, { src: l3.mac, dst: mac || multicastMac(sn), msg, nd: { op: 'NS', src: src.addr, target: ip, lladdr: l3.mac, solicited: false }, ip: pkt });
  }

  private arpReceive(dev: string, l3: L3Iface, frame: Frame, a: ArpPdu): void {
    const tab = this.arp.get(dev) as Map<string, ArpEntry>;
    const key = this.entryKey(l3.id, a.spa);
    const e = tab.get(key);
    const ownTarget = l3.addrs.some((x) => compareAddr(x.addr, a.tpa) === 0);
    const vip = this.protocols ? this.protocols.owns(dev, l3.id).find((o) => compareAddr(o.addr, a.tpa) === 0) : undefined;
    if (a.gratuitous) {
      // a gratuitous ARP updates an entry the receiver has (RFC 826's merge; Linux's default): it creates none, so a
      // freshly booted network still resolves every next hop with a request and a reply
      if (e && e.mac !== a.sha) this.learnEntry(dev, l3, a.spa, a.sha, isVirtual(a.sha) ? 'virtual' : 'gratuitous', 'gratuitous ARP');
      else if (e) e.refreshed = this.now;
      return;
    }
    // RFC 826: the target learns the sender; others only update an entry they have
    if ((ownTarget || vip) && a.op === 'request') {
      this.learnEntry(dev, l3, a.spa, a.sha, 'dynamic', 'ARP Request for us');
      const mac = vip ? vip.mac : l3.mac;
      const label = `ARP Reply ${formatAddr(a.tpa)} is at ${shortMac(mac)}`;
      const sim = !vip && l3.macSimulated ? ' (simulated)' : vip ? ' (virtual MAC)' : '';
      const msg: Msg = { protocol: 'arp', type: 'ARP Reply', label, detail: `ARP Reply: sender ${formatAddr(a.tpa)} at ${mac}${sim}, target ${formatAddr(a.spa)} at ${a.sha} — unicast to ${a.sha}` };
      this.emit(dev, l3, { src: mac, dst: a.sha, msg, arp: { op: 'reply', sha: mac, spa: a.tpa, tha: a.sha, tpa: a.spa } });
      return;
    }
    if (a.op === 'reply' && compareAddr(a.tpa, a.spa) !== 0 && (l3.addrs.some((x) => compareAddr(x.addr, a.tpa) === 0) || e)) {
      this.learnEntry(dev, l3, a.spa, a.sha, isVirtual(a.sha) ? 'virtual' : 'dynamic', 'ARP Reply');
      return;
    }
    if (e && e.mac && e.mac !== a.sha) this.learnEntry(dev, l3, a.spa, a.sha, isVirtual(a.sha) ? 'virtual' : 'dynamic', 'ARP from the owner');
  }

  private ndReceive(dev: string, l3: L3Iface, frame: Frame, nd: NdPdu): void {
    const tab = this.arp.get(dev) as Map<string, ArpEntry>;
    if (nd.op === 'NS') {
      const own = l3.addrs.some((x) => compareAddr(x.addr, nd.target) === 0);
      const vip = this.protocols ? this.protocols.owns(dev, l3.id).find((o) => compareAddr(o.addr, nd.target) === 0) : undefined;
      if (!own && !vip) return;
      // RFC 4861 7.2.3: the solicitation's source goes in as STALE (created or updated)
      const k = this.entryKey(l3.id, nd.src);
      const e = tab.get(k);
      if (!e || e.mac !== nd.lladdr) this.learnEntry(dev, l3, nd.src, nd.lladdr, 'dynamic', 'Neighbor Solicitation', 'STALE');
      const mac = vip ? vip.mac : l3.mac;
      const sim = !vip && l3.macSimulated ? ' (simulated)' : vip ? ' (virtual MAC)' : '';
      const msg: Msg = { protocol: 'ndp', type: 'Neighbor Advertisement', label: `NDP NA ${formatAddr(nd.target)} is at ${shortMac(mac)}`, detail: `Neighbor Advertisement (ICMPv6 136, solicited): ${formatAddr(nd.target)} is at ${mac}${sim} — unicast to ${formatAddr(nd.src)} at ${nd.lladdr}` };
      const pkt = this.newPacket(nd.target, nd.src, l3.vrf, msg, [], 255);
      this.emit(dev, l3, { src: mac, dst: nd.lladdr, msg, nd: { op: 'NA', src: nd.target, target: nd.target, lladdr: mac, solicited: true }, ip: pkt });
      return;
    }
    // an advertisement: solicited → REACHABLE; unsolicited → STALE (an entry it updates; none is created, RFC 4861 7.2.5)
    const k = this.entryKey(l3.id, nd.target);
    const e = tab.get(k);
    if (nd.unsolicited) {
      if (e && e.mac !== nd.lladdr) this.learnEntry(dev, l3, nd.target, nd.lladdr, isVirtual(nd.lladdr) ? 'virtual' : 'gratuitous', 'unsolicited Neighbor Advertisement', 'STALE');
      return;
    }
    if (e) this.learnEntry(dev, l3, nd.target, nd.lladdr, isVirtual(nd.lladdr) ? 'virtual' : 'dynamic', 'Neighbor Advertisement', 'REACHABLE');
  }

  /** An entry is learned or refreshed; waiting packets go. */
  private learnEntry(dev: string, l3: L3Iface, ip: IpAddr, mac: string, type: ArpType, why: string, ndState: NdState = 'REACHABLE'): void {
    const tab = this.arp.get(dev) as Map<string, ArpEntry>;
    const key = this.entryKey(l3.id, ip);
    let e = tab.get(key);
    const was = e ? e.type + '/' + e.state + '/' + e.mac : '';
    if (!e) {
      e = { ip, ipText: formatAddr(ip), mac, iface: l3.id, vlan: l3.vlan, type, state: ip.version === 6 ? ndState : 'VALID', learned: this.now, refreshed: this.now, timer: 0, tries: 0, used: false, queue: [] };
      tab.set(key, e);
    }
    const moved = e.mac && e.mac !== mac;
    e.mac = mac;
    e.type = type;
    e.state = ip.version === 6 ? ndState : 'VALID';
    e.refreshed = this.now;
    if (was.indexOf('incomplete') === 0 || !was) e.learned = this.now;
    e.tries = 0;
    e.timer = 0;
    e.used = false;
    const now = e.type + '/' + e.state + '/' + e.mac;
    if (now !== was) this.tableNote(dev, e, ip.version === 6 ? e.state : e.type, `${why}: ${e.ipText} is at ${mac}${this.simulatedMac(mac) ? ' (simulated)' : ''}${moved ? ' (it was at another MAC)' : ''}`);
    const q = e.queue;
    e.queue = [];
    for (const w of q) w.send(mac);
  }

  private simulatedMac(mac: string): boolean {
    for (const m of this.net.macs.values()) if (m.mac === mac) return m.simulated;
    return false;
  }

  private tableNote(dev: string, e: ArpEntry, state: string, detail: string): void {
    this.note('table', e.ip.version === 4 ? 'arp' : 'ndp', dev, '', `${e.ip.version === 4 ? 'ARP' : 'Neighbor'} entry ${e.ipText}`, state, `${dev} ${e.ip.version === 4 ? 'ARP' : 'neighbour'} table, ${e.iface}: ${detail}`);
  }

  /** The entries of an interface that went down are removed (not aged: the interface is gone). */
  private flushIface(dev: string, iface: string, why: string): void {
    const tab = this.arp.get(dev);
    if (!tab) return;
    for (const [k, e] of Array.from(tab)) {
      if (e.iface !== iface) continue;
      tab.delete(k);
      this.tableNote(dev, e, 'removed', `${e.ipText} removed: ${why}`);
    }
  }

  /** Once a second: entries whose timers ran out change state, are refreshed or removed; MAC entries age out. */
  sweep(): void {
    const t = this.now;
    for (const [dev, tab] of this.arp) {
      for (const [k, e] of Array.from(tab)) {
        const l3 = (this.net.devices.get(dev) as SimDevice).l3.get(e.iface);
        if (!l3) continue;
        if (e.type === 'incomplete' || e.state === 'PROBE' || e.state === 'REFRESHING') {
          if (t < e.timer) continue;
          if (e.tries >= ND_RETRIES_DEFAULT) {
            tab.delete(k);
            this.tableNote(dev, e, 'removed', `${e.ipText} removed: no answer to ${e.tries} ${e.ip.version === 4 ? 'ARP Requests' : 'solicitations'}${e.queue.length ? '; ' + e.queue.length + ' waiting packet' + (e.queue.length === 1 ? '' : 's') + ' dropped' : ''}`);
            for (const w of e.queue) this.note('drop', w.pkt.msg.protocol, dev, '', w.pkt.msg.type, '', `dropped at ${dev}: ${e.ipText} could not be resolved (${w.pkt.msg.label})`);
            continue;
          }
          e.tries++;
          e.timer = t + ND_RETRANS_DEFAULT * 1000;
          this.solicit(dev, l3, e.ip, e.type === 'incomplete' ? '' : e.mac);
          continue;
        }
        if (e.ip.version === 4) {
          const life = this.arpTimeout(dev, e.iface).ms / this.timerScale;
          if (t - e.refreshed < life) continue;
          if (e.used) {
            // used since its last refresh: refreshed by a unicast ARP Request before it goes
            e.state = 'REFRESHING';
            e.tries = 1;
            e.timer = t + ND_RETRANS_DEFAULT * 1000;
            this.tableNote(dev, e, 'refreshing', `${e.ipText}: timeout reached while in use — refreshing (unicast ARP Request)`);
            this.solicit(dev, l3, e.ip, e.mac);
          } else {
            tab.delete(k);
            this.tableNote(dev, e, 'expired', `${e.ipText} expired (timeout ${fmtSec(this.arpTimeout(dev, e.iface).ms)}${this.timerScale !== 1 ? ', timer scale 1:' + this.timerScale : ''})`);
          }
          continue;
        }
        if (e.state === 'REACHABLE') {
          const life = this.ndReachable(dev, e.iface).ms / this.timerScale;
          if (t - e.refreshed >= life) {
            e.state = 'STALE';
            this.tableNote(dev, e, 'STALE', `${e.ipText}: reachable time over without confirmation`);
          }
        } else if (e.state === 'DELAY' && t >= e.timer) {
          e.state = 'PROBE';
          e.tries = 1;
          e.timer = t + ND_RETRANS_DEFAULT * 1000;
          this.tableNote(dev, e, 'PROBE', `${e.ipText}: probing with unicast Neighbor Solicitations`);
          this.solicit(dev, l3, e.ip, e.mac);
        }
      }
    }
    const aging = this.macAging();
    for (const [dev, tab] of this.macs) {
      for (const [k, e] of Array.from(tab)) {
        if (e.type !== 'dynamic' || t - e.refreshed < aging) continue;
        tab.delete(k);
        this.note('table', 'stp', dev, '', `MAC entry ${e.mac}`, 'aged out', `${dev} MAC table: ${e.mac} (VLAN ${e.vlan || 'untagged'}, port ${e.port}) aged out after ${fmtSec(MAC_AGING_DEFAULT * 1000)}${this.timerScale !== 1 ? ' (timer scale 1:' + this.timerScale + ')' : ''}`);
      }
    }
  }

  // ------------------------------------------------------------ gratuitous ARP

  /** A gratuitous ARP (or unsolicited Neighbor Advertisement) for an address on an interface, with a MAC (a virtual one for a new master). */
  gratuitous(dev: string, l3: L3Iface, addr: IpAddr, mac: string, why: string, protocol = 'garp'): void {
    if (addr.version === 4) {
      const msg: Msg = { protocol, type: 'Gratuitous ARP', label: `ARP Gratuitous ${formatAddr(addr)} is at ${shortMac(mac)}`, detail: `Gratuitous ARP (${why}): sender ${formatAddr(addr)} at ${mac}${this.simulatedMac(mac) ? ' (simulated)' : isVirtual(mac) ? ' (virtual MAC)' : ''}, target ${formatAddr(addr)} — to ${BROADCAST}` };
      this.emit(dev, l3, { src: mac, dst: BROADCAST, msg, arp: { op: 'request', sha: mac, spa: addr, tha: '00:00:00:00:00:00', tpa: addr, gratuitous: true } });
      return;
    }
    const all = parseAddr('ff02::1') as IpAddr;
    const msg: Msg = { protocol, type: 'Unsolicited NA', label: `NDP NA ${formatAddr(addr)} is at ${shortMac(mac)}`, detail: `Unsolicited Neighbor Advertisement (${why}): ${formatAddr(addr)} is at ${mac} — to ff02::1 (33:33:00:00:00:01)` };
    const pkt = this.newPacket(addr, all, l3.vrf, msg, [], 255);
    this.emit(dev, l3, { src: mac, dst: multicastMac(all), msg, nd: { op: 'NA', src: addr, target: addr, lladdr: mac, solicited: false, unsolicited: true }, ip: pkt });
  }

  // ------------------------------------------------------------ failures

  /** Fail a cable or relation ("link:x" / "relation:x"); the one failed before is restored first. */
  fail(ref: string): void {
    if (this.failed === ref) return;
    if (this.failed) this.restore();
    this.failed = ref;
    this.failedAt = this.now;
    const id = ref.slice(ref.indexOf(':') + 1);
    this.note('link', 'link', '', '', ref.indexOf('link:') === 0 ? 'Cable failed' : 'Relation failed', 'down', `${ref.indexOf('link:') === 0 ? 'Cable' : 'Relation'} ${id} fails at t = ${fmtSec(this.now)}`);
    // what is on its way across it is lost where it is
    this.cut();
    if (ref.indexOf('link:') === 0) {
      const l = this.net.links.get(id);
      if (l) {
        for (const e of [l.a, l.b]) {
          const port = e.iface || '@' + id;
          this.flushPort(e.device, port, `its cable ${id} failed`);
        }
      }
      this.recomputeTrees();
    }
    this.syncInterfaces();
    this.routingChanged();
    if (this.protocols) this.protocols.linkChange(ref, false);
  }

  /** Restore the failed cable or relation. */
  restore(): void {
    const ref = this.failed;
    if (!ref) return;
    this.failed = null;
    const id = ref.slice(ref.indexOf(':') + 1);
    this.note('link', 'link', '', '', ref.indexOf('link:') === 0 ? 'Cable restored' : 'Relation restored', 'up', `${ref.indexOf('link:') === 0 ? 'Cable' : 'Relation'} ${id} is restored at t = ${fmtSec(this.now)}`);
    if (ref.indexOf('link:') === 0) this.recomputeTrees();
    this.syncInterfaces();
    this.routingChanged();
    if (this.protocols) this.protocols.linkChange(ref, true);
  }

  /** MAC entries learned on a port whose cable failed are removed. */
  private flushPort(dev: string, port: string, why: string): void {
    const sd = this.net.devices.get(dev);
    const tab = this.macs.get(dev);
    if (!sd || !tab) return;
    const bp = sd.portOf.get(port);
    if (!bp) return;
    const n = Array.from(tab).filter(([, e]) => e.port === bp && e.type === 'dynamic');
    for (const [k] of n) tab.delete(k);
    if (n.length) this.note('table', 'stp', dev, '', 'MAC entries removed', '', `${dev} MAC table: ${n.length} entr${n.length === 1 ? 'y' : 'ies'} on port ${bp} removed (${why}): ${n.map(([, e]) => e.mac).join(', ')}`);
  }

  /** Cut what is on its way over the failed cable or relation: those dots are dropped, what they would deliver never arrives. */
  private cut(): void {
    const ref = this.failed as string;
    const t = this.now;
    const dead = new Set<number>();
    for (const f of this.flights) {
      if (f.view !== 'physical' || f.hidden || f.dropped !== undefined) continue;
      if (f.t1 <= t) continue;
      const parentDead = f.parent !== undefined && dead.has(f.parent);
      if (parentDead) {
        f.hidden = true;
        dead.add(f.id);
        continue;
      }
      if (f.track.ref === ref) {
        f.dropped = Math.max(t, f.t0);
        f.t1 = f.dropped;
        dead.add(f.id);
        this.note('drop', f.protocol, '', '', f.label, '', `lost on ${ref.slice(5)} when it failed: ${f.label}`);
      }
    }
    for (const d of this.pending) if (dead.has(d.flight)) d.cancelled = true;
  }

  // ------------------------------------------------------------ the tables, read

  /** A device's ARP (IPv4) and neighbour (IPv6) entries, sorted by address. */
  arpRows(dev: string, version: 4 | 6): ArpRow[] {
    const tab = this.arp.get(dev);
    if (!tab) return [];
    const rows: ArpRow[] = [];
    const t = this.now;
    for (const e of tab.values()) {
      if (e.ip.version !== version) continue;
      let remaining: number | null = null;
      if (e.type === 'incomplete' || e.state === 'PROBE' || e.state === 'REFRESHING') remaining = Math.max(0, e.timer - t + (ND_RETRIES_DEFAULT - e.tries) * ND_RETRANS_DEFAULT * 1000);
      else if (version === 4) remaining = Math.max(0, this.arpTimeout(dev, e.iface).ms / this.timerScale - (t - e.refreshed));
      else if (e.state === 'REACHABLE') remaining = Math.max(0, this.ndReachable(dev, e.iface).ms / this.timerScale - (t - e.refreshed));
      else if (e.state === 'DELAY') remaining = Math.max(0, e.timer - t);
      rows.push({
        ip: e.ipText,
        mac: e.mac,
        macSimulated: !!e.mac && this.simulatedMac(e.mac),
        iface: e.iface,
        vlan: e.vlan,
        type: e.type,
        state: version === 6 ? e.state : e.state === 'REFRESHING' ? 'refreshing' : e.type === 'incomplete' ? 'incomplete' : '',
        age: t - (e.type === 'incomplete' ? e.learned : e.refreshed),
        remaining,
        version,
      });
    }
    return rows.sort((a, b) => compareAddr(parseAddr(a.ip) as IpAddr, parseAddr(b.ip) as IpAddr) || cmp(a.iface, b.iface));
  }

  /** A switch's MAC table, sorted by VLAN and MAC. */
  macRows(dev: string): MacRow[] {
    const tab = this.macs.get(dev);
    if (!tab) return [];
    const t = this.now;
    const aging = this.macAging();
    return Array.from(tab.values())
      .filter((e) => e.type === 'static' || t - e.refreshed < aging)
      .map((e) => ({ mac: e.mac, macSimulated: this.simulatedMac(e.mac), vlan: e.vlan, port: e.port, type: e.type, age: e.type === 'static' ? 0 : t - e.refreshed, remaining: e.type === 'static' ? null : Math.max(0, aging - (t - e.refreshed)) }))
      .sort((a, b) => a.vlan - b.vlan || cmp(a.mac, b.mac));
  }

  /** The timers at the top of a device's ARP / neighbour table: the device's own (or the default) and the interfaces that differ. */
  arpTimers(dev: string): TableTimer[] {
    const d = this.model.index.devices.get(dev);
    const out: TableTimer[] = [];
    const arp = d && d.arpTimeout !== undefined ? { s: d.arpTimeout, o: 'configured' } : { s: ARP_TIMEOUT_DEFAULT, o: 'default (Cisco IOS; RFC 826 sets none)' };
    const nd = d && d.ndpReachableTime !== undefined ? { s: d.ndpReachableTime, o: 'configured' } : { s: NDP_REACHABLE_DEFAULT, o: 'default (RFC 4861 REACHABLE_TIME)' };
    out.push({ label: 'ARP entry timeout', seconds: arp.s, origin: arp.o });
    out.push({ label: 'NDP reachable time', seconds: nd.s, origin: nd.o });
    const sd = this.net.devices.get(dev);
    if (sd) {
      for (const l3 of Array.from(sd.l3.values()).sort((a, b) => cmp(a.id, b.id))) {
        const i = this.model.index.interfaces.get(dev + ':' + l3.id);
        if (i && i.arpTimeout !== undefined) out.push({ label: `ARP entry timeout on ${l3.id}`, seconds: i.arpTimeout, origin: 'configured on the interface' });
        if (i && i.ndpReachableTime !== undefined) out.push({ label: `NDP reachable time on ${l3.id}`, seconds: i.ndpReachableTime, origin: 'configured on the interface' });
      }
    }
    out.push({ label: 'Retransmit interval', seconds: ND_RETRANS_DEFAULT, origin: 'default (RFC 4861 RETRANS_TIMER)' });
    out.push({ label: 'Requests before an incomplete entry is dropped', seconds: ND_RETRIES_DEFAULT, origin: 'default (RFC 4861 MAX_MULTICAST_SOLICIT)' });
    return out;
  }

  /** The MAC table's timer. */
  macTimers(): TableTimer[] {
    return [{ label: 'Aging time', seconds: MAC_AGING_DEFAULT, origin: 'default (IEEE 802.1D)' }];
  }

  /** Change the timer scale (from now on: the entries' remaining times follow the new scale). */
  setTimerScale(n: number): void {
    if (n === this.timerScale || n < 1) return;
    this.note('note', 'link', '', '', 'Timer scale', '', `The ARP, neighbour and MAC table timers run ${n === 1 ? 'in real time' : n + ' times faster (1:' + n + ')'} from t = ${fmtSec(this.now)}; the configured values are unchanged`);
    this.timerScale = n;
  }

  // ------------------------------------------------------------ estimates (for the logical view's dots)

  /** About how long a packet from a device to an address takes: its traced path's cables × HOP (cached per routing state). */
  estimate(dev: string, to: IpAddr): number {
    const key = dev + '>' + formatAddr(to);
    const known = this.estimates.get(key);
    if (known !== undefined) return known;
    let cables = 1;
    try {
      const tr = tracePath(this.model, { from: dev, to: formatAddr(to) }, this.ctx());
      if (tr.paths.length) {
        const count = (p: { hops: Array<{ links: string[]; underlay?: { hops: Array<{ links: string[] }> } }> }): number => p.hops.reduce((n, h) => n + h.links.length + (h.underlay ? count(h.underlay as never) : 0), 0);
        cables = Math.max(1, count(tr.paths[0] as never));
      }
    } catch (e) {
      cables = 2;
    }
    const ms = cables * HOP;
    this.estimates.set(key, ms);
    return ms;
  }
}

function before(a: QItem, b: QItem): boolean {
  return a.t < b.t || (a.t === b.t && a.seq < b.seq);
}

/** A stable index for a key among n (the same flow takes the same equal-cost path or member link). */
export function hashIndex(key: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}

function inNetAddr(a: { net: IpAddr & { prefix: number } }, ip: IpAddr): boolean {
  if (a.net.version !== ip.version) return false;
  let bits = a.net.prefix;
  for (let i = 0; i < ip.bytes.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((a.net.bytes[i] & mask) !== (ip.bytes[i] & mask)) return false;
  }
  return true;
}

/** Is it the virtual MAC of a VRRP / CARP, HSRP or GLBP group? */
export function isVirtual(mac: string): boolean {
  return /^00:00:5e:00:0[12]:/.test(mac) || /^00:00:0c:07:ac:/.test(mac) || /^00:07:b4:/.test(mac);
}

/** The protocols of the encapsulation a frame's packet is in (outermost last). */
function encapProtocols(frame: Frame): string[] | undefined {
  const out: string[] = [];
  let p = frame.ip;
  while (p && p.encap && p.inner) {
    const o = p.msg.data && (p.msg.data as { outer?: string }).outer;
    if (o) out.unshift(o);
    p = p.inner;
  }
  return out.length ? out : undefined;
}

/** The encapsulation a frame's packet is in (outermost last). */
function frameEncap(frame: Frame): string[] {
  const out: string[] = [];
  let p = frame.ip;
  while (p && p.encap && p.inner) {
    out.unshift(p.encap);
    p = p.inner;
  }
  return out;
}

/** Seconds as the log writes them ("12.4 s", "4 h"). */
export function fmtSec(ms: number): string {
  const s = ms / 1000;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600} h`;
  if (s >= 60 && s % 60 === 0) return `${s / 60} min`;
  return `${Math.round(s * 10) / 10} s`;
}

function parseAddr(s: string): IpAddr | null {
  return parseAddress(s);
}

function protocolBaseOf(model: Model, name: string): string {
  return protocolBase(model.protocols, name);
}
