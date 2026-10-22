/**
 * The protocol simulation's engine: a discrete-event simulation of the
 * model's network in simulated time (milliseconds), deterministic (the
 * same model and the same actions give the same timeline; the only
 * randomness is a jitter from a fixed seed). It never changes the model.
 *
 * Layer 1. A frame takes the cable's latency (propagation) plus its
 * serialization time (its size at the cable's speed); frames on one cable
 * and direction go one after the other. A share of frames is lost where
 * the packet loss says (from a fixed seed). A cable is up while nothing
 * takes it down: a failure, flapping, a shut port, a device powered off.
 * When it goes dark its ports report it after the loss-of-signal
 * detection time (frames are lost meanwhile); when it comes back, after
 * the link-up delay (autonegotiation; a wireless link: its access point's
 * association time). The parameters come from params.ts in its order of
 * precedence; a change applies from the next frame, timer or check on.
 *
 * Layer 2. Bridges learn the source MAC per port and VLAN, flood broadcast,
 * multicast and unknown unicast within the VLAN to every other port that
 * carries it, and send known unicast to the learned port only; the link
 * ends' tagging decides what a port carries and whether a frame leaves it
 * tagged (net.ts). A frame never leaves its VLAN on a bridge. Layer-2
 * loops are broken by a spanning tree per VLAN (net.ts spanningTree),
 * whether or not the model runs STP; topology changes flush the MAC tables
 * of the VLANs whose tree changed, and a port that starts forwarding waits
 * for its switch's spanning-tree convergence (RSTP: at once at the
 * failure, 3 hellos further away; STP: 2 × forward delay, max age +
 * 2 × forward delay further away). A frame's way through the bridges is
 * decided when it is sent (with the MAC tables of that moment).
 *
 * Layer 3. A device sends a unicast IP packet to its next hop (the routing
 * tables of analysis/routing.ts, with what is up in the simulation and the
 * adjacencies the routing protocols have formed) after resolving the next
 * hop's MAC address: ARP (IPv4) or neighbour discovery (IPv6), with an
 * ARP Request or Neighbor Solicitation, then the packet waits; the reply
 * fills the table and releases it. A router decrements the TTL (hop limit)
 * and rewrites the source and destination MAC per hop, and says so in the
 * event log. A router uses the routes of its last recomputation: after a
 * change, its route recomputation delay (SPF and FIB) passes first.
 * Multicast (OSPF, VRRP …) goes to the group's multicast MAC
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
 * Virtual networking (net.ts expandVirtual). A virtual switch learns
 * like a bridge but takes no part in the spanning tree: a frame from an
 * uplink never leaves by another (split horizon), and a guest's frames
 * leave by its teaming's uplink (active / standby: the first that is up;
 * load- and source-based: one of those up, by its port; LACP: the bond);
 * broadcasts arriving on a standby uplink are dropped. When an uplink
 * goes down, the switch fails over once its failover detection time has
 * passed (frames meanwhile are lost) and announces its guests' MAC
 * addresses on the new uplink with a RARP each (notify switches); it fails
 * back when the uplink returns. A host powered off takes its guests down;
 * a VM of an HA cluster is restarted on another member after the VM
 * restart time (its links there take over). A container host forwards
 * between its bridge networks and the rest; with NAT it rewrites the
 * source to its own address and keeps the translation for the replies,
 * and a packet to a published port is forwarded to its container. A
 * macvlan / ipvlan network's host never reaches its containers. A
 * container starts after its engine's start time; when its host boots or
 * its engine starts again, its restart policy decides whether it does.
 *
 * Network events, several at once: failed cables and relations, flapping
 * cables, shut interfaces, devices powered off (and booting again),
 * container engines stopped. The
 * ports at a cable that went down go down once they notice (their ARP and
 * neighbour entries, and the MAC entries learned on them, are removed);
 * frames on it, and frames that would still cross it, are dropped where
 * they are. A device powered off loses its tables and sessions; powered on,
 * it boots for its boot time and starts afresh. Everything else reacts as
 * its timers say.
 */
import { IpAddr, parseAddress, parsePrefix } from '../../model/ip';
import { protocolBase } from '../../model/protocols';
import { ND_DELAY_DEFAULT } from '../../model/sim-profiles';
import { Link, Model, Relation, ifaceKey, relationDevices } from '../../model/types';
import { deviceTypeInText } from '../../model/device-types';
import { isGuest, vethNetwork, isContainer, isVm } from '../../model/virtual';
import { compareAddr, formatAddr, inPrefix } from '../ipmath';
import { Connected, DvTables, RibEntry, RoutingCtx, deviceVrfs, lookup } from '../routing';
import { virtualGateways } from '../identity';
import type { AnalysisSnapshot, SnapAddr } from '../snapshot';
import { declaredUnderlay, encapStack, tunnelRelation, tracePath } from '../trace';
import { BROADCAST, isGroupMac, isLinkLocalGroup, isMulticastIp, multicastMac, rng, solicitedNode, modelSeed, shortMac } from './mac';
import { BridgePort, CableEnd, L3Iface, Lease, SimAddr, SimDevice, SimNet, StpConfig, buildNet, carries, ingressVlan, l2Domain, otherEnd, portKey, portRefOf, portVlansText, spanningTree, linkPort } from './net';
import { ParamChange, ParamValue, Resolved, SimParams, ceRef, changeText, durationText, formatValue, hvRef, ifaceRef, relRef, resolvedText, scopeRef, sourceText, vlanRef, vlanValue, vswRef, zoneRef, parsePorts, portsMatch } from './params';
import { ArpRow, ArpType, Cast, Flight, Headers, L4, MacRow, McDecision, McPort, Msg, NdState, NetEvent, Pkt, Quote, SimEvent, SnoopResult, TableTimer, Track } from './types';
import { parseSpeed } from '../../model/speed';
import { capabilities } from '../../model/capabilities';
import { SeparationSim } from './separation';
import { domainOf, otherDomain } from '../separation';

/** A packet's fragments that have not all arrived within this are dropped (Linux ipfrag_time 30 s). */
export const REASSEMBLY_MS = 30000;
/** A frame going round a Layer 2 loop without spanning tree is followed for this many rounds (a real storm goes on until the loop is broken). */
export const STORM_ROUNDS = 6;
/** Flights are kept this long after they end (for the animation and the export). */
const FLIGHT_KEEP = 4000;
/** Within one moment, the presentation's frame budget is asked every this many events (runUntil's yieldNow). */
const YIELD_EVERY = 64;
/** The jitter of starts and timers: up to this share of a typical hop's time. */
export const JITTER_SHARE = 0.6;
/** A message's payload in bytes when its protocol says nothing (for the serialization time). */
const PAYLOAD = 80;
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
  /** a duplicate address detection probe (from ::) */
  dad?: boolean;
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
  /** a frame going round a Layer 2 loop without spanning tree: how many times it came back (a storm) */
  loops?: number;
  /** the VLAN it was in where it left a bridge port untagged (to explain a native or access VLAN mismatch where it arrives) */
  inVlan?: number;
}

/** Why an ICMP error is sent (engine.icmpError). */
export type IcmpKind = 'net' | 'host' | 'ttl' | 'frag' | 'port' | 'admin' | 'reassembly';

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
  /** the outer header of what a tunnel relation carries from a device: its data's transport (ESP; IP 4, 47; UDP 51820, 4789 …) */
  outerL4?(relation: string, dev: string): L4 | undefined;
  /** a device was powered off: its sessions, groups and timers stop */
  deviceDown?(dev: string): void;
  /** a device finished booting: its sessions start afresh */
  deviceUp?(dev: string): void;
  /** parameters changed: periodic timers are rescheduled */
  paramsChanged?(changes: ParamChange[]): void;
  /** a firewall's policy for a packet it would forward: pass, or dropped / rejected (it logs and answers itself) */
  filter?(dev: string, pkt: Pkt, from: L3Iface, to: L3Iface, via?: IpAddr | null): boolean;
  /** a packet a device sent itself could not go (no route, no ARP answer, too big): the sender's own error, no ICMP on the wire */
  localError?(dev: string, pkt: Pkt, kind: IcmpKind, text: string, mtu?: number): void;
  /** the table sweep (once a second): the transport's timers and the firewalls' sessions */
  sweep?(): void;
  /** a switch forwards a frame to a group MAC: the ports that get it and why (snooping); null: no multicast IP, all ports */
  snoop?(sd: SimDevice, from: string | null, vlan: number, frame: Frame, t: number): SnoopResult | null;
  /** a routed multicast packet at a router: true when multicast routing took it */
  mroute?(dev: string, l3: L3Iface, pkt: Pkt): boolean;
  /** has a device's own interface joined a group (a router listening as a host: a PTP clock's port)? */
  joined?(dev: string, iface: string, group: IpAddr): boolean;
  /** a router recomputed its routes (multicast checks its RPF interfaces) */
  routesChanged?(dev: string): void;
  /** what routing depends on changed: routers whose own adjacencies changed advertise their new record */
  originate?(): void;
  /** a distance-vector protocol's tables as the routers hold them (RIP), and their version (bumped at every change); null: none */
  dvTables?(protocol: string): DvTables | null;
  dvVersion?(): number;
  /** what a router has learned (its records of every origin), null when it runs no routing protocol */
  viewOf?(dev: string): Array<{ origin: string; inst: string; seq: number; at: number; adj: string[]; up: string[] }> | null;
}

interface QItem {
  t: number;
  seq: number;
  fn: () => void;
  /** a delivery: the flights (dots) that bring it — a presentation hold on one of them stops runUntil before it */
  gates?: number[];
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
  /** packets waiting for the address (fwd: one being routed, not its own) */
  queue: Array<{ pkt: Pkt; send: (mac: string) => void; fwd: boolean }>;
  /** when the last request went out */
  sentAt: number;
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

/** A device's lifecycle (Engine.powerState): its state, since when, until when it boots, why it is off. */
export interface DevicePower {
  state: 'on' | 'off' | 'booting';
  since?: number;
  until?: number;
  why?: string;
}

export interface EngineOptions {
  /** the ARP / NDP / MAC table timers run this many times faster (1 = real time) */
  timerScale?: number;
  /** the simulation-wide parameters (Start simulation…); the devices' own come from the model */
  params?: { [key: string]: ParamValue };
}

/** A port flapping (its cable follows): down for the flapping down time, up for the up time, so many cycles (0: until stopped). */
export interface Flap {
  /** the port's cable */
  link: string;
  /** the port that flaps ("iface:dev:port") */
  ref: string;
  since: number;
  down: boolean;
  done: number;
  token: number;
  /** the model's own (an interface's flapping attribute): the scenario, not a change from outside */
  configured?: boolean;
  /** how it ended (its cycles done, or Stop flapping) and when; unset while it flaps */
  ended?: 'done' | 'stopped';
  endedAt?: number;
}

export class Engine {
  readonly model: Model;
  readonly net: SimNet;
  protocols: Protocols | null = null;
  now = 0;
  timerScale: number;
  /** the seeded streams, one per kind and object ("jitter|r1", "loss|l2"): an object's numbers depend on nothing else in the model */
  private streams = new Map<string, () => number>();
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
  /** the flight whose arrival is being handled now (what is sent meanwhile is caused by it: Flight.cause) */
  private causeFlight: number | null = null;
  /** the parameters in effect (params.ts): simulation-wide, and each device's own */
  readonly params: SimParams;
  /** the Security gateways' permitted transfers (sim/separation.ts) */
  sep: SeparationSim;
  /** failed cables and relations, by id, with when they failed */
  readonly failedLinks = new Map<string, number>();
  readonly failedRels = new Map<string, number>();
  readonly flaps = new Map<string, Flap>();
  /** shut physical ports ("dev|port") and shut layer-3 interfaces ("dev:iface"), with when */
  readonly shutPorts = new Map<string, number>();
  readonly shutL3 = new Map<string, number>();
  /** devices powered off (or still booting), with when; booting: when they are up */
  readonly off = new Map<string, number>();
  readonly booting = new Map<string, number>();
  /** inline appliances that failed open: they pass frames, nothing else */
  readonly bypass = new Set<string>();
  /** the cables' state: up, down, or negotiating (coming back); missing: up */
  private cable = new Map<string, 'up' | 'down' | 'negotiating'>();
  /** the ports' carrier as their device sees it ("dev|port"); missing: up */
  private carrier = new Map<string, boolean>();
  /** a pending loss-of-signal detection or link-up per port / cable (its token) */
  private carrierToken = new Map<string, number>();
  private tokens = 0;
  /** ports that start forwarding in a VLAN once their spanning tree converged ("dev|bp|vlan" → time) */
  private fwdAt = new Map<string, number>();
  /** bumped whenever what the diagram marks changes (an event, a cable going down or up) */
  stateVersion = 0;
  /** the transitions of flapping ports so far (each down and each up): the presentation's epoch counts them (Simulation.presentationEpoch) */
  flapTransitions = 0;
  private stp = new Map<number, Tree>();
  private arp = new Map<string, Map<string, ArpEntry>>();
  private macs = new Map<string, Map<string, MacEntry>>();
  private l3State = new Map<string, boolean>();
  private ctxObj: RoutingCtx | null = null;
  /** each router's routes as of its last recomputation (shared by the routers that recomputed at the same moment) */
  private devCtx = new Map<string, RoutingCtx>();
  private spfPending = new Set<string>();
  private spfAt = new Map<number, { ctx: RoutingCtx; devs: string[] }>();
  /** changes whenever what routing depends on does (interfaces, adjacencies, the failures) */
  routingVersion = 0;
  private estimates = new Map<string, number>();
  private macFullNoted = new Set<string>();
  /** when each device last sent an ICMP error (its rate limit) */
  private icmpLast = new Map<string, number>();
  /** the subnets' broadcast addresses in the model (IPv4, prefix ≤ 30) */
  private bcasts = new Set<string>();
  /** fragments waiting for the rest of their packet ("dev|src|dst|id") */
  private frags = new Map<string, { got: Map<number, number>; first: number; pkt: Pkt; l3: L3Iface; dev: string }>();
  /** VLANs with a broadcast storm going on (a Layer 2 loop without spanning tree): since when, over which cables */
  readonly storms = new Map<number, { since: number; links: string[]; frames: number }>();
  private stormNoted = new Map<string, number>();
  /** a wireless client's last frame (its access point's idle timeout), by link */
  private wifiActive = new Map<string, number>();
  /** the log line of a message, by the message (its headers when it is sent) */
  private msgEvents = new WeakMap<Msg, SimEvent>();
  /**
   * IPv6 host configuration (ipv6.ts): what duplicate address detection
   * hears, and the learned on-link prefixes and default routers routing
   * takes into account.
   */
  v6Hook: {
    /** a DAD probe (an NS from ::) for a target arrived */
    dadProbe(dev: string, l3: L3Iface, target: IpAddr): void;
    /** is an address of the interface tentative (or a duplicate): it answers no solicitation for it (RFC 4862 §5.4) */
    unusable(dev: string, l3: L3Iface, target: IpAddr): boolean;
    /** a Neighbor Advertisement for a target arrived */
    advert(dev: string, l3: L3Iface, target: IpAddr, lladdr: string): void;
    connected(dev: string): Connected[];
    routes(dev: string, vrf: string): RibEntry[];
    /** the IPv6 addresses the hosts acquired (link-local, SLAAC, DHCPv6) with their state, for analysis snapshots */
    addresses(): SnapAddr[];
  } | null = null;
  /**
   * PTP (ptp.ts): what a transparent clock sees of the event messages it
   * forwards (their arrival at its port, their start on the wire of each
   * port they leave by: the residence time), and the moment a clock's own
   * message starts on the wire (its hardware timestamp). `egress` may give
   * back the frame with its correction field updated (a copy).
   */
  ptpHook: {
    ingress(dev: string, port: string, frame: Frame, t: number): void;
    egress(dev: string, port: string, frame: Frame, tIn: number, tOut: number): Frame;
  } | null = null;
  /** the IPv6 addresses ipv6.ts gave each interface ("dev:iface"): the simulation's, never the model's */
  private dyn6 = new Map<string, SimAddr[]>();

  /**
   * The learned IPv6 addresses of an interface (SLAAC, DHCPv6; preferred
   * first, deprecated after): they replace the ones it had; routing
   * follows, and what waited for an address goes.
   */
  setV6(dev: string, iface: string, list: SimAddr[]): void {
    const sd = this.net.devices.get(dev);
    const l3 = sd ? sd.l3.get(iface) : undefined;
    if (!sd || !l3) return;
    const k = dev + ':' + iface;
    const was = this.dyn6.get(k) || [];
    const same = was.length === list.length && was.every((a, i) => compareAddr(a.addr, list[i].addr) === 0);
    this.dyn6.set(k, list.slice());
    l3.addrs = l3.addrs.filter((a) => was.indexOf(a) < 0).concat(list);
    if (same) return;
    this.stateVersion++;
    this.routingChanged();
    if (this.protocols) this.protocols.ifaceChange(dev, l3, this.isL3Up(dev, iface));
    this.recheckWaits();
  }

  /** An interface's link-local address (null: none, or not yet validated). */
  setLinkLocal(dev: string, iface: string, a: SimAddr | null): void {
    const sd = this.net.devices.get(dev);
    const l3 = sd ? sd.l3.get(iface) : undefined;
    if (!l3) return;
    if (a) l3.ll = a;
    else delete l3.ll;
    this.stateVersion++;
    if (a) this.recheckWaits();
  }

  /** Duplicate address detection: a Neighbor Solicitation from :: for a tentative address, to its solicited-node group (RFC 4862 §5.4.2). */
  dadSolicit(dev: string, l3: L3Iface, target: IpAddr): void {
    const sn = solicitedNode(target);
    const msg: Msg = { protocol: 'ndp', type: 'Neighbor Solicitation', label: `NDP NS DAD ${formatAddr(target)}`, detail: `Neighbor Solicitation (ICMPv6 135) for duplicate address detection: is ${formatAddr(target)} in use? From :: (the address is tentative) to ${formatAddr(sn)} (${multicastMac(sn)}), no source link-layer address (RFC 4862 §5.4.2)` };
    const pkt = this.newPacket(parseAddress('::') as IpAddr, sn, l3.vrf, msg, [], 255);
    pkt.l4 = { proto: 'icmp', num: 58, icmpType: 135, icmpCode: 0, icmpName: 'Neighbor Solicitation' };
    pkt.len = 24;
    this.note('message', 'ndp', dev, '', msg.type, '', msg.detail, this.now, msg);
    this.emit(dev, l3, { src: l3.mac, dst: multicastMac(sn), msg, nd: { op: 'NS', src: parseAddress('::') as IpAddr, target, lladdr: '', solicited: false, dad: true }, ip: pkt });
  }

  /** Is the address one of the interface's own: configured, leased, learned, or its link-local one? */
  private hasOwn(l3: L3Iface, a: IpAddr): boolean {
    return l3.addrs.some((x) => compareAddr(x.addr, a) === 0 && this.usableAddr(l3, x.addr)) || (!!l3.ll && compareAddr(l3.ll.addr, a) === 0);
  }

  /**
   * A device's addresses now, each with its interface: its written ones that are usable (not tentative, not a
   * duplicate), what SLAAC and DHCPv6 added to them, and its DHCP leases — the identity a policy's device or
   * interface spec has in the simulation (analysis/policy.ts PolicyIds). An expired lease is not one.
   */
  effectiveAddrs(dev: string): Array<{ iface: string; addr: IpAddr }> {
    const out: Array<{ iface: string; addr: IpAddr }> = [];
    const sd = this.net.devices.get(dev);
    if (sd) for (const l of sd.l3.values()) for (const a of l.addrs) if (this.usableAddr(l, a.addr)) out.push({ iface: l.id, addr: a.addr });
    for (const c of this.leaseConnected(dev)) if (!out.some((x) => x.iface === c.iface && compareAddr(x.addr, c.addr) === 0)) out.push({ iface: c.iface, addr: c.addr });
    return out;
  }

  /** Is one of an interface's written addresses usable now (not a tentative or duplicate IPv6 address)? */
  usableAddr(l3: L3Iface, a: IpAddr): boolean {
    return !l3.unusable || !l3.unusable.length || l3.unusable.indexOf(formatAddr(a)) < 0;
  }

  /** A written IPv6 address becomes unusable (tentative, a duplicate) or usable (its duplicate address detection passed). */
  setUsable(dev: string, iface: string, a: IpAddr, usable: boolean): void {
    const sd = this.net.devices.get(dev);
    const l3 = sd ? sd.l3.get(iface) : undefined;
    if (!l3) return;
    const t = formatAddr(a);
    const list = (l3.unusable || []).filter((x) => x !== t);
    if (!usable) list.push(t);
    l3.unusable = list;
    this.stateVersion++;
  }

  constructor(model: Model, opts: EngineOptions = {}) {
    this.model = model;
    this.net = buildNet(model);
    this.timerScale = opts.timerScale || 1;
    const eng = this;
    this.sep = new SeparationSim({
      get now(): number {
        return eng.now;
      },
      note: (kind, protocol, device, peer, what, state, detail) => eng.note(kind, protocol, device, peer, what, state, detail),
      param: (key, dev) => eng.params.get(key, dev),
      loss: () => eng.stream('loss', 'separation')(),
    });
    const devs = new Map<string, { type: string; values: Map<string, ParamValue> }>();
    for (const d of model.devices) devs.set(d.id, { type: d.type, values: d.simulation || new Map() });
    this.params = new SimParams(opts.params, devs);
    this.objectParamsFrom(model);
    for (const d of this.net.devices.values()) {
      this.arp.set(d.id, new Map());
      if (d.bridge) this.macs.set(d.id, new Map());
      for (const l3 of d.l3.values()) this.l3State.set(d.id + ':' + l3.id, true);
    }
    for (const d of this.net.devices.values()) if (d.bridge) this.staticMacs(d);
    // an HA standby's links wait until their VM is restarted there
    for (const [id, v] of this.net.vlinks) if (v.at !== undefined) this.parked.add(id);
    for (const d of this.net.devices.values()) for (const l3 of d.l3.values()) for (const a of l3.addrs) if (a.addr.version === 4 && a.net.prefix <= 30) this.bcasts.add(formatAddr(subnetBroadcast(a)));
  }

  // ------------------------------------------------------------ time and events

  /**
   * The presentation's hold (the pacing's: is a flight's dot still on its way on screen?). runUntil stops
   * before a delivery one of whose flights it holds, and leaves it and everything after it pending; run
   * (the tests, a jump, an experiment's result) never asks. Null: nothing is held (headless).
   */
  hold: ((flight: number) => boolean) | null = null;
  /** the flight runUntil last stopped before (its hold), null when it did not stop for one */
  held: number | null = null;

  /** Run fn at simulated time t (never before now); `gates`: the flights whose arrival it is (a delivery). */
  at(t: number, fn: () => void, gates?: number[]): void {
    const item: QItem = { t: Math.max(t, this.now), seq: this.seq++, fn };
    if (gates && gates.length) {
      item.gates = gates;
      // (each flight knows its deliveries still queued: pending until processed, whatever their time — Flight.due)
      for (const g of gates) {
        const f = this.flightById.get(g);
        if (f) f.due = (f.due || 0) + 1;
      }
    }
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

  after(dt: number, fn: () => void, gates?: number[]): void {
    this.at(this.now + dt, fn, gates);
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

  /**
   * Process the events up to time t moment by moment, and stop after the
   * first moment at which `stop` says so (the clock is at that moment);
   * else set the clock to t. A delivery whose dot the presentation holds
   * (`hold`) stops it before that delivery, event by event — even within a
   * moment, so what comes before it at the same time (by its sequence) is
   * done and what comes after it is not: `held` names the flight, the
   * clock stays at the last event done, and true is returned. `yieldNow`
   * (the presentation's frame budget) is asked every YIELD_EVERY events
   * within a moment too: a moment of very many events may end partway
   * (false is returned, the clock at that moment); the rest stays queued in
   * its order and the next call goes on with it.
   */
  runUntil(t: number, stop: () => boolean, yieldNow?: () => boolean): boolean {
    this.held = null;
    for (;;) {
      const n = this.nextTime();
      if (n === null || n > t) break;
      let k = 0;
      while (this.nextTime() === n) {
        const g = this.q[0].gates;
        if (g && this.hold) {
          const h = this.holder(g);
          if (h !== null) {
            this.held = h;
            this.prune();
            return true;
          }
        }
        this.exec(this.pop() as QItem);
        if (yieldNow && ++k % YIELD_EVERY === 0 && this.nextTime() === n && yieldNow()) {
          this.prune();
          return false;
        }
      }
      if (stop()) {
        this.prune();
        return false;
      }
    }
    this.now = Math.max(this.now, t);
    this.prune();
    return false;
  }

  /** The first of a delivery's flights the presentation holds (null: none). */
  private holder(gates: number[]): number | null {
    for (const g of gates) if (g >= 0 && (this.hold as (f: number) => boolean)(g)) return g;
    return null;
  }

  /** The delivery next due waits for a held flight (the pacing's status: what it waits for); null: none. */
  heldNext(): number | null {
    const g = this.q.length ? this.q[0].gates : undefined;
    return g && this.hold ? this.holder(g) : null;
  }

  /** The serial number the next flight gets. */
  get flightSerial(): number {
    return this.flightSeq;
  }

  /** The flights created since a serial number. */
  flightsSince(serial: number): Flight[] {
    const out: Flight[] = [];
    for (let i = this.flights.length - 1; i >= 0 && this.flights[i].id >= serial; i--) out.push(this.flights[i]);
    return out;
  }

  /** Process every event up to time t, and set the clock to t. */
  run(t: number): void {
    for (;;) {
      const n = this.nextTime();
      if (n === null || n > t) break;
      this.exec(this.pop() as QItem);
    }
    this.now = Math.max(this.now, t);
    this.prune();
  }

  /** Do an event; a delivery's flights are processed then (no longer pending), whatever the delivery found (it may have been cancelled). */
  private exec(it: QItem): void {
    this.now = it.t;
    if (it.gates)
      for (const g of it.gates) {
        const f = this.flightById.get(g);
        if (f && f.due) {
          f.due--;
          f.delivered = true;
        }
      }
    it.fn();
  }

  private prune(): void {
    const keep = this.now - FLIGHT_KEEP;
    let k = 0;
    while (k < this.flights.length && this.flights[k].t1 < keep && this.flights[k].t0 < keep) k++;
    if (k > 200) {
      for (const f of this.flights.splice(0, k)) this.flightById.delete(f.id);
    }
  }

  // ------------------------------------------------------------ senders and causes

  /**
   * The origin of what the engine is handling now: while a received frame
   * is processed, the origin of its message, so that what is sent in
   * reply (an ARP reply, a TCP SYN-ACK or RST, an ICMP error, a protocol's
   * answer) and what is forwarded belongs to the same exchange. null: a
   * device acting on its own (a timer, a start).
   */
  cause: string | null = null;

  /**
   * The devices chosen as senders (null: every device): what is shown is
   * the screen's business (sim-controller.ts). Nothing the network does
   * depends on it — every protocol runs everywhere, and optional traffic
   * is generated where its own settings say (test traffic, applications).
   */
  senders: Set<string> | null = null;

  /**
   * The Send test whose exchange the engine is handling now (its id; null:
   * none): set while a test sends (transport.ts), and while a frame of a
   * test is received, so that what it needs and what answers it (an ARP
   * request, a reply, an ICMP error, a RST, a forwarded copy) belongs to
   * the test too. Timers do not carry it (a periodic timer started then is
   * not the test's); the transport's own timers pass it on themselves.
   */
  testCtx: number | null = null;

  /** Run `fn` as part of a Send test's exchange (id null or undefined: as it is). */
  withTest<T>(id: number | null | undefined, fn: () => T): T {
    if (id === null || id === undefined) return fn();
    const was = this.testCtx;
    this.testCtx = id;
    try {
      return fn();
    } finally {
      this.testCtx = was;
    }
  }

  /** Choose the senders (null: every device), at the current time; logged. They choose what is shown, never what runs or is generated. */
  setSenders(s: Set<string> | null, text: string): void {
    this.senders = s ? new Set(s) : null;
    this.note('note', '', '', '', 'Senders', '', `Senders changed: ${text}`);
  }

  /** A message's sender and origin, when it is first sent or logged. */
  private mark(msg: Msg, dev: string): void {
    if (msg.sender === undefined) msg.sender = dev;
    if (msg.origin === undefined) msg.origin = this.cause !== null ? this.cause : dev;
    if (msg.test === undefined && this.testCtx !== null) msg.test = this.testCtx;
    if (msg.causedBy === undefined && this.causeMsg && this.causeMsg !== msg) msg.causedBy = `${this.causeMsg.label}${this.causeMsg.sender ? ` (sent by ${this.causeMsg.sender})` : ''}, received at t = ${(this.now / 1000).toFixed(6)} s`;
  }

  /** Handle a received frame in the context of its message's origin (and the message itself: what it causes says so). */
  private caused(msg: Msg, fn: () => void, flight?: number): void {
    const was = this.cause;
    const wasMsg = this.causeMsg;
    const wasTest = this.testCtx;
    const wasFlight = this.causeFlight;
    this.cause = msg.origin !== undefined ? msg.origin : null;
    this.causeMsg = msg;
    this.testCtx = msg.test !== undefined ? msg.test : null;
    this.causeFlight = flight !== undefined && flight >= 0 ? flight : null;
    try {
      fn();
    } finally {
      this.causeFlight = wasFlight;
      this.cause = was;
      this.causeMsg = wasMsg;
      this.testCtx = wasTest;
    }
  }

  /** the interfaces ("dev:iface") and ports ("port:…") that were up once: coming up again is said so */
  private cameUp = new Set<string>();

  /** the message whose receipt is being handled (what is sent now answers it or carries it on) */
  private causeMsg: Msg | null = null;

  // ------------------------------------------------------------ waiting for a precondition

  /** what waits for a condition to hold, by condition ("rel:<id>", "route:<dev>|<vrf>|<addr>") */
  private waits = new Map<string, Array<{ key: string; msg: Msg; since: number; why: string; fn: () => void }>>();
  private waitCheck = false;

  /**
   * Hold something (a packet, a session's step) until a condition holds:
   * a relation (tunnel) up ("rel:<id>"), or a route ("route:<dev>|<vrf>|<addr>").
   * Logged once as waiting, with why; released when the condition holds,
   * together with whatever else waited for it. `dedupe` keeps only the
   * newest of a kind (a periodic Hello: the old one would be stale).
   */
  waitFor(cond: string, why: string, dev: string, msg: Msg, fn: () => void, dedupe?: string): void {
    const list = this.waits.get(cond) || [];
    const key = dedupe || 'seq:' + this.seq;
    const i = list.findIndex((x) => x.key === key);
    if (i >= 0) {
      list[i] = { key, msg, since: list[i].since, why, fn };
    } else {
      list.push({ key, msg, since: this.now, why, fn });
      this.note('wait', msg.protocol, dev, '', 'waiting', '', `${msg.label} waiting for ${why}`);
    }
    this.waits.set(cond, list);
  }

  /** Does a condition hold now? */
  private holds(cond: string): boolean {
    if (cond.indexOf('rel:') === 0) {
      const id = cond.slice(4);
      return this.relationUp(id) && (!this.protocols || !this.protocols.sessionUp || this.protocols.sessionUp(id));
    }
    if (cond.indexOf('lease:') === 0) {
      // "lease:<device>" (any interface it would send from) or "lease:<device>:<interface>" (the one chosen); IPv4 traffic's
      const [dev, iface] = cond.slice(6).split(':');
      return iface !== undefined ? this.addressReady(dev, iface) : !this.waitsForLease(dev);
    }
    if (cond.indexOf('ll:') === 0) {
      // "ll:<device>|<interface>": the interface's link-local address valid (duplicate address detection passed)
      const [dev, iface] = cond.slice(3).split('|');
      const sd = this.net.devices.get(dev);
      const l3 = sd ? sd.l3.get(iface) : undefined;
      return !!(l3 && l3.ll);
    }
    if (cond.indexOf('route:') === 0) {
      const [dev, vrf, a] = cond.slice(6).split('|');
      const ip = parseAddress(a);
      if (!ip) return true;
      const d = lookup(this.model, dev, vrf, ip, this.ctx(dev));
      return d.kind === 'forward' || d.kind === 'local';
    }
    return true;
  }

  /** What waited for a condition that holds now goes, in the order it came (at this moment, after what is being handled). */
  recheckWaits(): void {
    if (this.waitCheck || !this.waits.size) return;
    this.waitCheck = true;
    this.at(this.now, () => {
      this.waitCheck = false;
      for (const cond of Array.from(this.waits.keys()).sort(cmp)) {
        if (!this.holds(cond)) continue;
        const list = this.waits.get(cond) as Array<{ key: string; msg: Msg; since: number; why: string; fn: () => void }>;
        this.waits.delete(cond);
        for (const w of list) {
          w.msg.waited = (w.msg.waited || []).concat([`${w.why}: ${durationText(this.now - w.since)}`]);
          w.fn();
        }
      }
    });
  }

  /** How many things wait for a condition (tests, the status). */
  waiting(): Array<{ cond: string; label: string; why: string; since: number; origin?: string }> {
    const out: Array<{ cond: string; label: string; why: string; since: number; origin?: string }> = [];
    for (const [cond, list] of this.waits) for (const w of list) out.push({ cond, label: w.msg.label, why: w.why, since: w.since, origin: w.msg.origin });
    return out;
  }

  // ------------------------------------------------------------ the log

  note(kind: SimEvent['kind'], protocol: string, device: string, peer: string, what: string, state: string, detail: string, t = this.now, msg?: Msg): void {
    const ev: SimEvent = { t, seq: this.logSeq++, kind, protocol, device, peer, what, state, detail };
    if (msg) {
      this.msgEvents.set(msg, ev);
      this.mark(msg, device);
      ev.sender = msg.sender;
      ev.origin = msg.origin;
      if (msg.test !== undefined) ev.test = msg.test;
    } else if (kind === 'message') {
      ev.sender = device;
      ev.origin = this.cause !== null ? this.cause : device;
    }
    if (ev.test === undefined && this.testCtx !== null) ev.test = this.testCtx;
    this.log.push(ev);
    if (this.log.length > LOG_MAX + 500) {
      const n = this.log.length - LOG_MAX;
      this.log.splice(0, n);
      this.logDropped += n;
    }
  }

  /** A log line at a moment still to come (a frame's way is decided when it is sent): written when that moment comes, so the log stays in time order. */
  private noteAt(t: number, kind: SimEvent['kind'], protocol: string, device: string, peer: string, what: string, state: string, detail: string): void {
    if (t <= this.now) this.note(kind, protocol, device, peer, what, state, detail);
    else this.at(t, () => this.note(kind, protocol, device, peer, what, state, detail));
  }

  // ------------------------------------------------------------ what is up

  /** Does a cable carry frames now (physically up and negotiated)? */
  cableUp(id: string): boolean {
    return (this.cable.get(id) || 'up') === 'up';
  }

  /** Is a cable up as its devices see it (both ports have carrier)? */
  linkUp(id: string): boolean {
    const l = this.net.links.get(id);
    if (!l) return true;
    return this.carrier.get(portKey(l.a.device, linkPort(this.model, l, l.a))) !== false && this.carrier.get(portKey(l.b.device, linkPort(this.model, l, l.b))) !== false;
  }

  relationUp(id: string): boolean {
    return !this.failedRels.has(id);
  }

  /** Is a device on (powered and booted)? An inline appliance that failed open is off, but passes frames. */
  deviceOn(dev: string): boolean {
    return !this.off.has(dev);
  }

  /** how many times each device was powered off: what a device scheduled before it went off checks it is still the same run */
  private powerEpochs = new Map<string, number>();

  /** A device's power epoch: it changes when the device is powered off (what it meant to do before is void after a reboot). */
  powerEpoch(dev: string): number {
    return this.powerEpochs.get(dev) || 0;
  }

  /**
   * A device's lifecycle now, from the same state packet processing reads (`off`, `booting`): on
   * (powered and booted), booting (powered on, until its boot time is over; it takes no part yet), off
   * (powered off, down with its host or its container engine, waiting for its host). Null: no lifecycle
   * of its own (an external network, a patch panel or TAP), unless it was powered off all the same, and
   * the simulation's own bridges. Only the device itself counts: a shut interface, a cable down or a
   * peer away leave it on.
   */
  powerState(dev: string): DevicePower | null {
    const sd = this.net.devices.get(dev);
    if (!sd || sd.virt) return null;
    const b = this.booting.get(dev);
    if (b !== undefined) return { state: 'booting', since: this.off.get(dev) as number, until: b };
    if (this.off.has(dev)) {
      const host = this.hostedOff.get(dev);
      const why = host !== undefined ? (this.enginesOff.has(host) ? `stopped with the container engine of ${host}` : this.off.has(host) ? `down with its host ${host}` : `waits for its host ${host}`) : this.bypass.has(dev) ? 'failed open: frames pass unchecked' : undefined;
      return { state: 'off', since: this.off.get(dev) as number, why };
    }
    const md = this.model.index.devices.get(dev);
    const c = md ? capabilities(md) : null;
    if (c && (c.externalTransit || c.passThrough)) return null;
    return { state: 'on' };
  }

  /** the members of an aggregate that LACP does not let distribute yet (or any more), by port key */
  private lagHeld = new Set<string>();

  /** Does an aggregate's member carry traffic: LACP is Collecting / Distributing on it (any other port: yes)? */
  memberReady(dev: string, port: string): boolean {
    return !this.lagHeld.has(portKey(dev, port));
  }

  /**
   * LACP holds a member (it may not distribute: the aggregate waits for it)
   * or lets it go; the aggregate's interface follows (up once enough of its
   * members distribute), and with it what waits for the interface.
   */
  holdMember(dev: string, port: string, held: boolean, quiet = false): void {
    const k = portKey(dev, port);
    if (this.lagHeld.has(k) === held) return;
    if (held) this.lagHeld.add(k);
    else this.lagHeld.delete(k);
    this.stateVersion++;
    if (!quiet) this.syncInterfaces();
  }

  /** Is a port up as its device sees it: carrier on its cable (if any), not shut, its device on. */
  portUp(dev: string, port: string): boolean {
    if (this.off.has(dev) && !this.bypass.has(dev)) return false;
    if (this.shutPorts.has(portKey(dev, port))) return false;
    // an association on a radio ("wlan0~link"): down with its radio
    const tilde = port.indexOf('~');
    if (tilde > 0 && this.shutPorts.has(portKey(dev, port.slice(0, tilde)))) return false;
    return this.carrier.get(portKey(dev, port)) !== false;
  }

  /** Is a layer-3 interface up (see the module comment). */
  l3Up(dev: string, l3: L3Iface): boolean {
    const sd = this.net.devices.get(dev) as SimDevice;
    if (this.off.has(dev)) return false;
    if (this.shutL3.has(dev + ':' + l3.id)) return false;
    if (l3.kind === 'loopback') return true;
    if (l3.kind === 'tunnel') return !!this.protocols && this.protocols.tunnelUp(dev, l3.id);
    if (l3.kind === 'svi') {
      // a VLAN interface is up while a port of its bridge carrying the VLAN is
      for (const bp of sd.bridgePorts.values()) if (carries(bp.vlans, l3.vlan) && bp.members.some((m) => this.portUp(dev, m) && this.net.ends.has(portKey(dev, m)))) return true;
      return false;
    }
    const up = l3.ports.filter((p) => this.portUp(dev, p) && this.memberReady(dev, p)).length;
    if (l3.kind === 'aggregate') {
      const i = this.model.index.interfaces.get(dev + ':' + l3.id);
      return up >= Math.max(1, (i && i.minLinks) || 1);
    }
    return up > 0 || !l3.ports.length;
  }

  /**
   * The routing context of the simulation's state now (a new object when
   * that state changes, so routes are computed again); with a router, the
   * state of that router's last route recomputation.
   */
  ctx(dev?: string): RoutingCtx {
    if (dev !== undefined) {
      const sd = this.net.devices.get(dev);
      if (sd && sd.routes) {
        let c = this.devCtx.get(dev);
        if (!c) {
          c = this.snapshot();
          this.devCtx.set(dev, c);
        }
        return c;
      }
    }
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
      leases: (device: string) => self.leaseConnected(device),
      extraRoutes: (device: string, vrf: string) => self.leaseRoutes(device, vrf),
      dv: (protocol: string) => (self.protocols && self.protocols.dvTables ? self.protocols.dvTables(protocol) : null),
    };
    return this.ctxObj;
  }

  /** The state routing reads, frozen now (a router's view until it recomputes again). */
  private snapshot(): RoutingCtx {
    const live = this.ctx();
    const ifs = new Map(this.l3State);
    const ports = new Map<string, boolean>();
    for (const d of this.net.devices.values()) for (const [p] of d.portOf) ports.set(d.id + '|' + p, this.portUp(d.id, p));
    const links = new Map<string, boolean>();
    for (const id of this.net.links.keys()) links.set(id, this.linkUp(id));
    const rels = new Map<string, boolean>();
    const adj = new Map<string, boolean>();
    for (const r of this.model.relations) {
      rels.set(r.id, (live.relUp as (id: string) => boolean)(r.id));
      const devs = relationDevices(r);
      for (const a of devs) for (const b of devs) if (a !== b) adj.set(r.id + '|' + a + '|' + b, (live.adjUp as (r: string, f: string, t: string) => boolean)(r.id, a, b));
    }
    const self = this;
    // the distance-vector tables as they are now (a frozen copy)
    const dvNow = new Map<string, DvTables>();
    if (this.protocols && this.protocols.dvTables) for (const p of ['rip']) {
      const t = this.protocols.dvTables(p) as (DvTables & { frozen?: () => DvTables }) | null;
      if (t) dvNow.set(p, t.frozen ? t.frozen() : t);
    }
    return {
      dv: (protocol: string) => dvNow.get(protocol) || null,
      up(device: string, iface: string): boolean {
        const k = device + ':' + iface;
        if (ifs.has(k)) return ifs.get(k) !== false;
        const p = ports.get(device + '|' + iface);
        return p !== undefined ? p : self.portUp(device, iface);
      },
      relUp(id: string): boolean {
        const v = rels.get(id);
        return v !== undefined ? v : true;
      },
      linkUp(id: string): boolean {
        const v = links.get(id);
        return v !== undefined ? v : true;
      },
      adjUp(relation: string, from: string, to: string): boolean {
        const v = adj.get(relation + '|' + from + '|' + to);
        return v !== undefined ? v : true;
      },
      leases: (device: string) => this.leaseConnected(device),
      extraRoutes: (device: string, vrf: string) => this.leaseRoutes(device, vrf),
    };
  }

  /**
   * The state analysis reads, frozen now for good (analysis/snapshot.ts):
   * what is up, the adjacencies, the connected networks and default routes
   * the leases and router advertisements added, and the acquired addresses.
   * Unlike snapshot(), nothing of it reads the live simulation later.
   */
  analysisSnapshot(down: string[]): AnalysisSnapshot {
    const base = this.snapshot();
    const conn = new Map<string, Connected[]>();
    const routes = new Map<string, RibEntry[]>();
    for (const d of this.model.devices) {
      const c = this.leaseConnected(d.id);
      if (c.length) conn.set(d.id, c.map((x) => ({ ...x, net: { ...x.net, bytes: x.net.bytes.slice() }, addr: { ...x.addr, bytes: x.addr.bytes.slice() } })));
      for (const vrf of deviceVrfs(this.model, d.id)) {
        const r = this.leaseRoutes(d.id, vrf);
        if (r.length) routes.set(d.id + '\0' + vrf, r.map((x) => ({ ...x })));
      }
    }
    const addresses: SnapAddr[] = [];
    for (const l of this.leases.values()) {
      const s: SnapAddr = { device: l.dev, iface: l.iface, vrf: l.vrf, address: l.addr.text, text: formatAddr(l.addr.addr), version: 4, method: l.kind === 'dhcp' ? 'dhcpv4' : 'link-local', state: 'bound' };
      if (l.server) s.from = formatAddr(l.server);
      if (l.kind === 'dhcp') s.validUntil = l.expires;
      addresses.push(s);
    }
    if (this.v6Hook) addresses.push(...this.v6Hook.addresses());
    const cmpS = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    addresses.sort((a, b) => cmpS(a.device, b.device) || cmpS(a.iface, b.iface) || a.version - b.version || cmpS(a.text, b.text));
    const ctx: RoutingCtx = {
      ...base,
      leases: (device: string) => conn.get(device) || [],
      extraRoutes: (device: string, vrf: string) => routes.get(device + '\0' + vrf) || [],
    };
    // each router's installed routes: what it had learned at its last recomputation (its own interfaces as they are now)
    const per = new Map<string, RoutingCtx>();
    const baseUp = base.up as (d: string, i: string) => boolean;
    for (const [d, c] of Array.from(this.devCtx)) {
      const cu = c.up as (dv: string, i: string) => boolean;
      per.set(d, { ...c, up: (device: string, iface: string) => (device === d ? baseUp(device, iface) : cu(device, iface)), leases: ctx.leases, extraRoutes: ctx.extraRoutes });
    }
    ctx.at = (device: string) => per.get(device);
    const at = this.now;
    const key = `${at}|${this.stateVersion}|${this.routingVersion}|${down.join(',')}`;
    return { at, ctx, addresses, down: down.slice().sort(cmpS), key };
  }

  // ------------------------------------------------------------ DHCP leases (the client's side)

  /** the addresses DHCP leased (or a link-local fallback), by "device:interface": the simulation's, never the model's */
  readonly leases = new Map<string, Lease>();

  /**
   * A lease applies: the interface takes the address (its subnet becomes a
   * connected network, the gateway its default route, the DNS servers its
   * resolver's), routing follows, and what waited for an address goes.
   */
  bindLease(l: Lease): void {
    const sd = this.net.devices.get(l.dev);
    const l3 = sd ? sd.l3.get(l.iface) : undefined;
    if (!sd || !l3) return;
    const had = this.leases.get(l.dev + ':' + l.iface);
    this.leases.set(l.dev + ':' + l.iface, l);
    // (the IPv4 address it leased; its IPv6 addresses stay)
    l3.addrs = l3.addrs.filter((a) => a.addr.version !== 4).concat([l.addr]);
    this.stateVersion++;
    this.routingChanged();
    if (!had || compareAddr(had.addr.addr, l.addr.addr) !== 0) {
      if (this.protocols) this.protocols.ifaceChange(l.dev, l3, this.isL3Up(l.dev, l.iface));
    }
    this.recheckWaits();
  }

  /** A lease ends (expired, released, the interface or device down): the interface has no address again. */
  dropLease(dev: string, iface: string, why: string): void {
    const k = dev + ':' + iface;
    const l = this.leases.get(k);
    if (!l) return;
    this.leases.delete(k);
    const sd = this.net.devices.get(dev);
    const l3 = sd ? sd.l3.get(iface) : undefined;
    if (l3) l3.addrs = l3.addrs.filter((a) => a !== l.addr);
    this.flushIface(dev, iface, why);
    this.stateVersion++;
    this.routingChanged();
  }

  /** Does an interface have its address: a configured one, or (a DHCP client) a lease? */
  addressReady(dev: string, iface: string): boolean {
    const i = this.model.index.interfaces.get(dev + ':' + iface);
    if (!i || !i.dhcp) return true;
    return this.leases.has(dev + ':' + iface);
  }

  /**
   * Is a device waiting for a DHCP lease (a client interface without one, and no IPv4 address elsewhere)?
   * IPv6 traffic (version 6) never waits for one: a lease is IPv4, and an IPv6 address (SLAAC, DHCPv6,
   * written) is no IPv4 address to send from.
   */
  waitsForLease(dev: string, version: 4 | 6 = 4): string | null {
    if (version === 6) return null;
    const sd = this.net.devices.get(dev);
    if (!sd) return null;
    const ls = Array.from(sd.l3.values()).filter((l) => l.kind !== 'loopback');
    if (ls.some((l) => l.addrs.some((a) => a.addr.version === 4))) return null;
    const c = ls.find((l) => !this.addressReady(dev, l.id));
    return c ? c.id : null;
  }

  private leaseConnected(device: string): Connected[] {
    const out: Connected[] = [];
    for (const l of this.leases.values()) {
      if (l.dev !== device) continue;
      out.push({ device, iface: l.iface, vrf: l.vrf, net: { version: l.addr.net.version, bytes: l.addr.net.bytes, prefix: l.addr.net.prefix }, addr: l.addr.addr, address: l.addr.text });
    }
    if (this.v6Hook) out.push(...this.v6Hook.connected(device));
    return out;
  }

  private leaseRoutes(device: string, vrf: string): RibEntry[] {
    const out: RibEntry[] = [];
    for (const l of this.leases.values()) {
      if (l.dev !== device || l.vrf !== vrf || !l.gateway) continue;
      const zero = { version: 4 as const, bytes: [0, 0, 0, 0], prefix: 0 };
      out.push({ kind: 'static', device, vrf, net: zero, distance: 254, metric: 0, iface: l.iface, via: l.gateway, blackhole: false });
    }
    if (this.v6Hook) out.push(...this.v6Hook.routes(device, vrf));
    return out;
  }

  /**
   * What routing depends on changed: routes are computed again, at once for
   * the hosts and the estimates, and by each router after its route
   * recomputation delay (the routers whose recomputation falls on the same
   * moment share it).
   */
  /**
   * Forget the routing contexts made so far (a router's own included): the next question makes them anew from the state
   * then. Used once the sessions are built — what was asked before (the owner of an NTP upstream, by the configured
   * routing) saw no session yet, every adjacency counting as up, and must not become the routers' first tables (a cold
   * start: nothing learned before an adjacency forms).
   */
  forgetRoutingContexts(): void {
    this.ctxObj = null;
    this.devCtx.clear();
    this.viewCtxs.clear();
    this.estimates.clear();
  }

  /** A distance-vector router's table changed (RIP): the routing contexts are made again (the routers recompute by their delay). */
  dynamicChanged(): void {
    this.ctxObj = null;
    this.routingVersion++;
    this.estimates.clear();
  }

  routingChanged(): void {
    this.ctxObj = null;
    this.routingVersion++;
    this.estimates.clear();
    // the routers whose own adjacencies or interfaces changed advertise it (the others learn when that reaches them)
    if (this.protocols && this.protocols.originate) this.protocols.originate();
    // a route or a tunnel may be there now: what waited for it goes
    this.recheckWaits();
    for (const d of Array.from(this.net.devices.values()).sort((a, b) => cmp(a.id, b.id))) {
      if (!d.routes || this.spfPending.has(d.id) || this.off.has(d.id)) continue;
      this.spfPending.add(d.id);
      const r = this.params.get('spf-delay', d.id);
      const t = this.now + Number(r.value);
      this.at(t, () => this.recompute(d.id, t, r));
    }
  }

  /** A router learned something (an advertisement reached it): its routes are recomputed after its route recomputation delay. */
  recomputeSoon(dev: string): void {
    const d = this.net.devices.get(dev);
    if (!d || !d.routes || this.spfPending.has(dev) || this.off.has(dev)) return;
    this.spfPending.add(dev);
    const r = this.params.get('spf-delay', dev);
    const t = this.now + Number(r.value);
    this.at(t, () => this.recompute(dev, t, r));
  }

  /** the routing contexts of learned states, by their signature (routers that learned the same share one) */
  private viewCtxs = new Map<string, RoutingCtx>();

  /**
   * A router's state for its route computation: what is up now on the
   * router itself, and for every other router what its databases say (each
   * instance's record of that origin: its adjacencies of the instance —
   * a relation's adjacency is known only through its own protocol's
   * instance — and its interfaces when it last advertised them, as far as
   * that has reached this router). A protocol's computation reads an
   * origin's interfaces from that protocol's record of the interface's VRF
   * on the origin (OSPF's newer news of an interface never changes what BGP
   * last advertised); a question without a protocol, from the newest record.
   * A router that runs no routing protocol: the state now.
   */
  private viewCtx(dev: string, base: RoutingCtx): RoutingCtx {
    const view = this.protocols && this.protocols.viewOf ? this.protocols.viewOf(dev) : null;
    if (!view) return base;
    const recs = view.slice().sort((a, b) => cmp(a.origin, b.origin) || cmp(a.inst, b.inst));
    const sig = `${this.routingVersion}|${this.protocols && this.protocols.dvVersion ? this.protocols.dvVersion() : 0}|${dev}:${this.l3Sig(dev)}|${recs.map((r) => r.origin + '@' + r.inst + ':' + r.seq).join(',')}`;
    const hit = this.viewCtxs.get(sig);
    if (hit) return hit;
    const adj = new Set<string>();
    // an origin's interfaces: per instance of the origin ("origin|protocol|vrf", the newest copy this router holds), and the newest of all
    const ups = new Map<string, { at: number; seq: number; up: Set<string> }>();
    const newest = new Map<string, { at: number; up: Set<string> }>();
    for (const r of recs) {
      for (const a of r.adj) {
        const i = a.lastIndexOf('|');
        adj.add(`${a.slice(0, i)}|${r.origin}|${a.slice(i + 1)}`);
      }
      if (r.origin === dev) continue;
      const k = r.origin + '|' + r.inst;
      const was = ups.get(k);
      if (!was || r.seq > was.seq) ups.set(k, { at: r.at, seq: r.seq, up: new Set(r.up) });
      const n = newest.get(r.origin);
      if (!n || r.at > n.at) newest.set(r.origin, { at: r.at, up: new Set(r.up) });
    }
    const self = this;
    const ctx: RoutingCtx = {
      ...base,
      // (a relation's adjacency counts when both ends' records say so: the two-way check of a route computation)
      relUp: () => true,
      adjUp: (relation: string, from: string, to: string) => adj.has(`${relation}|${from}|${to}`) && adj.has(`${relation}|${to}|${from}`),
      up(device: string, iface: string, protocol?: string): boolean {
        const sd = self.net.devices.get(device);
        const l = sd ? sd.l3.get(iface) : undefined;
        if (l) {
          // (the origin's VRF of that interface: a name on the origin itself, compared with the origin's own instances only)
          const u = protocol ? ups.get(`${device}|${protocol}|${l.vrf}`) : newest.get(device);
          if (u) return u.up.has(iface);
        }
        return (base.up as (d: string, i: string) => boolean)(device, iface);
      },
    };
    if (this.viewCtxs.size > 256) this.viewCtxs.clear();
    this.viewCtxs.set(sig, ctx);
    return ctx;
  }

  /**
   * A router's own interfaces are never stale in its own tables: one that
   * went down is unusable at once (its connected routes, a next hop out of
   * it), before the route recomputation delay has passed — what the router
   * learned of the others waits for that.
   */
  private ownLive(dev: string, inner: RoutingCtx): RoutingCtx {
    const self = this;
    const innerUp = inner.up as (d: string, i: string, p?: string) => boolean;
    return {
      ...inner,
      up(device: string, iface: string, protocol?: string): boolean {
        if (device !== dev) return innerUp(device, iface, protocol);
        const sd = self.net.devices.get(dev);
        if (sd && sd.l3.has(iface)) return self.l3State.get(dev + ':' + iface) !== false;
        return self.portUp(dev, iface);
      },
    };
  }

  /** a device's interfaces' state now, as a signature */
  private l3Sig(dev: string): string {
    const d = this.net.devices.get(dev);
    return d ? Array.from(d.l3.keys()).map((k) => (this.isL3Up(dev, k) ? '1' : '0')).join('') : '';
  }

  private recompute(dev: string, t: number, r: Resolved): void {
    this.spfPending.delete(dev);
    let at = this.spfAt.get(t);
    if (!at) {
      at = { ctx: this.snapshot(), devs: [] };
      this.spfAt.clear();
      this.spfAt.set(t, at);
      // one line for the routers that recompute at this moment
      const shared = at;
      this.after(0, () => {
        if (shared.devs.length) this.note('route', 'link', shared.devs[0], '', 'routes recomputed', '', `Routes recomputed at ${shared.devs.join(', ')} (route recomputation delay ${formatValue(r.def, r.value)}, ${sourceText(r)})`);
      });
    }
    at.devs.push(dev);
    this.devCtx.set(dev, this.ownLive(dev, this.viewCtx(dev, at.ctx)));
    if (this.protocols && this.protocols.routesChanged) this.protocols.routesChanged(dev);
    // the device's new routes: what waited for a route goes
    this.recheckWaits();
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
        this.note('link', 'link', d.id, '', `${l3.id} ${is ? 'up' : 'down'}`, is ? 'up' : 'down', is ? `Interface ${d.id}:${l3.id} ${this.cameUp.has(key) ? 'is up again' : 'is up: it can send now'}` : `Interface ${d.id}:${l3.id} went down`);
        if (is) this.cameUp.add(key);
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

  /**
   * The spanning tree of a VLAN (cached until a cable goes down or up). A
   * switch whose spanning tree is off blocks none of its ports: a loop
   * stays open when no switch on it runs one (its cables in `loops`).
   */
  tree(vlan: number): Tree {
    let t: Tree | undefined = this.stp.get(vlan);
    if (!t) {
      const st = spanningTree(this.net, vlan, (id) => !this.linkUp(id) || !this.bridging(id), this.stpConfig());
      const tr: Tree = { ...st, loops: [] };
      const freed: string[] = [];
      for (const k of Array.from(tr.blocked).sort(cmp)) {
        if (!this.stpOff(k.slice(0, k.indexOf('|')))) continue;
        tr.blocked.delete(k);
        freed.push(k);
      }
      for (const k of freed) {
        const dev = k.slice(0, k.indexOf('|'));
        const sd = this.net.devices.get(dev) as SimDevice;
        const bp = sd.bridgePorts.get(k.slice(k.indexOf('|') + 1));
        if (!bp) continue;
        for (const m of bp.members) {
          const e = this.net.ends.get(portKey(dev, m));
          if (!e) continue;
          const o = otherEnd(this.net, e);
          const od = this.net.devices.get(o.device);
          const obp = od && od.bridge ? od.portOf.get(o.port) : undefined;
          if (obp !== undefined && !tr.blocked.has(portKey(o.device, obp)) && tr.loops.indexOf(e.link) < 0) tr.loops.push(e.link);
        }
      }
      tr.loops.sort(cmp);
      t = tr;
      this.stp.set(vlan, t);
      // root guard: a guarded port with a better root behind it is blocked — said once, whenever the tree is computed with it
      for (const k of Array.from(tr.inconsistent).sort(cmp)) {
        const nk = vlan + '|' + k;
        if (this.rootGuardNoted.has(nk)) continue;
        this.rootGuardNoted.add(nk);
        const cut = k.indexOf('|');
        const gDev = k.slice(0, cut);
        this.note('link', 'stp', gDev, '', 'Root guard', 'blocked', `${gDev}:${k.slice(cut + 1)} is root-inconsistent in ${vlan ? 'VLAN ' + vlan : 'the untagged frames'}: a better root bridge lies behind it, and root guard blocks the port`);
      }
      for (const nk of Array.from(this.rootGuardNoted)) if (nk.indexOf(vlan + '|') === 0 && !tr.inconsistent.has(nk.slice(nk.indexOf('|') + 1))) this.rootGuardNoted.delete(nk);
    }
    return t;
  }

  /** guarded ports noted root-inconsistent ("vlan|dev|port") */
  private rootGuardNoted = new Set<string>();

  /**
   * What the spanning tree reads of the switches and their ports: the
   * bridge priority (per VLAN with MSTP or PVST), each port's path cost (by
   * its speed unless set: 20 Tbit/s ÷ speed, IEEE 802.1D-2004 Table 17-3),
   * port priority, whether it takes part, root guard.
   */
  private stpConfig(): StpConfig {
    return {
      priority: (dev, vlan) => {
        const base = this.params.num('bridge-priority', dev);
        const mode = this.params.str('stp-mode', dev);
        if (mode !== 'mstp' && mode !== 'pvst') return base;
        const v = vlanValue(this.params.str('bridge-priority-vlans', dev), vlan || 1);
        return v !== undefined ? v : base;
      },
      cost: (dev, bp) => {
        const own = this.params.num('stp-cost', dev, null, ifaceRef(dev, bp));
        if (own > 0) return own;
        return Math.max(1, Math.round(20e12 / this.portSpeed(dev, bp)));
      },
      portPriority: (dev, bp) => this.params.num('stp-port-priority', dev, null, ifaceRef(dev, bp)),
      enabled: (dev, bp) => this.params.str('stp-port', dev, ifaceRef(dev, bp)) === 'on',
      rootGuard: (dev, bp) => this.params.str('stp-root-guard', dev, ifaceRef(dev, bp)) === 'on',
    };
  }

  /** A bridge port's speed (bit/s): its cable's, an aggregate's the sum of its members' that are up. */
  private portSpeed(dev: string, bp: string): number {
    const sd = this.net.devices.get(dev) as SimDevice;
    const b = sd.bridgePorts.get(bp);
    let sum = 0;
    for (const m of b ? b.members : [bp]) {
      const e = this.net.ends.get(portKey(dev, m));
      if (e && this.linkUp(e.link)) sum += Number(this.speed(e.link).value);
    }
    return sum || Number(this.params.get('default-speed').value);
  }

  /**
   * A switch's port came up: what its spanning tree settings do. With BPDU
   * guard, a BPDU from a bridge on the far end shuts it down (err-disabled,
   * until it is restored with No shut); an edge port that hears a bridge is
   * no edge port. A port to a host with STP (802.1D) listens and learns for
   * 2 × forward delay, unless it is an edge port (PortFast); the rapid
   * modes let it forward at once (as auto-edge does).
   */
  private stpPortUp(dev: string, port: string, link: string): void {
    const sd = this.net.devices.get(dev);
    if (!sd || !sd.bridge || !sd.caps.switchFeatures) return;
    const bp = sd.portOf.get(port);
    if (bp === undefined || this.stpOff(dev)) return;
    const at = ifaceRef(dev, bp);
    if (this.params.str('stp-port', dev, at) !== 'on') return;
    const o = otherEnd(this.net, this.net.ends.get(portKey(dev, port)) as CableEnd);
    const od = this.net.devices.get(o.device);
    const obp = od && od.bridge ? od.portOf.get(o.port) : undefined;
    const bridge = !!od && od.caps.switchFeatures && obp !== undefined && !this.stpOff(od.id) && this.params.str('stp-port', od.id, ifaceRef(od.id, obp)) === 'on';
    const edge = this.params.get('stp-edge', dev, null, at);
    if (bridge) {
      // its first BPDU arrives with the far end's first hello
      const guard = this.params.get('stp-bpdu-guard', dev, null, at);
      if (guard.value === 'on') {
        this.at(this.now + this.jitter(dev), () => {
          if (!this.linkUp(link) || this.shutPorts.has(portKey(dev, port))) return;
          this.note('link', 'stp', dev, o.device, 'BPDU guard', 'err-disabled', `BPDU guard on ${dev}:${bp} (${resolvedText(guard)}): a BPDU from ${o.device}:${o.port}, a bridge where a host was expected; the port is err-disabled (shut down) until No shut`);
          this.shut(dev, port);
        });
      } else if (edge.value === 'on') this.note('link', 'stp', dev, o.device, 'Edge port', '', `${dev}:${bp} is configured as an edge port (${resolvedText(edge)}) but hears BPDUs from ${o.device}: it takes part in the spanning tree as a normal port`);
      return;
    }
    if (this.params.str('stp-mode', dev) !== 'stp' || edge.value === 'on') return;
    // a host port with STP (802.1D): listening, then learning, then forwarding
    const fd = this.params.num('stp-forward-delay', dev);
    const b = sd.bridgePorts.get(bp) as BridgePort;
    const until = this.now + 2 * fd;
    // (the untagged frames too: 0)
    for (const v of Array.from(new Set([0].concat(this.net.vlans)))) {
      if (!carries(b.vlans, v)) continue;
      const key = dev + '|' + bp + '|' + v;
      this.fwdAt.set(key, until);
      this.at(until, () => {
        if (this.fwdAt.get(key) !== until) return;
        this.fwdAt.delete(key);
      });
    }
    this.note('link', 'stp', dev, o.device, 'Listening', 'listening', `${dev}:${bp} (to ${o.device}) listens and learns for 2 × forward delay ${durationText(fd)} (STP; edge port ${resolvedText(edge)}): it forwards at t = ${fmtSec(until)}`);
    this.at(until, () => this.note('link', 'stp', dev, '', 'Port forwarding', 'forwarding', `${dev}:${bp} is forwarding (listening and learning are over)`));
  }

  /** Does a switch run no spanning tree (its spanning tree mode is off)? */
  stpOff(dev: string): boolean {
    const sd = this.net.devices.get(dev);
    return !!sd && sd.caps.switchFeatures && this.params.str('stp-mode', dev) === 'off';
  }

  /**
   * A frame came back to a bridge it passed: a Layer 2 loop no spanning
   * tree blocks (else nothing: it is not followed twice). A broadcast
   * storm in its VLAN: the frame goes round again (followed for
   * STORM_ROUNDS rounds; a real one circulates until the loop is broken),
   * unless the port's storm control drops it (a loop forwards at line rate,
   * above any threshold).
   */
  private loopsBack(sd: SimDevice, port: string, vlan: number, frame: Frame, t: number): boolean {
    const tr = this.tree(vlan);
    if (!tr.loops.length) return false;
    const where = vlan ? 'VLAN ' + vlan : 'the untagged frames';
    let st = this.storms.get(vlan);
    if (!st) {
      st = { since: t, links: tr.loops.slice(), frames: 0 };
      this.storms.set(vlan, st);
      this.stateVersion++;
      this.at(t, () => this.note('link', 'stp', sd.id, '', 'Broadcast storm', 'storm', `Broadcast storm in ${where}: ${frame.msg.label} came back to ${sd.id} over a loop that no spanning tree blocks (it closes over cable ${tr.loops.join(', ')}); flooded frames circulate and multiply, and MAC addresses move between ports`));
    }
    st.frames++;
    const cast = castOf(frame.dst);
    if (cast !== 'unicast') {
      // the threshold of the bridge port it came in on (an aggregate's, or the port's own)
      const r = this.params.get(cast === 'multicast' ? 'storm-mc' : 'storm-bc', sd.id, null, ifaceRef(sd.id, sd.portOf.get(port) || port));
      if (Number(r.value) > 0) {
        const k = `sc|${sd.id}|${port}`;
        if (!this.stormNoted.has(k) || t - (this.stormNoted.get(k) as number) >= 1000) {
          this.stormNoted.set(k, t);
          this.at(t, () => this.note('drop', 'stp', sd.id, '', 'storm control', '', `Storm control on ${sd.id}:${port} drops the looping ${cast} frames (${frame.msg.label}): a loop forwards them at line rate, far above its threshold of ${formatValue(r.def, r.value)} frames/s (${sourceText(r)})`));
        }
        return false;
      }
    }
    if ((frame.loops || 0) + 1 > STORM_ROUNDS) {
      const k = `rounds|${vlan}`;
      if (!this.stormNoted.has(k) || t - (this.stormNoted.get(k) as number) >= 1000) {
        this.stormNoted.set(k, t);
        this.at(t, () => this.note('note', 'stp', sd.id, '', 'storm', 'storm', `${frame.msg.label} has gone round the loop in ${where} ${STORM_ROUNDS} times: the simulation stops following it (in a real network it circulates until the loop is broken, filling the links)`));
      }
      return false;
    }
    return true;
  }

  /** The storms that are over: their loop is broken (a cable down, spanning tree on). */
  private endStorms(): void {
    for (const vlan of Array.from(this.storms.keys()).sort((a, b) => a - b)) {
      if (this.tree(vlan).loops.length) continue;
      this.storms.delete(vlan);
      this.stateVersion++;
      this.note('link', 'stp', '', '', 'Storm over', 'up', `The broadcast storm in ${vlan ? 'VLAN ' + vlan : 'the untagged frames'} is over: its loop is broken`);
    }
  }

  /** Do both ends of a cable bridge now (a switch powered off takes no part in the tree)? */
  private bridging(link: string): boolean {
    const l = this.net.links.get(link);
    return !l || ((!this.off.has(l.a.device) || this.bypass.has(l.a.device)) && (!this.off.has(l.b.device) || this.bypass.has(l.b.device)));
  }

  /** Is a bridge port blocked for a VLAN: by the spanning tree, or still converging towards forwarding? */
  blocked(dev: string, bp: string, vlan: number): boolean {
    if (this.tree(vlan).blocked.has(portKey(dev, bp))) return true;
    const f = this.fwdAt.get(dev + '|' + bp + '|' + vlan);
    return f !== undefined && this.now < f;
  }

  /**
   * How long a port of a switch takes to forward after a change of the tree:
   * `direct` when the switch is at the cable that changed.
   */
  private convergence(dev: string, bp: string, direct: boolean): { ms: number; why: string } {
    const mode = this.params.str('stp-mode', dev);
    const hello = this.params.num('stp-hello', dev);
    const fd = this.params.num('stp-forward-delay', dev);
    const age = this.params.num('stp-max-age', dev);
    const rapid = mode === 'rstp' ? 'RSTP' : mode === 'mstp' ? 'MSTP' : 'Rapid PVST+';
    if (mode === 'off') return { ms: 0, why: 'no spanning tree' };
    if (mode === 'stp') return direct ? { ms: 2 * fd, why: `STP: listening and learning, 2 × forward delay ${durationText(fd)}` } : { ms: age + 2 * fd, why: `STP: max age ${durationText(age)} + 2 × forward delay ${durationText(fd)}` };
    // a shared link (a hub) has no proposal and agreement: it waits like STP
    if (this.params.str('stp-link-type', dev, ifaceRef(dev, bp)) === 'shared') return { ms: 2 * fd, why: `${rapid} on a shared link: listening and learning, 2 × forward delay ${durationText(fd)}` };
    return direct ? { ms: 0, why: `${rapid}: the alternate port takes over at once` } : { ms: 3 * hello, why: `${rapid}: 3 × hello ${durationText(hello)} before the old information ages out` };
  }

  /**
   * The spanning trees again (a cable went down or up, a switch was powered
   * off or on); the MAC tables of the VLANs whose tree changed are flushed
   * and the ports that start forwarding wait for their convergence.
   */
  private recomputeTrees(changed: string[] = []): void {
    const old = this.stp;
    this.stp = new Map();
    const at = new Set<string>();
    for (const id of changed) {
      const l = this.net.links.get(id);
      if (l) at.add(l.a.device).add(l.b.device);
    }
    for (const [vlan, t] of old) {
      const n = this.tree(vlan);
      const same = n.root === t.root && n.blocked.size === t.blocked.size && n.ports.size === t.ports.size && Array.from(n.blocked).every((k) => t.blocked.has(k)) && Array.from(n.ports).every((k) => t.ports.has(k));
      if (same) continue;
      // ports forwarding now that did not before (blocked, or on a cable that was down)
      const opened = Array.from(n.ports).filter((k) => !n.blocked.has(k) && (t.blocked.has(k) || !t.ports.has(k))).sort(cmp);
      const waits: string[] = [];
      for (const k of opened) {
        const [dev, bp] = k.split('|');
        const c = this.convergence(dev, bp, at.has(dev));
        if (c.ms <= 0) continue;
        const key = dev + '|' + bp + '|' + vlan;
        this.fwdAt.set(key, this.now + c.ms);
        waits.push(`${dev}:${bp} forwards at t = ${fmtSec(this.now + c.ms)} (${c.why})`);
        this.at(this.now + c.ms, () => {
          if (this.fwdAt.get(key) === undefined || this.now < (this.fwdAt.get(key) as number)) return;
          this.fwdAt.delete(key);
          this.note('link', 'stp', dev, '', 'Port forwarding', 'forwarding', `${dev}:${bp} is forwarding in ${vlan ? 'VLAN ' + vlan : 'the untagged frames'} (the spanning tree converged)`);
        });
      }
      this.note('link', 'stp', n.root || '', '', 'Topology change', '', `The spanning tree of ${vlan ? 'VLAN ' + vlan : 'the untagged frames'} changed${opened.length ? ': ' + opened.map(portRefOf).join(', ') + ' forwarding' : ''}; the MAC tables of the VLAN are flushed${waits.length ? '. ' + waits.join('; ') : ''}`);
      for (const tab of this.macs.values()) {
        for (const [k, e] of Array.from(tab)) if (e.type === 'dynamic' && e.vlan === vlan) tab.delete(k);
      }
    }
    this.endStorms();
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
    if (e) this.noteAt(t, 'table', 'stp', d.id, '', 'MAC moved', '', `${mac} (VLAN ${vlan || 'untagged'}) moved from port ${e.port} to ${port}`);
    else {
      // a full table learns nothing new: frames to the address are flooded
      const size = this.params.num('mac-table-size', d.id);
      if (tab.size >= size) {
        if (!this.macFullNoted.has(d.id)) {
          this.macFullNoted.add(d.id);
          this.noteAt(t, 'table', 'stp', d.id, '', 'MAC table full', '', `${d.id} MAC table is full (${size} entries, ${sourceText(this.params.get('mac-table-size', d.id))}): ${mac} is not learned; frames to it are flooded`);
        }
        return;
      }
    }
    tab.set(k, { mac, vlan, port, type: 'dynamic', learned: t, refreshed: t });
  }

  /** The MAC aging time of a switch (ms of simulated time, scaled). */
  macAging(dev: string): number {
    return this.params.num('mac-aging', dev) / this.timerScale;
  }

  // ------------------------------------------------------------ layer 2: sending and forwarding frames

  /** the emission being planned: its sender and time (for the logical view's dots of messages without a relation) */
  private emitting: { dev: string; l3: L3Iface; t: number; net: string | null; first: number | null } | null = null;

  /** Send a frame from a layer-3 interface (at now). */
  emit(dev: string, l3: L3Iface, frame: Frame, t = this.now): void {
    this.mark(frame.msg, dev);
    const was = this.emitting;
    const net = frame.msg.relation ? null : this.networkOf(l3, frame);
    this.emitting = { dev, l3, t, net, first: null };
    // the logical view: a message without a relation goes from its sender to its network now (on to each receiver when it arrives there)
    if (net && this.emitting) this.emitting.first = this.flight(t, t + this.hopTime() / 2, frame.msg, 'logical', { ref: 'network:' + net, from: dev, to: 'net' }, undefined, frameEncap(frame)).id;
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
    // a device that is off sends nothing (its timers stop with it; this is the safety net)
    if (this.off.has(dev)) return;
    if (!this.isL3Up(dev, l3.id)) {
      this.noteAt(t, 'drop', frame.msg.protocol, dev, '', frame.msg.type, '', `not sent: ${dev}:${l3.id} is down (${frame.msg.label})`);
      return;
    }
    if (l3.kind === 'svi') {
      this.bridge(sd, null, l3.vlan, frame, t, undefined, new Set([dev]));
      return;
    }
    const ports = l3.ports.filter((p) => this.portUp(dev, p) && this.memberReady(dev, p) && this.cabledOrBoundary(dev, p));
    if (!ports.length) return;
    const port = ports.length === 1 ? ports[0] : ports[hashIndex(frame.src + frame.dst + (frame.ip ? frame.ip.flow : ''), ports.length)];
    // a subinterface's frames carry its VLAN's 802.1Q tag on its port (a routed port: its own frames are untagged)
    const tag: number | null = l3.kind === 'subif' && l3.vlan ? l3.vlan : null;
    this.transmit(dev, port, frame, tag, t, undefined, new Set([dev]));
  }

  // ------------------------------------------------------------ layer 1: latency, speed, loss

  /** A cable's value of a Layer 1 parameter: configured on the cable, else the larger of its two devices' own, else the simulation's. */
  private cableParam(link: string, key: 'link-latency' | 'loss', configured?: number): Resolved {
    const l = this.net.links.get(link) as Link;
    if (configured !== undefined) return this.params.get(key, undefined, { value: configured, where: 'cable ' + link });
    let best: Resolved | null = null;
    for (const d of [l.a.device, l.b.device]) {
      const r = this.params.get(key, d);
      if (r.source === 'device' && (!best || Number(r.value) > Number(best.value))) best = r;
    }
    return best || this.params.get(key);
  }

  /** The propagation delay of a cable (ms) and where it comes from. */
  latency(link: string): Resolved {
    const l = this.net.links.get(link) as Link;
    return this.cableParam(link, 'link-latency', l.simulation ? l.simulation.latency : undefined);
  }

  /** The packet loss of a cable (percent). */
  loss(link: string): Resolved {
    const l = this.net.links.get(link) as Link;
    return this.cableParam(link, 'loss', l.simulation ? l.simulation.loss : undefined);
  }

  /** A cable's speed (bit/s): the link's own, else an end's, else the simulation's default speed. */
  speed(link: string): Resolved {
    const l = this.net.links.get(link) as Link;
    const own = parseSpeed(l.speed) || parseSpeed(l.a.speed) || parseSpeed(l.b.speed);
    return this.params.get('default-speed', undefined, own ? { value: own, where: 'cable ' + link } : null);
  }

  /** A frame's size on the wire (bytes): Ethernet header and FCS, the IP headers of every encapsulation, the payload (at least 64). */
  frameBytes(frame: Frame): number {
    if (frame.arp) return 64;
    if (!frame.ip) return Math.max(64, 18 + (frame.nd ? 32 : PAYLOAD));
    return Math.max(64, 18 + ipLen(frame.ip));
  }

  /**
   * A frame onto a cable in one direction at t: it starts when the frame
   * before it has been sent (one at a time), is on the wire for its
   * serialization time and arrives a propagation delay later.
   */
  private wire(link: string, end: 'a' | 'b', frame: Frame, t: number): { start: number; end: number; lost: boolean; dup: boolean; impaired: boolean } {
    const key = link + '>' + end;
    const free = this.cableFree.get(key) || 0;
    const start = Math.max(t, free);
    const ser = (this.frameBytes(frame) * 8 * 1000) / Number(this.speed(link).value);
    this.cableFree.set(key, start + ser);
    const loss = Number(this.loss(link).value);
    const lost = loss > 0 && this.stream('loss', link)() * 100 < loss;
    const imp = this.impair ? this.impair(link, frame) : null;
    return { start, end: start + ser + Number(this.latency(link).value) + (imp && imp.delay ? imp.delay : 0), lost: lost || !!(imp && imp.lose), dup: !!(imp && imp.dup), impaired: !!(imp && imp.lose) && !lost };
  }

  /**
   * A test's impairment of one frame on a cable (never set by the
   * application): lose it, deliver it twice, or delay it (so that what was
   * sent after it overtakes it). Null: none.
   */
  impair: ((link: string, frame: Frame) => { lose?: boolean; dup?: boolean; delay?: number } | null) | null = null;

  /**
   * A small seeded jitter (ms) for a start or a periodic message: less than
   * a typical hop's time, as real protocols jitter their timers, so that
   * what starts together runs together (on screen too) without being drawn
   * on top of each other.
   */
  jitter(scope = ''): number {
    return this.stream('jitter', scope)() * JITTER_SHARE * this.hopTime();
  }

  /** A seeded number in [0, 1) of an object's own stream (a device's, a cable's): the same model, the same numbers for it, whatever else it holds. */
  random(scope = ''): number {
    return this.stream('random', scope)();
  }

  private stream(kind: string, scope: string): () => number {
    const k = kind + '|' + scope;
    let r = this.streams.get(k);
    if (!r) this.streams.set(k, (r = rng(`${modelSeed(this.model)}|${kind}|${scope}`)));
    return r;
  }

  /**
   * A fresh start (Layer 1): every cable negotiates; its ports come up
   * after its link-up delay (and a small jitter), so that an interface sends
   * nothing before its link is up. The interfaces that wait for a cable are
   * down until then (silently: nothing went down, they are coming up).
   */
  boot(): void {
    for (const l of Array.from(this.net.links.values()).sort((a, b) => cmp(a.id, b.id))) {
      if (!this.physUp(l.id)) {
        // a parked link (an HA standby's): down, without a word
        if (this.parked.has(l.id)) {
          this.cable.set(l.id, 'down');
          for (const e of [l.a, l.b]) if (this.net.ends.has(portKey(e.device, linkPort(this.model, l, e)))) this.carrier.set(portKey(e.device, linkPort(this.model, l, e)), false);
        }
        continue;
      }
      const id = l.id;
      const ends = [l.a, l.b].map((e) => ({ dev: e.device, port: linkPort(this.model, l, e), key: portKey(e.device, linkPort(this.model, l, e)) }));
      this.cable.set(id, 'negotiating');
      for (const x of ends) this.carrier.set(x.key, false);
      const d = this.linkUpDelay(id);
      const tok = ++this.tokens;
      this.carrierToken.set('link:' + id, tok);
      this.at(Number(d.value) + this.jitter('link:' + id), () => {
        if (this.carrierToken.get('link:' + id) !== tok) return;
        this.carrierToken.delete('link:' + id);
        if (!this.physUp(id)) return;
        this.cable.set(id, 'up');
        this.stateVersion++;
        for (const x of ends) if (this.carrier.get(x.key) === false && !this.off.has(x.dev)) this.setCarrier(x.dev, x.port, true, id, d);
      });
    }
    this.stp.clear();
    for (const dv of this.net.devices.values())
      for (const l3 of dv.l3.values()) {
        const up = this.l3Up(dv.id, l3);
        this.l3State.set(dv.id + ':' + l3.id, up);
        if (up) this.cameUp.add(dv.id + ':' + l3.id);
      }
    this.stateVersion++;
  }

  /** About how long a frame takes over one cable (ms): the simulation's latency and a small frame at its default speed. */
  hopTime(): number {
    return this.params.num('link-latency') + (PAYLOAD * 8 * 1000) / this.params.num('default-speed');
  }

  /** A frame a switch floods in a VLAN itself (a snooping querier's query), as from its own VLAN interface. */
  floodFrom(dev: string, vlan: number, frame: Frame): void {
    const sd = this.net.devices.get(dev);
    if (!sd || !sd.bridge || this.off.has(dev)) return;
    this.mark(frame.msg, dev);
    const was = this.emitting;
    this.emitting = null;
    try {
      this.bridge(sd, null, vlan, frame, this.now, undefined, new Set([dev]));
    } finally {
      this.emitting = was;
    }
  }

  /** A link-local layer-2 PDU out of one port (LACP, LLDP, STP): it reaches the device at the other end only. */
  sendOnPort(dev: string, port: string, frame: Frame): void {
    if (this.off.has(dev) || !this.portUp(dev, port)) return;
    this.mark(frame.msg, dev);
    const was = this.emitting;
    this.emitting = null;
    try {
      this.transmit(dev, port, frame, null, this.now, undefined, new Set([dev]));
    } finally {
      this.emitting = was;
    }
  }

  /** A frame onto a cable from a port: it arrives after its serialization and the cable's latency (one frame per cable and direction at a time). */
  /** A port with a cable, or one at an execution scope's boundary (its cable leads out of the scope: transmit says so). */
  private cabledOrBoundary(dev: string, port: string): boolean {
    return this.net.ends.has(portKey(dev, port)) || (!!this.model.execScope && this.model.execScope.boundary.has(dev + ':' + port));
  }

  private transmit(dev: string, port: string, frame: Frame, tag: number | null, t: number, parent: number | undefined, seen: Set<string>): void {
    const e = this.net.ends.get(portKey(dev, port));
    if (!e) {
      // the boundary of an execution scope: the cable leads to a device this simulation does not run (said, never answered)
      const out = this.model.execScope ? this.model.execScope.boundary.get(dev + ':' + port) : undefined;
      const k = `scope|${dev}|${port}|${frame.msg.protocol}`;
      if (out !== undefined && (!this.stormNoted.has(k) || t - (this.stormNoted.get(k) as number) >= 10000)) {
        this.stormNoted.set(k, t);
        this.noteAt(t, 'drop', frame.msg.protocol, dev, out, frame.msg.type, '', `${frame.msg.label} leaves the execution scope at ${dev}:${port}: ${out} is outside it (${this.model.execScope ? this.model.execScope.label : ''}) and is not run, so nothing answers from there`);
      }
      return;
    }
    const l = this.net.links.get(e.link) as Link;
    if (l.direction === 'unidirectional' && e.end === 'b') return;
    if (l.medium === 'wireless') {
      const at = this.wireless(e.link, dev, frame, t);
      if (at === null) return;
      t = at;
      frame = this.toUnicast(e.link, dev, frame, t);
    }
    const w = this.wire(e.link, e.end, frame, t);
    if (this.ptpHook && frame.msg.protocol === 'ptp') frame = this.ptpHook.egress(dev, port, frame, t, w.start);
    const o = otherEnd(this.net, e);
    const f = this.flight(w.start, w.end, frame.msg, 'physical', { ref: 'link:' + e.link, from: e.end, to: o.end }, parent, frameEncap(frame));
    this.inspectable(f, frame, tag);
    if (frame.ip && frame.ip.frag) f.label += ` (fragment ${frame.ip.frag.i}/${frame.ip.frag.n})`;
    if (!this.cableUp(e.link)) {
      f.dropped = (w.start + w.end) / 2;
      f.t1 = f.dropped;
      this.noteAt(w.start, 'drop', frame.msg.protocol, dev, o.device, frame.msg.type, '', `dropped on ${e.link}: the cable is ${this.cable.get(e.link) === 'negotiating' ? 'still coming up' : 'down'}${this.linkUp(e.link) ? ' (its ports have not noticed yet: loss-of-signal detection)' : ''} (${frame.msg.label})`);
      return;
    }
    if (w.lost) {
      f.dropped = (w.start + w.end) / 2;
      f.t1 = f.dropped;
      const r = this.loss(e.link);
      this.noteAt(w.start, 'drop', frame.msg.protocol, dev, o.device, frame.msg.type, '', `lost on ${e.link} (${w.impaired ? 'an impairment of the test' : 'packet loss ' + resolvedText(r)}): ${frame.msg.label}`);
      return;
    }
    // it arrives when it arrives: the next device decides then, with its state then (a port shut, a spanning tree
    // changed, the device off, its MAC table aged meanwhile) — never in advance at the moment the frame was sent
    // (in the context it was sent in: its emission, its cause, its Send test — as if it had all happened at once)
    const ctx = { em: this.emitting, cause: this.cause, causeMsg: this.causeMsg, test: this.testCtx, flight: this.causeFlight };
    const go = (at: number): void => {
      this.at(at, () => {
        if (f.dropped !== undefined || f.hidden) return;
        const was = { em: this.emitting, cause: this.cause, causeMsg: this.causeMsg, test: this.testCtx, flight: this.causeFlight };
        this.emitting = ctx.em;
        this.cause = ctx.cause;
        this.causeMsg = ctx.causeMsg;
        this.testCtx = ctx.test;
        this.causeFlight = ctx.flight;
        try {
          this.arrive(o.device, o.port, frame, tag, at, f.id, seen);
        } finally {
          this.emitting = was.em;
          this.cause = was.cause;
          this.causeMsg = was.causeMsg;
          this.testCtx = was.test;
          this.causeFlight = was.flight;
        }
      }, [f.id]);
    };
    go(w.end);
    if (w.dup) go(w.end + 0.001);
  }

  /** A flight's shape (unicast, broadcast, multicast) and the frame's headers for the inspector; the message's log line gets them too (as first sent). */
  private inspectable(f: Flight, frame: Frame, tag: number | null): void {
    f.encapProtocols = encapProtocols(frame);
    f.cast = castOf(frame.dst);
    f.hdr = this.headers(frame, tag);
    // why now: what caused it and what it waited for (the innermost message's, for an encapsulated one)
    let m = frame.msg;
    for (let p = frame.ip; p && p.inner; p = p.inner) m = p.inner.msg;
    const by = frame.msg.causedBy || m.causedBy;
    // (an encapsulating message copies its inner one's: each once)
    const waited = Array.from(new Set((m !== frame.msg ? m.waited || [] : []).concat(frame.msg.waited || [])));
    if (by) f.hdr.causedBy = by;
    if (waited.length) f.hdr.waited = waited;
    const ev = this.msgEvents.get(frame.msg);
    if (ev && !ev.hdr) ev.hdr = f.hdr;
    // the logical view's dots of the message (no frame of their own): the headers it was sent with, for their inspector
    const waiting = this.logicalNoHdr.get(frame.msg);
    if (waiting) {
      this.logicalNoHdr.delete(frame.msg);
      for (const x of waiting) if (!x.hdr) x.hdr = f.hdr;
    }
  }

  /** the logical view's dots of a message, until its first frame's headers are known */
  private logicalNoHdr = new WeakMap<Msg, Flight[]>();
  /** the logical view's dots of a message along its relation, to each device (what holds its delivery there on screen) */
  private lanes = new WeakMap<Msg, Flight[]>();

  /**
   * A frame on a wireless link: a client silent for its access point's idle
   * timeout was disassociated; its next frame waits for the next beacon and
   * the association first, and the access point's frames to it are dropped
   * meanwhile (null). Returns when the frame goes.
   */
  private wireless(link: string, dev: string, frame: Frame, t: number): number | null {
    const l = this.net.links.get(link) as Link;
    const ap = [l.a.device, l.b.device].find((d) => capabilities(this.model.index.devices.get(d) || { type: '' }).wirelessAccess);
    if (!ap) return t;
    const client = l.a.device === ap ? l.b.device : l.a.device;
    const idle = this.params.get('ap-idle', ap);
    const last = this.wifiActive.has(link) ? (this.wifiActive.get(link) as number) : 0;
    const gone = t - last > Number(idle.value);
    if (dev === client) {
      if (!gone) {
        this.wifiActive.set(link, Math.max(last, t));
        return t;
      }
      const assoc = this.params.get('ap-association', ap);
      const wait = this.beaconWait(ap, t, (l.a.device === ap ? l.a : l.b).iface || '@' + link);
      const at = t + wait + Number(assoc.value);
      this.wifiActive.set(link, at);
      this.noteAt(t, 'link', 'link', client, ap, 'Associates again', 'up', `${client} was disassociated by ${ap} at t = ${fmtSec(last + Number(idle.value))} (client idle timeout ${resolvedText(idle)}): to send ${frame.msg.label} it waits for the next beacon (${wait > 0 ? 'in ' + durationText(wait) : 'at once'}) and associates again (${resolvedText(assoc)}), up at t = ${fmtSec(at)}`);
      return at;
    }
    if (!gone) return t;
    const k = 'idle|' + link;
    if (this.stormNoted.get(k) !== last) {
      this.stormNoted.set(k, last);
      this.noteAt(t, 'drop', frame.msg.protocol, ap, client, frame.msg.type, '', `${ap} drops ${frame.msg.label} for ${client}: it is not associated (silent since t = ${fmtSec(last)}, client idle timeout ${resolvedText(idle)}); later frames to it are dropped as well until it sends again`);
    }
    return null;
  }

  /** An access point with multicast-to-unicast on sends a group frame to its wireless client as a unicast frame. */
  private toUnicast(link: string, dev: string, frame: Frame, t: number): Frame {
    if (!frame.ip || !isMulticastIp(frame.ip.dst) || isLinkLocalGroup(frame.ip.dst)) return frame;
    const sd = this.net.devices.get(dev);
    if (!sd || !sd.caps.wirelessAccess) return frame;
    const l = this.net.links.get(link) as Link;
    const me = l.a.device === dev ? l.a : l.b;
    const radio = ifaceRef(dev, me.iface || '@' + link);
    if (this.params.str('mc-to-unicast', dev, radio) !== 'on') return frame;
    const c = l.a.device === dev ? l.b : l.a;
    const cd = this.net.devices.get(c.device);
    const port = c.iface || '@' + link;
    const cl = cd ? Array.from(cd.l3.values()).find((x) => x.ports.indexOf(port) >= 0) : undefined;
    if (!cl) return frame;
    const k = `m2u|${dev}|${c.device}|${formatAddr(frame.ip.dst)}`;
    if (!this.stormNoted.has(k)) {
      this.stormNoted.set(k, t);
      this.noteAt(t, 'note', frame.msg.protocol, dev, c.device, 'multicast to unicast', '', `${dev} sends ${formatAddr(frame.ip.dst)} to ${c.device} as unicast frames to ${cl.mac} (multicast to unicast ${resolvedText(this.params.get('mc-to-unicast', dev, null, radio))})`);
    }
    return { ...frame, dst: cl.mac };
  }

  /** The time to an access point's next beacon on a radio (beacons at whole multiples of its beacon interval). */
  private beaconWait(ap: string, t: number, radio?: string): number {
    const bi = Math.max(1, this.params.num('ap-beacon', ap, null, radio ? ifaceRef(ap, radio) : null));
    return Math.ceil(t / bi - 1e-9) * bi - t;
  }

  /** A frame's headers layer by layer (the packet inspector). */
  headers(frame: Frame, tag: number | null): Headers {
    const cast = castOf(frame.dst);
    const ips: Headers['l3'] = [];
    let p = frame.ip;
    let inner: Pkt | undefined;
    while (p) {
      ips.push({ version: p.dst.version, src: formatAddr(p.src), dst: formatAddr(p.dst), ttl: p.ttl, df: p.dst.version === 6 || !!p.df, proto: protoText(p), len: ipLen(p), frag: p.frag ? `fragment ${p.frag.i} of ${p.frag.n}, offset ${p.frag.offset}` : undefined, encap: p.encap, options: p.routerAlert ? (p.dst.version === 4 ? 'Router Alert (option 20)' : 'Hop-by-Hop: Router Alert (MLD)') : undefined });
      inner = p;
      p = p.inner;
    }
    const ethertype = frame.arp ? 'ARP (0x0806)' : frame.ip ? (frame.ip.dst.version === 4 ? 'IPv4 (0x0800)' : 'IPv6 (0x86dd)') : frame.msg.protocol === 'lacp' ? 'Slow protocols (0x8809)' : frame.msg.protocol === 'lldp' ? 'LLDP (0x88cc)' : 'LLC (IEEE 802.3 length field)';
    const h: Headers = {
      cast,
      protocol: frame.msg.protocol,
      label: frame.msg.label,
      l2: { src: frame.src, dst: frame.dst, dstNote: macNote(frame), vlan: tag, ethertype, bytes: this.frameBytes(frame) },
      l3: ips,
      payload: frame.msg.detail,
    };
    if (frame.arp) h.arp = { op: frame.arp.gratuitous ? 'request (gratuitous)' : frame.arp.op, senderMac: frame.arp.sha, senderIp: formatAddr(frame.arp.spa), targetMac: frame.arp.tha, targetIp: formatAddr(frame.arp.tpa) };
    if (inner && inner.l4) h.l4 = inner.l4;
    const ins = frame.msg.data ? (frame.msg.data as { inspect?: Headers['app'] }).inspect : undefined;
    if (ins) h.app = ins;
    return h;
  }

  private arrive(dev: string, port: string, frame: Frame, tag: number | null, t: number, flight: number, seen: Set<string>): void {
    const sd = this.net.devices.get(dev);
    if (!sd) return;
    if (this.off.has(dev) && !this.bypass.has(dev)) return;
    if (frame.l2) {
      this.deliverL2(dev, port, frame, t, flight);
      return;
    }
    const bpId = sd.bridge ? sd.portOf.get(port) : undefined;
    if (sd.bridge && bpId !== undefined) {
      const bp = sd.bridgePorts.get(bpId) as BridgePort;
      const vlan = ingressVlan(bp.vlans, tag);
      if (seen.has(dev)) {
        // back at a bridge it passed: a loop without spanning tree (a storm), else not followed twice
        if (vlan === null || this.blocked(dev, bpId, vlan) || !this.loopsBack(sd, port, vlan, frame, t)) return;
        frame = { ...frame, loops: (frame.loops || 0) + 1 };
        seen = new Set();
      }
      if (vlan === null) {
        this.noteAt(t, 'drop', frame.msg.protocol, dev, '', frame.msg.type, '', `dropped at ${dev}:${port}: ${tag ? `VLAN ${tag} is not allowed on the port (${portVlansText(bp.vlans)})` : `the trunk has no native VLAN for untagged frames (${portVlansText(bp.vlans)})`} (${frame.msg.label})`);
        return;
      }
      // an untagged frame of one VLAN arriving in another (a native or access VLAN mismatch): it leaks, as on a real cable
      if (tag === null && frame.inVlan !== undefined && frame.inVlan !== 0 && vlan !== 0 && vlan !== frame.inVlan) this.noteLeak(dev, port, frame, vlan, t);
      if (this.blocked(dev, bpId, vlan)) return;
      this.bridge(sd, bpId, vlan, frame, t, flight, new Set(seen).add(dev));
      return;
    }
    // a passive monitor (a passive IDS/IPS, a sensor) takes what it is given as a copy: it observes and never forwards
    const mon = sd.caps.passiveCopy ? this.l3At(sd, port, tag) : undefined;
    if (sd.caps.passiveCopy && (!mon || !mon.addrs.length || !this.accepts(sd, mon, frame))) {
      const k = `copy|${dev}|${port}|${frame.msg.protocol}`;
      if (!this.stormNoted.has(k) || t - (this.stormNoted.get(k) as number) >= 10000) {
        this.stormNoted.set(k, t);
        this.noteAt(t, 'message', frame.msg.protocol, dev, '', 'observed', '', `${dev} receives a copy at ${port} and forwards nothing: ${frame.msg.label}${frame.ip ? ` (${formatAddr(frame.ip.src)} → ${formatAddr(frame.ip.dst)})` : ''}`);
      }
      // a passive IDS: what its Inspection names is an alert (it blocks nothing)
      const rule = sd.caps.inspection ? inspectionMatch(this.model, dev, frame) : null;
      if (rule) this.noteAt(t, 'note', frame.msg.protocol, dev, '', 'alert', '', `${dev} raises an alert: ${frame.msg.label}${frame.ip ? ` (${formatAddr(frame.ip.src)} → ${formatAddr(frame.ip.dst)})` : ''} matches its Inspection rule ${rule} (passive: the traffic passes)`);
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
    // tagged: the subinterface of that VLAN; untagged: the port itself (a routed port, a routed aggregate)
    if (tag) return cands.find((l) => l.kind === 'subif' && l.vlan === tag);
    return cands.find((l) => l.kind === 'routed' || l.kind === 'aggregate');
  }

  /** Does a layer-3 interface take a frame: its own MAC, a virtual MAC it holds, a group address. */
  private accepts(sd: SimDevice, l3: L3Iface, frame: Frame): boolean {
    if (isGroupMac(frame.dst)) return true;
    if (frame.dst === l3.mac) return true;
    return !!this.protocols && this.protocols.owns(sd.id, l3.id).some((o) => o.mac === frame.dst);
  }

  /** A bridge forwards a frame in a VLAN (from a port, or from its own VLAN interface when `from` is null). */
  private bridge(sd: SimDevice, from: string | null, vlan: number, frame: Frame, t: number, flight: number | undefined, seen: Set<string>): void {
    // an inline appliance that failed open is a wire: no learning, no inspection
    const wire = this.bypass.has(sd.id);
    // a virtual switch takes broadcasts from its active uplink only (they would come twice), and learns nothing on its uplinks
    const fromUplink = !!sd.virt && sd.virt.kind === 'vswitch' && from !== null && sd.virt.uplinks.indexOf(from) >= 0;
    if (fromUplink && isGroupMac(frame.dst) && this.standbyUplink(sd, from as string)) return;
    if (from !== null && !wire && !fromUplink) this.learn(sd, vlan, frame.src, from, t);
    if (from !== null && this.ptpHook && frame.msg.protocol === 'ptp') this.ptpHook.ingress(sd.id, from, frame, t);
    if (sd.caps.inspection && !wire) t += this.params.num('ips-latency', sd.id);
    // to its own VLAN interface (the switch's management or routing interface)
    if (from !== null && !wire) {
      for (const l3 of sd.l3.values()) {
        if (l3.kind !== 'svi' || l3.vlan !== vlan) continue;
        if (this.accepts(sd, l3, frame)) this.deliverL3(sd.id, l3, frame, t, flight !== undefined ? flight : -1);
      }
    }
    // a cloud (external transit) is one opaque Layer 3 hop: what has no hop left (TTL 1: a routing protocol's hello, link-local traffic) ends at it,
    // everything else crosses it with its TTL one lower; its internals are not modelled
    if (sd.caps.externalTransit && frame.ip && from !== null) {
      if (frame.ip.ttl <= 1 || isLinkLocalGroup(frame.ip.dst)) {
        const k = `cloudttl|${sd.id}|${frame.msg.protocol}`;
        if (!this.stormNoted.has(k) || t - (this.stormNoted.get(k) as number) >= 10000) {
          this.stormNoted.set(k, t);
          this.noteAt(t, 'drop', frame.msg.protocol, sd.id, '', frame.msg.type, '', `${sd.id} is a Layer 3 hop (an external network): ${frame.msg.label} (${formatAddr(frame.ip.src)} → ${formatAddr(frame.ip.dst)}, TTL ${frame.ip.ttl}) does not cross it — run it through a tunnel`);
        }
        return;
      }
      frame = { ...frame, ip: { ...frame.ip, ttl: frame.ip.ttl - 1 } };
    }
    // a cloud (the internet) carries no routed multicast unless it is set to
    if (sd.caps.externalTransit && frame.ip && isMulticastIp(frame.ip.dst) && !isLinkLocalGroup(frame.ip.dst) && this.params.str('mc-support', sd.id) !== 'on') {
      const k = `cloudmc|${sd.id}|${formatAddr(frame.ip.dst)}`;
      if (!this.stormNoted.has(k) || t - (this.stormNoted.get(k) as number) >= 10000) {
        this.stormNoted.set(k, t);
        this.noteAt(t, 'drop', frame.msg.protocol, sd.id, '', frame.msg.type, '', `${sd.id} carries no multicast (${resolvedText(this.params.get('mc-support', sd.id))}): ${frame.msg.label} to ${formatAddr(frame.ip.dst)} is dropped`);
      }
      return;
    }
    // a Wi-Fi network a controller-managed access point tunnels to its controller: not simulated, and said so
    const tun = from !== null ? this.tunneledNet(sd, from) : null;
    if (tun) {
      const k = `tunneled|${sd.id}|${tun}`;
      if (!this.stormNoted.has(k)) {
        this.stormNoted.set(k, t);
        this.noteAt(t, 'drop', frame.msg.protocol, sd.id, '', frame.msg.type, '', `${sd.id} tunnels the Wi-Fi network ${tun} to its controller (forwarding: tunneled): the tunnel is not simulated, so its traffic ends here (a limitation, not a failure of the network)`);
      }
      return;
    }
    // what may cross at all: an inline or pass-through device between its paired ports, a filtering bridge into its other domain, a transparent firewall by its policy
    const cross = from !== null && !wire ? this.crossing(sd, from, frame, t) : null;
    if (cross && cross.drop) return;
    if (cross) t = cross.t;
    const tab = this.macs.get(sd.id) as Map<string, MacEntry>;
    const known = !isGroupMac(frame.dst) ? tab.get(vlan + '|' + frame.dst) : undefined;
    if (known && known.type === 'static') return;
    const fresh = known && !wire && t - known.refreshed <= this.macAging(sd.id);
    const out: BridgePort[] = [];
    if (fresh) {
      const bp = sd.bridgePorts.get((known as MacEntry).port);
      if (!bp || bp.id === from) return;
      out.push(bp);
    } else {
      for (const bp of Array.from(sd.bridgePorts.values()).sort((a, b) => cmp(a.id, b.id))) if (bp.id !== from) out.push(bp);
    }
    // IGMP / MLD snooping: a group's frames to its member ports and the router ports only
    let to = sd.virt ? this.virtOut(sd, from, frame, out, !!fresh) : out;
    let snooped: SnoopResult | null = null;
    if (!wire && isGroupMac(frame.dst) && frame.dst !== BROADCAST && this.protocols && this.protocols.snoop) {
      snooped = this.protocols.snoop(sd, from, vlan, frame, t);
      const keep = snooped ? snooped.ports : null;
      if (keep) to = out.filter((bp) => keep.has(bp.id));
    }
    if (snooped && snooped.kind !== 'linklocal' && flight !== undefined && flight >= 0) this.mcDecide(sd, from, vlan, frame, t, flight, snooped, to);
    if (cross && cross.only) to = to.filter((bp) => (cross.only as string[]).indexOf(bp.id) >= 0);
    // a TAP's copy: the same frame out of its monitor ports as well (the original goes on)
    if (cross && cross.copy) {
      for (const id of cross.copy) {
        const cp = sd.bridgePorts.get(id);
        if (cp && to.indexOf(cp) < 0) to = to.concat([cp]);
      }
    }
    for (const bp of to) {
      const c = carries(bp.vlans, vlan);
      if (!c || this.blocked(sd.id, bp.id, vlan) || this.tunneledNet(sd, bp.id)) continue;
      const up = bp.members.filter((m) => this.portUp(sd.id, m) && this.memberReady(sd.id, m) && this.cabledOrBoundary(sd.id, m));
      if (!up.length) continue;
      const m = up.length === 1 ? up[0] : up[hashIndex(frame.src + frame.dst, up.length)];
      this.transmit(sd.id, m, c === 'untagged' ? { ...frame, inVlan: vlan } : frame.inVlan !== undefined ? { ...frame, inVlan: undefined } : frame, c === 'untagged' ? null : vlan, t, flight, seen);
    }
  }

  /**
   * The multicast forwarding decisions, by the flight that brought the
   * packet (the packet inspector: what the device it arrived at did with
   * it, and why each hop out of it was sent). The newest 20 000.
   */
  readonly mcDecisions = new Map<number, McDecision[]>();

  /** Record a decision (one per device and layer for a flight: a Layer 3 switch both switches and routes it; bounded: the oldest flights go first). */
  recordMc(flight: number, d: McDecision): void {
    const list = (this.mcDecisions.get(flight) || []).filter((x) => x.dev !== d.dev || x.layer !== d.layer);
    list.push(d);
    this.mcDecisions.set(flight, list);
    if (this.mcDecisions.size > 20000) this.mcDecisions.delete(this.mcDecisions.keys().next().value as number);
  }

  /** The flight whose delivery is being handled now (-1: none: a timer, a user's event). */
  currentFlight(): number {
    return this.causeFlight === null ? -1 : this.causeFlight;
  }

  /**
   * A switch's multicast forwarding decision for a frame, port by port: the
   * ingress port (never back), each port the snooping keeps (member port,
   * router port, flooded) and whether it can carry it (its VLAN, the
   * spanning tree, its link), each port it leaves out and why.
   */
  private mcDecide(sd: SimDevice, from: string | null, vlan: number, frame: Frame, t: number, flight: number, r: SnoopResult, to: BridgePort[]): void {
    if (!frame.ip) return;
    const left = (u: number): string => (u === Infinity ? '' : ` (${fmtDur(u - t)} left)`);
    const ports: McPort[] = [];
    for (const bp of Array.from(sd.bridgePorts.values()).sort((a, b) => cmp(a.id, b.id))) {
      const c = carries(bp.vlans, vlan);
      if (bp.id === from) {
        ports.push({ port: bp.id, sent: false, why: 'ingress port (never sent back)' });
        continue;
      }
      if (!c) continue;
      const member = r.members.get(bp.id);
      const router = r.routers.get(bp.id);
      // (a leave heard there: the member port stays until its last member queries are over, unless a member answers)
      const mp = member === undefined ? '' : r.leaving && r.leaving.has(bp.id) ? `member port, leave pending: it goes in ${((member - t) / 1000).toFixed(1)} s unless a member answers the group-specific queries` : `member port${left(member)}`;
      const role = mp && router !== undefined ? `${mp}; multicast router port` : mp || (router !== undefined ? `multicast router port${left(router)}` : '');
      if (to.indexOf(bp) < 0) {
        ports.push({ port: bp.id, sent: false, why: r.kind === 'control' ? 'no multicast router port (reports go to router ports only)' : 'no member and no multicast router port' });
        continue;
      }
      const why = role || (r.kind === 'off' ? `flooded (snooping ${r.mode === 'unset' ? 'not configured' : 'disabled'} in VLAN ${vlan})` : 'flooded (unregistered multicast flooded)');
      const up = bp.members.filter((m) => this.portUp(sd.id, m) && this.memberReady(sd.id, m) && this.net.ends.has(portKey(sd.id, m)));
      if (this.blocked(sd.id, bp.id, vlan)) ports.push({ port: bp.id, sent: false, why: `${why}, but blocked by the spanning tree` });
      else if (this.tunneledNet(sd, bp.id)) ports.push({ port: bp.id, sent: false, why: `${why}, but tunneled to its controller` });
      else if (!up.length) ports.push({ port: bp.id, sent: false, why: `${why}, but its link is down` });
      else ports.push({ port: bp.id, sent: true, why });
    }
    const g = formatAddr(frame.ip.dst);
    const fam = frame.ip.dst.version === 4 ? 'IGMP' : 'MLD';
    const mode = r.mode === 'enabled' ? `${fam} snooping enabled in VLAN ${vlan}; unregistered multicast ${r.unregistered === 'flood' ? 'flooded' : 'to the router ports only'}` : `${fam} snooping ${r.mode === 'unset' ? 'not configured' : 'disabled'} in VLAN ${vlan}: flooded`;
    const sent = ports.filter((p) => p.sent).map((p) => p.port);
    const what = r.kind === 'control' ? `the ${fam} report or leave` : g;
    const text = sent.length ? `${sd.id} switches ${what} in VLAN ${vlan} to ${sent.join(', ')}` : `${sd.id} sends ${what} to no port in VLAN ${vlan}`;
    this.recordMc(flight, { dev: sd.id, t, layer: 'l2', vlan, group: g, ingress: from, mode, ports, text });
  }

  /**
   * What may cross a bridging device from a port (null: anything, as on a
   * switch): an inline or pass-through device's paired port (one way where
   * the pair says so; a copy to its monitor port), a filtering bridge's
   * other domain as far as its policy permits (ARP passes so permitted
   * transfers resolve; no other non-IP frame), a transparent firewall's
   * policy on what it bridges.
   */
  private crossing(sd: SimDevice, from: string, frame: Frame, t: number): { drop?: boolean; only?: string[]; copy?: string[]; t: number } | null {
    const c = sd.caps;
    const d = sd.dev;
    if (c.inline || c.passThrough) {
      const pair = d.portPairs.find((p) => p.a === from || p.b === from);
      const k = `pair|${sd.id}|${from}`;
      if (!pair || (pair.direction === 'a_to_b' && pair.a !== from)) {
        if (!this.stormNoted.has(k) || t - (this.stormNoted.get(k) as number) >= 10000) {
          this.stormNoted.set(k, t);
          this.noteAt(t, 'drop', frame.msg.protocol, sd.id, '', frame.msg.type, '', pair ? `${sd.id} passes traffic one way only, from ${pair.a} to ${pair.b}: ${frame.msg.label} from ${pair.b} ends here` : `${sd.id} passes traffic between its paired ports only: ${from} is paired with none (${frame.msg.label})`);
        }
        return { drop: true, t };
      }
      const other = pair.a === from ? pair.b : pair.a;
      // an inline IDS/IPS: what its Inspection blocks ends here
      const rule = c.inspection ? inspectionMatch(this.model, sd.id, frame) : null;
      if (rule) {
        this.noteAt(t, 'drop', frame.msg.protocol, sd.id, '', 'blocked', '', `${sd.id} blocks ${frame.msg.label}${frame.ip ? ` (${formatAddr(frame.ip.src)} → ${formatAddr(frame.ip.dst)})` : ''}: its Inspection blocks ${rule}`);
        return { drop: true, t };
      }
      return { only: [other], copy: pair.copy, t };
    }
    if (c.securityGateway && d.separation && c.separation === 'filtering_bridge') {
      const fromD = domainOf(d.separation, from);
      const toD = fromD ? otherDomain(d.separation, fromD.name) : undefined;
      if (!fromD || !toD) return { drop: true, t };
      if (frame.ip) {
        // (each of the other domain's ports gets the same decision: the policy is by domain)
        const delay = this.sep.pass(d, frame.ip, from, toD.interfaces[0]);
        if (delay === null) return { drop: true, t };
        return { only: toD.interfaces.slice(), t: t + delay };
      }
      if (frame.arp || frame.nd) return { only: toD.interfaces.slice(), t };
      return { drop: true, t };
    }
    if (c.firewallPolicy && frame.ip && this.protocols && this.protocols.filter) {
      // a transparent firewall: its policy on what it bridges (its ports have no addresses: the bridge ports stand for them)
      const port = (id: string): L3Iface => ({ device: sd.id, id, kind: 'routed', addrs: [], vrf: '', vlan: 0, ports: [id], mac: '', macSimulated: true });
      if (!this.protocols.filter(sd.id, frame.ip, port(from), port(from))) return { drop: true, t };
    }
    return null;
  }

  /** The Wi-Fi network of an association port ("radio~link") that its access point tunnels to the controller, else null. */
  private tunneledNet(sd: SimDevice, port: string): string | null {
    const k = port.indexOf('~');
    if (k < 0 || !sd.dev.wireless) return null;
    const l = this.net.links.get(port.slice(k + 1));
    const net = l ? sd.dev.wireless.networks.find((x) => x.id === l.wirelessNetwork) : undefined;
    return net && net.forwarding === 'tunneled' ? net.id : null;
  }

  /** Does a VPN gateway forward a packet: in or out of one of its tunnels, or to or from its remote-access clients? (It says so when not.) */
  private vpnTransit(sd: SimDevice, from: L3Iface, out: L3Iface, pkt: Pkt): boolean {
    const v = sd.dev.vpn;
    if (!v) return false;
    if (v.tunnels.indexOf(from.id) >= 0 || v.tunnels.indexOf(out.id) >= 0) return true;
    const pool = v.pool !== undefined ? parsePrefix(v.pool) : null;
    if (pool && pool.version === pkt.src.version && (inPrefix(pool, pkt.src) || inPrefix(pool, pkt.dst))) return true;
    const k = `vpnonly|${sd.id}|${from.id}|${out.id}`;
    if (!this.stormNoted.has(k) || this.now - (this.stormNoted.get(k) as number) >= 10000) {
      this.stormNoted.set(k, this.now);
      this.note('drop', pkt.msg.protocol, sd.id, '', pkt.msg.type, '', `${sd.id} is a ${deviceTypeInText('vpn_gateway')}: it forwards only to and from its VPN (${v.tunnels.length ? 'tunnels ' + v.tunnels.join(', ') : 'remote-access clients in ' + (v.pool || 'its pool')}), not ${formatAddr(pkt.src)} → ${formatAddr(pkt.dst)} from ${from.id} to ${out.id} (${pkt.msg.label})`);
    }
    return false;
  }

  // ------------------------------------------------------------ virtual switches and container networks

  /** a virtual switch's uplink that went down: until when its failover detection runs (by port key of the bridge port) */
  private uplinkDownAt = new Map<string, number>();
  /** the uplink a virtual switch announced its guests on last (active / standby) */
  private virtActive = new Map<string, string | null>();

  /** Is an uplink of a virtual switch in use: up, or down while the failover detection still runs (frames to it are lost)? */
  private uplinkInUse(sd: SimDevice, u: string): boolean {
    const bp = sd.bridgePorts.get(u);
    if (!bp) return false;
    if (bp.members.some((m) => this.portUp(sd.id, m) && this.memberReady(sd.id, m))) return true;
    const t = this.uplinkDownAt.get(portKey(sd.id, u));
    return t !== undefined && this.now < t;
  }

  /** The uplink a virtual switch sends a guest's frame by (its teaming); null: none is in use. */
  private activeUplink(sd: SimDevice, from: string | null, frame: Frame): string | null {
    const v = sd.virt as NonNullable<SimDevice['virt']>;
    const usable = v.uplinks.filter((u) => this.uplinkInUse(sd, u));
    if (!usable.length) return null;
    if (v.teaming === 'load_based' || v.teaming === 'source_based') return usable[hashIndex(from || frame.src, usable.length)];
    return usable[0];
  }

  /** Is a port a standby uplink of an active / standby virtual switch (it takes no broadcasts)? */
  private standbyUplink(sd: SimDevice, port: string): boolean {
    const v = sd.virt as NonNullable<SimDevice['virt']>;
    if (v.kind !== 'vswitch' || v.uplinks.indexOf(port) < 0 || (v.teaming && v.teaming !== 'active_standby')) return false;
    const a = v.uplinks.find((u) => this.uplinkInUse(sd, u));
    return a !== undefined && a !== port;
  }

  /** Where a virtual switch or container network sends a frame (see the module comment). */
  private virtOut(sd: SimDevice, from: string | null, frame: Frame, out: BridgePort[], known: boolean): BridgePort[] {
    const v = sd.virt as NonNullable<SimDevice['virt']>;
    const ups = v.uplinks;
    const fromUp = from !== null && ups.indexOf(from) >= 0;
    // macvlan / ipvlan: the host's own port and the containers never meet
    if (v.hostPort !== undefined && from !== null && !fromUp) out = from === v.hostPort ? out.filter((bp) => ups.indexOf(bp.id) >= 0) : out.filter((bp) => bp.id !== v.hostPort);
    if (v.kind !== 'vswitch' || !ups.length) return out;
    // from an uplink: to its guests only (split horizon); a unicast frame for no guest of it is dropped
    if (fromUp) return !known && !isGroupMac(frame.dst) ? [] : out.filter((bp) => ups.indexOf(bp.id) < 0);
    // from a guest: to the others on it, and what is not theirs out of the teaming's uplink
    const pick = this.activeUplink(sd, from, frame);
    const local = out.filter((bp) => ups.indexOf(bp.id) < 0);
    if (known || pick === null) return local;
    return local.concat([sd.bridgePorts.get(pick) as BridgePort]);
  }

  /** An uplink of a virtual switch went down or came up: fail over once the failover detection has passed, or fail back. */
  private uplinkChange(dev: string, port: string, up: boolean): void {
    const sd = this.net.devices.get(dev);
    if (!sd || !sd.virt || sd.virt.kind !== 'vswitch') return;
    const bp = sd.portOf.get(port);
    if (bp === undefined || sd.virt.uplinks.indexOf(bp) < 0) return;
    const key = portKey(dev, bp);
    const v = sd.virt;
    if (!up) {
      const r = this.params.get('failover-detect', v.owner, null, vswRef(v.owner, v.name));
      const t = this.now + Number(r.value);
      this.uplinkDownAt.set(key, t);
      this.at(t, () => {
        if (this.uplinkDownAt.get(key) !== t) return;
        this.uplinkDownAt.delete(key);
        this.failover(sd, `${bp} is down (failover detection ${resolvedText(r)})`);
      });
      return;
    }
    this.uplinkDownAt.delete(key);
    this.failover(sd, `${bp} is up again`);
  }

  /** The active uplink of an active / standby virtual switch changed: the guests' MAC addresses are announced on the new one (RARP). */
  private failover(sd: SimDevice, why: string): void {
    const v = sd.virt as NonNullable<SimDevice['virt']>;
    if (this.off.has(sd.id)) return;
    const now = v.uplinks.find((u) => this.uplinkInUse(sd, u)) || null;
    const was = this.virtActive.get(sd.id);
    this.virtActive.set(sd.id, now);
    // (the first uplink to come up at the start is no failover)
    if (was === undefined || was === now || (v.teaming && v.teaming !== 'active_standby') || v.teaming === 'lacp') return;
    if (now === null) {
      this.note('link', 'link', sd.id, '', 'No uplink', 'down', `${v.name} on ${v.owner}: ${why}; no uplink is left: its guests are cut off from the network`);
      return;
    }
    this.note('link', 'link', sd.id, '', was === null ? 'Uplink back' : 'Failover', 'up', `${v.name} on ${v.owner}: ${why}; it sends by ${now} now${was !== null ? ` (was ${was})` : ''} and notifies the switches: a RARP for each guest’s MAC address`);
    this.flushPort(sd.id, was || now, 'its virtual switch failed over');
    const bp = sd.bridgePorts.get(now) as BridgePort;
    for (const p of Array.from(sd.bridgePorts.values()).sort((a, b) => cmp(a.id, b.id))) {
      if (v.uplinks.indexOf(p.id) >= 0) continue;
      const e = this.net.ends.get(portKey(sd.id, p.members[0]));
      if (!e || !this.cableUp(e.link)) continue;
      const o = otherEnd(this.net, e);
      const m = this.net.macs.get(o.device + ':' + o.port);
      if (!m) continue;
      const vlan = p.vlans.untagged !== null ? p.vlans.untagged : 0;
      const msg: Msg = { protocol: 'garp', type: 'RARP', label: `RARP ${shortMac(m.mac)} (notify switches)`, detail: `RARP from ${sd.id} for ${o.device}:${o.port} (${m.mac}) on its new uplink ${now} — to ${BROADCAST}, so that the switches learn where the address is now` };
      const member = bp.members.find((x) => this.portUp(sd.id, x)) || bp.members[0];
      const c = carries(bp.vlans, vlan);
      this.note('message', msg.protocol, sd.id, '', msg.type, '', msg.detail, this.now, msg);
      this.transmit(sd.id, member, { src: m.mac, dst: BROADCAST, msg }, c === 'tagged' ? vlan : null, this.now, undefined, new Set([sd.id]));
    }
  }

  // ------------------------------------------------------------ container NAT

  /** translations of container hosts: "host|outside src|remote|proto|port" → the container's address */
  /** source translations: by "device|outside address|remote|protocol|outside port", the inside address, port and VRF they stand for */
  private natTable = new Map<string, { inside: IpAddr; port?: number; vrf: string }>();
  /** the next outside port a PAT tries on a collision, per device */
  private patNext = new Map<string, number>();

  /**
   * A source translation: the outside port is the inside one unless that is
   * taken towards the same remote end by another inside address or VRF
   * (PAT then gives the next free one, from 1024): two inside hosts never
   * share a translation, and the reply goes back to the one it belongs to.
   */
  /**
   * A translation of the NAT table: the outside address, the remote end and
   * the protocol, and the flow's own identity there — TCP and UDP their
   * source port, an ICMP echo its identifier (RFC 5508 §3.1: two inside
   * hosts pinging one destination are two translations, never one) —
   * translated when it collides (PAT); returns the identity used outside.
   */
  private translate(dev: string, to: IpAddr, pkt: Pkt, vrf: string, pat: boolean): number | undefined {
    const proto = pkt.l4 ? pkt.l4.proto : '';
    const sport = natPort(pkt.l4, 'src');
    const base = `${dev}|${formatAddr(to)}|${formatAddr(pkt.dst)}|${proto}|`;
    const mine = (e: { inside: IpAddr; port?: number; vrf: string } | undefined): boolean => !!e && compareAddr(e.inside, pkt.src) === 0 && e.port === sport && e.vrf === vrf;
    let port = sport;
    if (pat && sport !== undefined) {
      const cur = this.natTable.get(base + sport);
      if (cur && !mine(cur)) {
        // the same flow translated before keeps its port
        const again = Array.from(this.natTable).find(([k, e]) => k.indexOf(base) === 0 && mine(e));
        if (again) port = Number(again[0].slice(base.length));
        else {
          let n = this.patNext.get(dev) || 1024;
          while (this.natTable.has(base + n)) n = n >= 65535 ? 1024 : n + 1;
          this.patNext.set(dev, n >= 65535 ? 1024 : n + 1);
          port = n;
        }
      }
    }
    this.natTable.set(base + (port !== undefined ? port : ''), { inside: pkt.src, port: sport, vrf });
    return port;
  }

  /** The container network a host interface is the bridge of (docker0), with NAT or not. */
  private bridgeNet(dev: string, l3: L3Iface): { name: string; nat: boolean } | null {
    const i = this.model.index.interfaces.get(ifaceKey(dev, l3.id));
    if (!i || i.type !== 'bridge' || i.derived === undefined) return null;
    const d = this.model.index.devices.get(dev);
    const net = d && d.containerEngine ? d.containerEngine.networks.find((n) => n.name === i.derived) : undefined;
    return net ? { name: net.name, nat: !!net.nat } : null;
  }

  /** published-port translations: "host|container addr|container port|remote|remote port" → the host's address and port the client used */
  private dnatTable = new Map<string, { addr: IpAddr; port: number }>();

  /** A packet from a container bridge with NAT, out of another interface: its source becomes the host's address there. */
  private snat(dev: string, from: L3Iface, out: L3Iface, pkt: Pkt): Pkt {
    // a reply from a published port: from the address and port the client used
    if (pkt.l4 && pkt.l4.sport !== undefined && pkt.l4.dport !== undefined) {
      const d = this.dnatTable.get(`${dev}|${formatAddr(pkt.src)}|${pkt.l4.sport}|${formatAddr(pkt.dst)}|${pkt.l4.dport}`);
      if (d) {
        this.note('route', pkt.msg.protocol, dev, '', 'NAT reply', '', `${dev} translates the reply from its published port: source ${formatAddr(pkt.src)}:${pkt.l4.sport} → ${formatAddr(d.addr)}:${d.port} (${pkt.msg.label})`, this.now, pkt.msg);
        return { ...pkt, src: d.addr, l4: { ...pkt.l4, sport: d.port } };
      }
    }
    // the NAT service: from an inside interface out of an outside one, a source its PAT or SNAT rule matches
    const nat = natOf(this.model, dev);
    if (nat && nat.inside.indexOf(from.id) >= 0 && nat.outside.indexOf(out.id) >= 0) {
      const rule = nat.rules.find((r) => (r.type === 'pat' || r.type === 'snat') && (r.source === 'any' || (typeof r.source === 'string' && inNetText(r.source, pkt.src))));
      const own = out.addrs.find((x) => x.addr.version === pkt.src.version);
      const to = rule && typeof rule.to === 'string' ? parseAddress(rule.to) : own ? own.addr : null;
      if (rule && to) {
        const sport = natPort(pkt.l4, 'src');
        const port = this.translate(dev, to, pkt, from.vrf, rule.type === 'pat');
        const moved = port !== sport && port !== undefined;
        const icmp = !!pkt.l4 && pkt.l4.proto === 'icmp';
        this.note('route', pkt.msg.protocol, dev, '', rule.type === 'pat' ? 'PAT' : 'SNAT', '', `${dev} translates the source (${rule.type === 'pat' ? 'PAT' : 'source NAT'}, ${from.id} → ${out.id}): ${formatAddr(pkt.src)}${moved ? (icmp ? ' (echo identifier ' + sport + ')' : ':' + sport) : ''} → ${formatAddr(to)}${moved ? (icmp ? ' (echo identifier ' + port + ')' : ':' + port) + ' (its ' + (icmp ? 'identifier' : 'port') + ' is taken towards ' + formatAddr(pkt.dst) + ')' : ''} (${pkt.msg.label})`, this.now, pkt.msg);
        return { ...pkt, src: to, l4: moved && pkt.l4 ? withNatPort(pkt.l4, 'src', port as number) : pkt.l4 };
      }
    }
    const b = this.bridgeNet(dev, from);
    if (!b || !b.nat || out.id === from.id || this.bridgeNet(dev, out)) return pkt;
    const a = out.addrs.find((x) => x.addr.version === pkt.src.version);
    if (!a) return pkt;
    const sport = natPort(pkt.l4, 'src');
    const port = this.translate(dev, a.addr, pkt, from.vrf, true);
    const moved = port !== sport && port !== undefined;
    this.note('route', pkt.msg.protocol, dev, '', 'SNAT', '', `${dev} translates the source (masquerade, network ${b.name}): ${formatAddr(pkt.src)}${moved ? ':' + sport : ''} → ${formatAddr(a.addr)}${moved ? ':' + port : ''} out of ${out.id} (${pkt.msg.label})`, this.now, pkt.msg);
    return { ...pkt, src: a.addr, l4: moved && pkt.l4 ? withNatPort(pkt.l4, 'src', port as number) : pkt.l4 };
  }

  /** A packet to a container host's own address: the reply to a translated packet, or to a published port, goes on to its container. */
  private dnat(dev: string, pkt: Pkt): Pkt | null {
    const d = this.model.index.devices.get(dev);
    const nat = natOf(this.model, dev);
    if (!d || (!d.containerEngine && !nat)) return null;
    const proto = pkt.l4 ? pkt.l4.proto : '';
    // an ICMP error about a translated packet (unreachable, Fragmentation Needed): its quote names the translation; it goes to
    // the inside host with the quote translated back too, so that its sender finds its connection (PMTUD through NAT)
    const q = pkt.l4 && pkt.l4.proto === 'icmp' ? pkt.l4.quote : undefined;
    if (q) {
      const qport = q.proto === 'icmp' ? q.echoId : q.sport;
      const e = this.natTable.get(`${dev}|${q.src}|${q.dst}|${q.proto}|${qport !== undefined ? qport : ''}`);
      if (e) {
        const inside = formatAddr(e.inside);
        const quote = { ...q, src: inside, sport: q.proto === 'icmp' ? q.sport : e.port, echoId: q.proto === 'icmp' ? e.port : q.echoId, flow: q.flow.replace(`${q.src}:${qport !== undefined ? qport : 0}>`, `${inside}:${e.port !== undefined ? e.port : 0}>`) };
        this.note('route', pkt.msg.protocol, dev, '', 'NAT reply', '', `${dev} translates an ICMP error back: destination ${formatAddr(pkt.dst)} → ${inside}, its quoted header ${q.src}${qport !== undefined ? ':' + qport : ''} → ${inside}${e.port !== undefined ? ':' + e.port : ''} (${pkt.msg.label})`, this.now, pkt.msg);
        return { ...pkt, dst: e.inside, vrf: e.vrf, l4: { ...(pkt.l4 as L4), quote } };
      }
    }
    const dport = natPort(pkt.l4, 'dst');
    const k = `${dev}|${formatAddr(pkt.dst)}|${formatAddr(pkt.src)}|${proto}|${dport !== undefined ? dport : ''}`;
    const back = this.natTable.get(k);
    if (back) {
      const moved = back.port !== undefined && back.port !== dport;
      this.note('route', pkt.msg.protocol, dev, '', 'NAT reply', '', `${dev} translates the reply back: destination ${formatAddr(pkt.dst)}${moved ? ':' + dport : ''} → ${formatAddr(back.inside)}${moved ? ':' + back.port : ''}${back.vrf ? ' in VRF ' + back.vrf : ''} (${pkt.msg.label})`, this.now, pkt.msg);
      return { ...pkt, dst: back.inside, vrf: back.vrf, l4: moved && pkt.l4 ? withNatPort(pkt.l4, 'dst', back.port as number) : pkt.l4 };
    }
    // a published port: on to the container (TCP and UDP); a NAT service's port forward: on to its inside address
    if (!pkt.l4 || (pkt.l4.proto !== 'tcp' && pkt.l4.proto !== 'udp') || dport === undefined) return null;
    if (nat) {
      const r = nat.rules.find((x) => x.type === 'dnat' && x.protocol === pkt.l4!.proto && x.port === dport);
      const to = r && typeof r.to === 'string' ? parseAddress(r.to) : null;
      if (r && to) {
        const toPort = typeof r.to_port === 'number' ? (r.to_port as number) : dport;
        this.note('route', pkt.msg.protocol, dev, '', 'DNAT', '', `${dev} forwards port ${dport}/${pkt.l4.proto} to ${formatAddr(to)}:${toPort} (destination NAT) (${pkt.msg.label})`, this.now, pkt.msg);
        if (pkt.l4.sport !== undefined) this.dnatTable.set(`${dev}|${formatAddr(to)}|${toPort}|${formatAddr(pkt.src)}|${pkt.l4.sport}`, { addr: pkt.dst, port: dport });
        return { ...pkt, dst: to, l4: { ...pkt.l4, dport: toPort } };
      }
    }
    if (!d.containerEngine) return null;
    for (const c of this.model.devices) {
      if (!isContainer(c) || this.hostNow(c.id) !== dev) continue;
      for (const i of c.logical) {
        const p = (i.publish || []).find((x) => x.hostPort === dport && x.protocol === pkt.l4!.proto && (x.hostIp === undefined || x.hostIp === formatAddr(pkt.dst)));
        if (!p) continue;
        const x = vethNetwork(this.model, i);
        const addr = i.addresses.map((t) => parseAddress(t.replace(/\/.*$/, ''))).find((y) => !!y && y.version === pkt.dst.version);
        if (!x || !addr) continue;
        this.note('route', pkt.msg.protocol, dev, '', 'DNAT', '', `${dev} forwards its published port ${p.hostPort}/${p.protocol} to ${c.id} (${formatAddr(addr)}:${p.port}) on the network ${x.net.name} (${pkt.msg.label})`, this.now, pkt.msg);
        if (pkt.l4.sport !== undefined) this.dnatTable.set(`${dev}|${formatAddr(addr)}|${p.port}|${formatAddr(pkt.src)}|${pkt.l4.sport}`, { addr: pkt.dst, port: p.hostPort });
        return { ...pkt, dst: addr, l4: { ...pkt.l4, dport: p.port } };
      }
    }
    return null;
  }

  /** "VLAN mismatch" notes already written: "<device>:<port>|<from>|<to>" → the time (at most one every 10 s per pair). */
  private leakNoted = new Map<string, number>();

  /** Log a frame that leaves a port untagged in one VLAN and arrives untagged in another one (the ports' VLANs disagree). */
  private noteLeak(dev: string, port: string, frame: Frame, vlan: number, t: number): void {
    const k = `${dev}:${port}|${frame.inVlan}|${vlan}`;
    if (this.leakNoted.has(k) && t - (this.leakNoted.get(k) as number) < 10000) return;
    this.leakNoted.set(k, t);
    const e = this.net.ends.get(portKey(dev, port));
    const o = e ? otherEnd(this.net, e) : null;
    this.noteAt(t, 'note', frame.msg.protocol, dev, o ? o.device : '', 'VLAN mismatch', '', `VLAN mismatch on the cable to ${dev}:${port}: ${frame.msg.label} left ${o ? `${o.device}:${o.port}` : 'the other end'} untagged in VLAN ${frame.inVlan} and arrives untagged in VLAN ${vlan} — it leaks from VLAN ${frame.inVlan} into VLAN ${vlan} (the native or access VLANs of the two ports differ)`);
  }

  private deliverL2(dev: string, port: string, frame: Frame, t: number, flight: number): void {
    const d: Delivery = { dev, l3: { device: dev, id: port, kind: 'routed', addrs: [], vrf: '', vlan: 0, ports: [port], mac: '', macSimulated: false }, frame, flight, cancelled: false };
    this.pending.push(d);
    this.at(t, () => {
      this.pending.splice(this.pending.indexOf(d), 1);
      if (d.cancelled || !this.protocols || this.off.has(dev)) return;
      const p = this.protocols;
      this.caused(frame.msg, () => p.l2(dev, port, frame), d.flight);
    });
  }

  private deliverL3(dev: string, l3: L3Iface, frame: Frame, t: number, flight: number): void {
    // the logical view: a message without a relation goes from its sender to the network and on to this receiver
    const em = this.emitting;
    // (the dots that bring it, in either view: its last cable's, and the logical view's — the network line's second half,
    // or its relation's lane to this device — so that the view on screen holds it until its dot is there)
    const gates = [flight];
    if (em && em.net && em.dev !== dev && t > em.t && em.first !== null) {
      const mid = Math.min(em.t + this.hopTime() / 2, t);
      gates.push(this.flight(mid, Math.max(t, mid), frame.msg, 'logical', { ref: 'network:' + em.net, from: 'net', to: dev }, em.first, frameEncap(frame)).id);
    } else {
      const lane = (this.lanes.get(frame.msg) || []).find((x) => x.track.to === dev);
      if (lane) gates.push(lane.id);
    }
    const d: Delivery = { dev, l3, frame, flight, cancelled: false };
    this.pending.push(d);
    this.at(t, () => {
      const i = this.pending.indexOf(d);
      if (i >= 0) this.pending.splice(i, 1);
      if (d.cancelled || this.off.has(dev)) return;
      this.caused(frame.msg, () => this.receive(dev, l3, frame), d.flight);
    }, gates);
  }

  // ------------------------------------------------------------ flights (the dots)

  flight(t0: number, t1: number, msg: Msg, view: Flight['view'], track: Track, parent?: number, encap?: string[]): Flight {
    const f: Flight = { id: this.flightSeq++, t0, t1, protocol: msg.protocol, label: msg.label, view, track, parent, type: msg.type };
    if (encap && encap.length) f.encap = encap;
    // sent while a delivery is handled: caused by the flight that delivered it (the display keeps that order)
    if (parent === undefined && this.causeFlight !== null && this.causeFlight !== f.id) f.cause = this.causeFlight;
    // (a relation's dot drawn before its message is sent: its sending device)
    if (msg.sender === undefined && this.net.devices.has(track.from)) this.mark(msg, track.from);
    if (msg.sender !== undefined) f.sender = msg.sender;
    if (msg.origin !== undefined) f.origin = msg.origin;
    if (msg.test !== undefined) f.test = msg.test;
    if (msg.conv !== undefined) f.conv = msg.conv;
    if (msg.flags !== undefined) f.flags = msg.flags;
    if (view === 'logical') {
      const l = this.logicalNoHdr.get(msg);
      if (l) l.push(f);
      else this.logicalNoHdr.set(msg, [f]);
      // a relation's lane (or a hub's spoke) to a device: the delivery there waits for it on screen
      if (track.ref.indexOf('relation:') === 0 && track.to !== 'hub') {
        const r = this.lanes.get(msg);
        if (r) r.push(f);
        else this.lanes.set(msg, [f]);
      }
    }
    this.flights.push(f);
    this.flightById.set(f.id, f);
    return f;
  }

  /** The flights in the air at time t, or since `since` (the lost marks stay a moment). */
  flightsAt(t: number, view: Flight['view'], since = t): Flight[] {
    return this.flights.filter((f) => f.view === view && !f.hidden && f.t0 <= t && (f.dropped !== undefined ? f.dropped + 1200 >= since : f.t1 >= since));
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
      if (this.hasOwn(l3, a)) return l3;
      if (this.protocols && this.protocols.owns(dev, l3.id).some((o) => compareAddr(o.addr, a) === 0)) return l3;
    }
    return undefined;
  }

  private ipReceive(dev: string, l3: L3Iface, frame: Frame, pkt: Pkt): void {
    const sd = this.net.devices.get(dev) as SimDevice;
    // a neighbour's packet confirms its entry when it uses it (a refresh of what it sent from)
    const own = this.ownsAddress(dev, pkt.dst, l3.vrf);
    const bcast = this.broadcastFor(l3, pkt.dst);
    // its own broadcast or multicast, back over a loop: ignored
    if ((bcast || isMulticastIp(pkt.dst)) && (frame.loops || 0) > 0 && this.ownsAddress(dev, pkt.src)) return;
    // a routed group at a router: multicast routing (the RPF check, the outgoing interfaces); link-local groups and IGMP are its own
    if (isMulticastIp(pkt.dst) && sd.routes && !pkt.encap && this.protocols && this.protocols.mroute && this.protocols.mroute(dev, l3, pkt)) {
      // (a group its own interface joined, as a host: it takes it too, besides routing it)
      if (this.protocols.joined && this.protocols.joined(dev, l3.id, pkt.dst)) this.deliverLocal(dev, l3, pkt.vrf === l3.vrf ? pkt : { ...pkt, vrf: l3.vrf });
      return;
    }
    // to a container host's address: a reply to a translated packet, or to a published port, goes on to its container
    if (own && !bcast && !isMulticastIp(pkt.dst) && !pkt.encap) {
      const back = this.dnat(dev, pkt);
      if (back) {
        this.forward(dev, back, { l3, frame });
        return;
      }
    }
    if (isMulticastIp(pkt.dst) || own || bcast) {
      if (pkt.encap && pkt.inner) {
        this.decapsulate(dev, l3, pkt);
        return;
      }
      // delivered in the VRF of the interface it arrived for (its answer is routed there), not its sender's
      const at = own || l3;
      this.deliverLocal(dev, at, pkt.vrf === at.vrf ? pkt : { ...pkt, vrf: at.vrf });
      // a broadcast stays in its subnet: no router forwards it
      if (bcast && sd.routes && isLimitedBroadcast(pkt.dst) && pkt.msg.protocol !== 'dhcp') this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `${dev} takes the limited broadcast ${formatAddr(pkt.dst)} itself and routes it nowhere: it never leaves its subnet (${pkt.msg.label})`);
      return;
    }
    if (!sd.routes) {
      // a Layer 2 switch (its management address) or a host: it never routes for others
      const why = sd.l2switch ? 'a Layer 2 switch routes nothing' : sd.caps.sessionBreak && sd.caps.securityGateway ? 'it is a protocol break: nothing passes through it (a transfer is addressed to one of its transfer profiles’ listening ports, and it starts a new one itself)' : sd.caps.securityGateway ? 'its Domain separation has no implementation: it transfers nothing' : 'it does not forward traffic for others';
      if (frame.dst === l3.mac) this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `not routed at ${dev}: ${why} (${formatAddr(pkt.src)} → ${formatAddr(pkt.dst)}, ${pkt.msg.label})`);
      return;
    }
    // a router: forward, with the TTL decremented and the MACs rewritten, in the VRF of the interface it came in on
    // (as the path tracer does: a VRF's routes are for what arrives in it, not for what its sender's interface was in)
    if (pkt.ttl <= 1) {
      this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `TTL expired at ${dev} (${formatAddr(pkt.src)} → ${formatAddr(pkt.dst)}, TTL ${pkt.ttl}): ${pkt.msg.label}`);
      this.icmpError(dev, pkt, 'ttl', { from: l3 });
      return;
    }
    const next: Pkt = { ...pkt, ttl: pkt.ttl - 1, vrf: l3.vrf };
    this.forward(dev, next, { l3, frame });
  }

  /** Is an address a broadcast for an interface: 255.255.255.255, or the broadcast address of one of its subnets? */
  private broadcastFor(l3: L3Iface, a: IpAddr): boolean {
    if (a.version !== 4) return false;
    if (isLimitedBroadcast(a)) return true;
    return l3.addrs.some((x) => x.addr.version === 4 && x.net.prefix <= 30 && compareAddr(subnetBroadcast(x), a) === 0);
  }

  /** Is an address the broadcast address of a subnet somewhere in the model (or 255.255.255.255)? */
  isBroadcastAddr(a: IpAddr): boolean {
    return a.version === 4 && (isLimitedBroadcast(a) || this.bcasts.has(formatAddr(a)));
  }

  /**
   * A packet for this device: a fragment waits for the rest of its packet
   * (reassembled when the last arrives; given up after REASSEMBLY_MS with
   * an ICMP Time Exceeded), anything else goes to the protocols.
   */
  private deliverLocal(dev: string, l3: L3Iface, pkt: Pkt): void {
    if (!pkt.frag) {
      if (this.protocols) this.protocols.ip(dev, l3, pkt);
      return;
    }
    const key = `${dev}|${formatAddr(pkt.src)}|${formatAddr(pkt.dst)}|${pkt.id}`;
    let b = this.frags.get(key);
    if (!b) {
      b = { got: new Map(), first: this.now, pkt, l3, dev };
      this.frags.set(key, b);
      const buf = b;
      this.after(REASSEMBLY_MS, () => {
        if (this.frags.get(key) !== buf) return;
        this.frags.delete(key);
        this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `${dev} gives up reassembling ${pkt.msg.label}: ${buf.got.size} fragment${buf.got.size === 1 ? '' : 's'} arrived, not all, within ${durationText(REASSEMBLY_MS)}`);
        if (buf.got.has(0)) this.icmpError(dev, buf.pkt, 'reassembly', { from: buf.l3 });
      });
    }
    b.got.set(pkt.frag.offset, pkt.len || 0);
    if (pkt.frag.offset === 0) b.pkt = pkt;
    let bytes = 0;
    for (const n of b.got.values()) bytes += n;
    if (bytes < pkt.frag.whole) {
      this.note('table', pkt.msg.protocol, dev, '', 'fragment', '', `${dev} holds fragment ${pkt.frag.i} of ${pkt.frag.n} of ${pkt.msg.label} (${bytes} of ${pkt.frag.whole} bytes arrived)`);
      return;
    }
    this.frags.delete(key);
    const whole: Pkt = { ...pkt, frag: undefined, len: pkt.frag.whole };
    this.note('table', pkt.msg.protocol, dev, '', 'reassembled', '', `${dev} reassembled ${pkt.msg.label} from its ${b.got.size} fragments (${pkt.frag.whole} bytes)`);
    if (this.protocols) this.protocols.ip(dev, b.l3, whole);
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
    // a routed group out of a tunnel: multicast routing, as if it came in on the tunnel interface
    if (isMulticastIp(inner.dst) && !inner.encap && sd.routes && this.protocols && this.protocols.mroute && this.protocols.mroute(dev, via, inner)) return;
    if (this.ownsAddress(dev, inner.dst) || isMulticastIp(inner.dst)) {
      if (inner.encap && inner.inner) this.decapsulate(dev, via, inner);
      else this.deliverLocal(dev, this.ownsAddress(dev, inner.dst) || via, inner);
      return;
    }
    if (!sd.routes) return;
    if (inner.ttl <= 1) {
      this.note('drop', inner.msg.protocol, dev, '', inner.msg.type, '', `TTL expired at ${dev} (${formatAddr(inner.src)} → ${formatAddr(inner.dst)}, TTL ${inner.ttl}): ${inner.msg.label}`);
      this.icmpError(dev, inner, 'ttl', { from: via });
      return;
    }
    this.forward(dev, { ...inner, ttl: inner.ttl - 1 }, { l3: via, frame: null });
  }

  // ------------------------------------------------------------ layer 3: sending

  /** A packet; without a TTL it gets its sender's default TTL when it is sent. */
  newPacket(src: IpAddr, dst: IpAddr, vrf: string, msg: Msg, rides: string[] = [], ttl = 0): Pkt {
    return { id: this.pktSeq++, src, dst, ttl, vrf, msg, flow: formatAddr(src) + '>' + formatAddr(dst), rides };
  }

  /** A packet a device sends: its TTL (hop limit) is the device's default unless the protocol set one. */
  private stamp(dev: string, pkt: Pkt): Pkt {
    if (pkt.ttl > 0) return pkt;
    pkt.ttl = this.params.num('ttl', dev);
    return pkt;
  }

  /**
   * A device sends an IP packet: a unicast one along its routing table
   * (next hop resolved first), a link-local multicast one out of `out`.
   */
  send(dev: string, pkt: Pkt, out?: L3Iface): void {
    if (this.off.has(dev)) return;
    this.mark(pkt.msg, dev);
    this.stamp(dev, pkt);
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
    // a link-local destination (fe80::/10): out of the interface it is for, its neighbour resolved there; never routed (RFC 4291 §2.5.6)
    if (pkt.dst.version === 6 && isLinkLocal6(pkt.dst)) {
      if (!out) {
        this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `not sent: ${formatAddr(pkt.dst)} is a link-local address and no interface was given (${pkt.msg.label})`);
        return;
      }
      const o = out;
      this.resolve(dev, o, pkt.dst, pkt, (mac) => this.emit(dev, o, { src: o.mac, dst: mac, msg: pkt.msg, ip: pkt }));
      return;
    }
    // a broadcast: the limited broadcast out of `out` (else its first interface that is up with an IPv4 address); a broadcast of one of its own subnets out of that interface
    if (pkt.dst.version === 4) {
      const sd = this.net.devices.get(dev) as SimDevice;
      const ifs = Array.from(sd.l3.values()).filter((l) => l.kind !== 'loopback' && l.kind !== 'tunnel' && this.isL3Up(dev, l.id) && l.addrs.some((a) => a.addr.version === 4)).sort((a, b) => cmp(a.id, b.id));
      const via = isLimitedBroadcast(pkt.dst) ? out || ifs[0] : ifs.find((l) => this.broadcastFor(l, pkt.dst) && !isLimitedBroadcast(pkt.dst));
      if (via) {
        this.emit(dev, via, { src: via.mac, dst: BROADCAST, msg: pkt.msg, ip: pkt });
        return;
      }
      if (isLimitedBroadcast(pkt.dst)) {
        this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `not sent: ${dev} has no interface up with an IPv4 address (${pkt.msg.label})`);
        return;
      }
    }
    this.forward(dev, pkt, null);
  }

  /** The MTU of an interface: configured on it, else the simulation's default MTU. */
  mtu(dev: string, l3: L3Iface): Resolved {
    const i = this.model.index.interfaces.get(dev + ':' + l3.id);
    let own = i && i.mtu !== undefined ? i.mtu : undefined;
    if (own === undefined) {
      // a subinterface or VLAN interface without its own: its port's
      for (const p of l3.ports) {
        const pi = this.model.index.interfaces.get(dev + ':' + p);
        if (pi && pi.mtu !== undefined) own = own === undefined ? pi.mtu : Math.min(own, pi.mtu);
      }
    }
    return this.params.get('mtu', undefined, own !== undefined ? { value: own, where: `${dev}:${l3.id}` } : null);
  }

  /**
   * An IPv4 packet cut into fragments for an MTU (each carries a multiple
   * of 8 bytes but the last); a fragment is cut again the same way.
   */
  private fragment(pkt: Pkt, mtu: number): Pkt[] {
    // IPv4: its 20-byte header; IPv6: its 40 bytes and an 8-byte fragment header
    const hdr = pkt.dst.version === 6 ? 48 : 20;
    const per = Math.max(8, Math.floor((mtu - hdr) / 8) * 8);
    const total = ipLen(pkt) - (pkt.frag && pkt.dst.version === 6 ? 48 : pkt.dst.version === 6 ? 40 : 20);
    const base = pkt.frag ? pkt.frag.offset : 0;
    const whole = pkt.frag ? pkt.frag.whole : total;
    const n = Math.ceil(total / per);
    const out: Pkt[] = [];
    for (let i = 0; i < n; i++) out.push({ ...pkt, frag: { i: i + 1, n, offset: base + i * per, whole }, len: Math.min(per, total - i * per) });
    return out;
  }

  /** Forward a packet at a device (the sender itself, or a router on the way). */
  private forward(dev: string, pkt: Pkt, came: { l3: L3Iface; frame: Frame | null } | null): void {
    const sd = this.net.devices.get(dev) as SimDevice;
    const own = this.ownsAddress(dev, pkt.dst, pkt.vrf);
    if (!came) this.stamp(dev, pkt);
    if (own) {
      if (this.protocols) this.protocols.ip(dev, own, pkt);
      return;
    }
    const d = lookup(this.model, dev, pkt.vrf, pkt.dst, this.ctx(dev));
    // a tunnel's outer packet that is not routed in the model (or whose route leads back into the tunnel): its declared underlay
    const intoOwn = d.kind === 'forward' && d.hops.length > 0 && d.hops.every((h) => {
      const l = sd.l3.get(h.iface);
      return !!l && l.kind === 'tunnel' && !!pkt.encap;
    });
    if ((d.kind !== 'forward' || !d.hops.length || intoOwn) && !came && this.viaUnderlay(dev, pkt)) return;
    if (d.kind !== 'forward' || !d.hops.length) {
      // a blackhole route drops silently (no ICMP error: that is what it is for)
      const text = `dropped at ${dev}: ${d.kind === 'blackhole' ? 'a blackhole route (silently, no ICMP error)' : 'no route to ' + formatAddr(pkt.dst)}${pkt.vrf ? ' in VRF ' + pkt.vrf : ''} (${pkt.msg.label})`;
      this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', text);
      if (d.kind !== 'blackhole') {
        if (came) this.icmpError(dev, pkt, 'net', { from: came.l3 });
        else if (this.protocols && this.protocols.localError) this.protocols.localError(dev, pkt, 'net', `no route to ${formatAddr(pkt.dst)} (network unreachable)`);
      }
      return;
    }
    // equal-cost next hops: a flow keeps its path; at most the device's maximum ECMP paths are used
    const hops = sd.routes ? d.hops.slice(0, Math.max(1, this.params.num('ecmp-max', dev))) : d.hops;
    const hop = hops.length === 1 ? hops[0] : hops[hashIndex(pkt.flow, hops.length)];
    const out = sd.l3.get(hop.iface);
    if (!out) return;
    // a Security gateway (a filtering router) transfers only what its policy permits, after its transfer delay
    if (came && sd.caps.securityGateway && pkt.held !== dev) {
      const delay = this.sep.pass(sd.dev, pkt, came.l3.id, out.id);
      if (delay === null) return;
      if (delay > 0) {
        this.after(delay, () => this.forward(dev, { ...pkt, held: dev }, came));
        return;
      }
    }
    // a VPN gateway forwards only to and from its VPN
    if (came && sd.caps.vpnOnlyTransit && !this.vpnTransit(sd, came.l3, out, pkt)) return;
    // a firewall, or a router with a network policy, applies it to what it forwards (it logs and rejects itself)
    if (came && (sd.caps.firewallPolicy || !!sd.dev.policy) && this.protocols && this.protocols.filter && !this.protocols.filter(dev, pkt, came.l3, out, hop.gateway || null)) return;
    // then source NAT on the way out (its policy saw the packet as it came, its sessions stay those of the inside addresses):
    // a container bridge's masquerade, a NAT service's PAT / SNAT, the reply of a port forward
    if (came) pkt = this.snat(dev, came.l3, out, pkt);
    // a next hop outside the model (no device has it): a tunnel's outer packet takes its declared underlay; anything else leaves the model
    // (a redundancy group's virtual address is the model's even while no member holds it: ARP for it goes unanswered then)
    if (hop.gateway && !this.ownerOf(hop.gateway) && !virtualGateways(this.model).some((g) => compareAddr(g.address, hop.gateway as IpAddr) === 0)) {
      if (!came && this.viaUnderlay(dev, pkt)) return;
      this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `leaves the model at ${dev}: the next hop ${formatAddr(hop.gateway)} is outside it (${pkt.msg.label})`);
      return;
    }
    if (out.kind === 'tunnel') {
      if (came) this.routeNote(dev, pkt, came, out, '', hop.gateway);
      this.intoTunnel(dev, out, pkt);
      return;
    }
    // a directed broadcast (to a subnet of the egress interface): out as a broadcast only where the router forwards them
    if (came && pkt.dst.version === 4 && this.broadcastFor(out, pkt.dst)) {
      const db = this.params.get('directed-broadcast', dev, null, ifaceRef(dev, out.id));
      if (db.value !== 'on') {
        this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `${dev} drops the directed broadcast to ${formatAddr(pkt.dst)} (forward directed broadcasts ${resolvedText(db)}; RFC 2644): ${pkt.msg.label}`);
        return;
      }
      this.note('route', pkt.msg.protocol, dev, '', 'directed broadcast', '', `${dev} sends the directed broadcast to ${formatAddr(pkt.dst)} out of ${out.id} as a broadcast to ${BROADCAST} (forward directed broadcasts ${resolvedText(db)}): ${pkt.msg.label}`);
      this.emit(dev, out, { src: out.mac, dst: BROADCAST, msg: pkt.msg, ip: pkt });
      return;
    }
    const nh = hop.gateway || pkt.dst;
    // a next hop that is in the model but not on the egress interface's networks (a route out of an interface to an address behind a provider): a tunnel's outer packet takes its declared underlay
    if (!came && !out.addrs.some((a) => inNetAddr(a, nh)) && this.viaUnderlay(dev, pkt)) return;
    // the egress interface's MTU: a larger packet is fragmented (IPv4 without DF), else dropped with an ICMP error (Fragmentation Needed, Packet Too Big)
    const mtu = this.mtu(dev, out);
    const size = ipLen(pkt);
    let pkts = [pkt];
    // an IPv6 sender fragments its own packet (a fragment header each) to its interface's MTU or the path MTU it learned; routers never do
    const own6 = !came && pkt.dst.version === 6 && !pkt.df && !pkt.frag;
    const limit = own6 && pkt.pmtu ? Math.min(Number(mtu.value), pkt.pmtu) : Number(mtu.value);
    if (own6 && size > limit) {
      pkts = this.fragment(pkt, limit);
      this.note('route', pkt.msg.protocol, dev, '', 'fragmented', '', `${dev} fragments its own ${pkt.msg.label} (${size} bytes) into ${pkts.length} for ${pkt.pmtu && pkt.pmtu < Number(mtu.value) ? 'the path MTU it learned, ' + pkt.pmtu : 'the MTU of ' + out.id + ', ' + resolvedText(mtu)} (IPv6: the sender fragments): ${pkts.map((p) => (p.len as number) + 48).join(' + ')} bytes`);
    } else if (size > Number(mtu.value)) {
      if (pkt.dst.version === 6 || pkt.df) {
        const text = `${pkt.msg.label} (${size} bytes${pkt.dst.version === 4 ? ', DF set' : ''}) is larger than the MTU of ${dev}:${out.id}, ${resolvedText(mtu)}`;
        this.note('drop', pkt.msg.protocol, dev, '', pkt.msg.type, '', `dropped at ${dev}: ${text}${pkt.dst.version === 6 ? ' (IPv6 routers never fragment)' : ''}`);
        if (came) this.icmpError(dev, pkt, 'frag', { from: came.l3, mtu: Number(mtu.value) });
        else if (this.protocols && this.protocols.localError) this.protocols.localError(dev, pkt, 'frag', text, Number(mtu.value));
        return;
      }
      pkts = this.fragment(pkt, Number(mtu.value));
      this.note('route', pkt.msg.protocol, dev, '', 'fragmented', '', `${dev} fragments ${pkt.msg.label} (${size} bytes) into ${pkts.length} for the MTU of ${out.id}, ${resolvedText(mtu)}: ${pkts.map((p) => (p.len as number) + 20).join(' + ')} bytes`);
    }
    for (const p of pkts) {
      this.resolve(
        dev,
        out,
        nh,
        p,
        (mac) => {
          if (came && p === pkts[0]) this.routeNote(dev, pkt, came, out, mac, nh);
          this.emit(dev, out, { src: out.mac, dst: mac, msg: p.msg, ip: p });
        },
        !!came,
      );
    }
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
    for (const d of this.net.devices.values()) for (const l of d.l3.values()) if (this.hasOwn(l, a)) return d.id;
    if (this.protocols) for (const d of this.net.devices.values()) for (const l of d.l3.values()) if (this.protocols.owns(d.id, l.id).some((o) => compareAddr(o.addr, a) === 0)) return d.id;
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
    const port = linkPort(this.model, ll, lastEnd);
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
      const w = this.wire(h.link, h.fromEnd, frame, t);
      const f = this.flight(w.start, w.end, frame.msg, 'physical', { ref: 'link:' + h.link, from: h.fromEnd, to: h.fromEnd === 'a' ? 'b' : 'a' }, parent, frameEncap(frame));
      this.inspectable(f, frame, null);
      if (!this.cableUp(h.link) || w.lost) {
        f.dropped = (w.start + w.end) / 2;
        f.t1 = f.dropped;
        this.noteAt(w.start, 'drop', frame.msg.protocol, dev, owner.id, frame.msg.type, '', w.lost ? `lost on ${h.link} (packet loss ${resolvedText(this.loss(h.link))}): ${frame.msg.label}` : `dropped on ${h.link}: the cable is down (${frame.msg.label})`);
        return true;
      }
      parent = f.id;
      t = w.end;
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
          // over a tunnel that is coming up: it waits for it (the newest of a periodic message only)
          const rid = layer.relation;
          this.waitFor('rel:' + rid, `${layer.label} ${rid}`, dev, pkt.msg, () => this.intoTunnel(dev, tun, pkt), `${dev}|${pkt.msg.protocol}|${pkt.msg.type}|${formatAddr(pkt.dst)}`);
          return;
        }
      }
      const proto = layer.relation ? this.relProtocol(layer.relation) : 'gre';
      const msg: Msg = { ...pkt.msg, label: pkt.msg.label, detail: `${pkt.msg.detail} — in ${layers.map((l) => l.label).slice(0, layers.indexOf(layer) + 1).join(' in ')} (${formatAddr(e.src)} → ${formatAddr(e.dst)})`, data: { ...(pkt.msg.data || {}), encap: (((pkt.msg.data || {}) as { encap?: string[] }).encap || []).concat([layer.label]), outer: proto } };
      cur = { ...this.newPacket(e.src, e.dst, '', msg, rides.slice()), inner: cur, encap: layer.label, df: cur.df };
      // (the outer header the relation's own data has — IP-in-IP 4, WireGuard and VXLAN UDP to their port, IPsec ESP; a tunnel
      // without a relation: GRE)
      const o = layer.relation && this.protocols && this.protocols.outerL4 ? this.protocols.outerL4(layer.relation, dev) : undefined;
      cur.l4 = o || (/ESP/i.test(layer.label) ? { proto: 'other', num: 50 } : { proto: 'other', num: 47 });
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

  // ------------------------------------------------------------ ICMP errors

  /**
   * An ICMP (ICMPv6) error about a packet, from this device back to the
   * packet's source, routed like any packet: never about an ICMP error, a
   * fragment but the first, a broadcast or multicast packet (an IPv6 Packet
   * Too Big excepted, RFC 4443 §2.4), and not from a device that sends none;
   * at most one per the device's rate limit. Its source is the address of
   * the interface it is sent out of, towards the packet's source (RFC 1812
   * §4.3.2.4), else of the one the packet came in on.
   */
  icmpError(dev: string, pkt: Pkt, kind: IcmpKind, o: { from?: L3Iface; mtu?: number } = {}): void {
    const v = pkt.src.version;
    const why = (text: string): void => this.note('note', 'icmp', dev, '', 'no ICMP error', '', `${dev} sends no ICMP error about ${pkt.msg.label}: ${text}`);
    if (pkt.l4 && pkt.l4.proto === 'icmp' && pkt.l4.icmpType !== undefined && (v === 4 ? [3, 4, 5, 11, 12].indexOf(pkt.l4.icmpType) >= 0 : pkt.l4.icmpType < 128)) return;
    if (pkt.frag && pkt.frag.offset > 0) return;
    if (isMulticastIp(pkt.dst) && !(kind === 'frag' && v === 6)) return why('it went to a multicast group');
    if (this.isBroadcastAddr(pkt.dst)) return why('it was a broadcast');
    if (isMulticastIp(pkt.src) || pkt.src.bytes.every((b) => b === 0)) return;
    // (the interface the packet came in on decides: Cisco "no ip unreachables" is per interface)
    const on = this.params.get('icmp-errors', dev, null, o.from ? ifaceRef(dev, o.from.id) : null);
    if (on.value !== 'on') return why(`send ICMP errors ${resolvedText(on)}`);
    const rl = this.params.get('icmp-rate', dev);
    const last = this.icmpLast.get(dev);
    if (Number(rl.value) > 0 && last !== undefined && this.now - last < Number(rl.value)) return why(`rate limit, one per ${resolvedText(rl)}`);
    const sd = this.net.devices.get(dev) as SimDevice;
    const pick = (l?: L3Iface): IpAddr | undefined => {
      const a = l && this.isL3Up(dev, l.id) ? l.addrs.find((x) => x.addr.version === v) : undefined;
      return a ? a.addr : undefined;
    };
    const back = lookup(this.model, dev, pkt.vrf, pkt.src, this.ctx(dev));
    let src = back.kind === 'forward' && back.hops.length ? pick(sd.l3.get(back.hops[0].iface)) : undefined;
    if (!src) src = pick(o.from);
    for (const l of Array.from(sd.l3.values()).sort((a, b) => Number(a.kind === 'loopback') - Number(b.kind === 'loopback') || cmp(a.id, b.id))) if (!src) src = pick(l);
    if (!src) return;
    this.icmpLast.set(dev, this.now);
    const t = icmpType(kind, v);
    const quote: Quote = { src: formatAddr(pkt.src), dst: formatAddr(pkt.dst), ttl: pkt.ttl, proto: pkt.l4 ? pkt.l4.proto : 'ip', sport: pkt.l4 ? pkt.l4.sport : undefined, dport: pkt.l4 ? pkt.l4.dport : undefined, echoId: pkt.l4 && pkt.l4.proto === 'icmp' ? pkt.l4.echoId : undefined, num: pkt.l4 ? pkt.l4.num : undefined, pkt: pkt.id, flow: pkt.flow };
    const name = v === 4 ? 'ICMP' : 'ICMPv6';
    const label = `${name} ${t.short}${kind === 'frag' ? ` (MTU ${o.mtu})` : ''} from ${formatAddr(src)}`;
    const detail = `${dev} (${formatAddr(src)}) → ${formatAddr(pkt.src)}: ${name} ${t.name} (type ${t.type}, code ${t.code}${kind === 'frag' ? ', MTU ' + o.mtu : ''}) about ${quoteText(quote)}: ${pkt.msg.label}`;
    const msg: Msg = { protocol: 'icmp', type: t.short, label, detail, data: { from: dev, error: kind } };
    const err = this.newPacket(src, pkt.src, pkt.vrf, msg);
    err.l4 = { proto: 'icmp', num: v === 4 ? 1 : 58, icmpType: t.type, icmpCode: t.code, icmpName: t.name, quote, mtu: o.mtu };
    err.len = 8 + (v === 4 ? 28 : 48);
    this.note('message', 'icmp', dev, this.ownerOf(pkt.src) || '', t.short, '', detail, this.now, msg);
    this.send(dev, err);
  }

  // ------------------------------------------------------------ ARP and neighbour discovery

  /** The ARP timeout of an interface (ms, unscaled): its own, else its device's, the simulation's, the default. */
  arpTimeout(dev: string, iface: string): number {
    return this.params.num('arp-timeout', dev, null, ifaceRef(dev, iface));
  }

  /** The IPv6 neighbour reachable time of an interface (ms, unscaled). */
  ndReachable(dev: string, iface: string): number {
    return this.params.num('ndp-reachable', dev, null, ifaceRef(dev, iface));
  }

  /** The retransmit interval of an interface's ARP Requests and Neighbor Solicitations (ms), and how many go out before an entry is given up. */
  private retrans(dev: string, iface: string): number {
    return this.params.num('arp-retransmit', dev, null, ifaceRef(dev, iface));
  }

  private retries(dev: string, iface: string): number {
    return this.params.num('arp-retries', dev, null, ifaceRef(dev, iface));
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
  resolve(dev: string, l3: L3Iface, ip: IpAddr, pkt: Pkt, send: (mac: string) => void, fwd = false): void {
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
        this.tableNote(dev, e, 'DELAY', `used while STALE: probe in ${fmtSec(ND_DELAY_DEFAULT * 1000)} unless confirmed`);
      }
      send(e.mac);
      return;
    }
    // a unicast packet waits for its next hop's address (each next hop on its own; those for the same one are sent together)
    const what = `${ip.version === 4 ? 'ARP' : 'NDP'} ${formatAddr(ip)}`;
    const since = this.now;
    const go = (mac: string): void => {
      pkt.msg.waited = (pkt.msg.waited || []).concat([`${what}: ${durationText(this.now - since)}`]);
      send(mac);
    };
    this.note('wait', pkt.msg.protocol, dev, '', 'waiting', '', `${pkt.msg.label} waiting for ${what}`);
    if (e) {
      e.queue.push({ pkt, send: go, fwd });
      return;
    }
    const n: ArpEntry = { ip, ipText: formatAddr(ip), mac: '', iface: l3.id, vlan: l3.vlan, type: 'incomplete', state: 'INCOMPLETE', learned: this.now, refreshed: this.now, timer: this.now + this.retrans(dev, l3.id), tries: 1, used: true, queue: [{ pkt, send: go, fwd }], sentAt: this.now };
    tab.set(key, n);
    this.tableNote(dev, n, 'INCOMPLETE', `${pkt.msg.label} waits for ${ip.version === 4 ? 'ARP' : 'neighbour discovery'}`);
    this.solicit(dev, l3, ip, '');
  }

  /** An ARP Request (or Neighbor Solicitation): broadcast / to the solicited-node address, or unicast to `mac` (a refresh, a probe). */
  private solicit(dev: string, l3: L3Iface, ip: IpAddr, mac: string): void {
    const ll = ip.version === 6 && l3.ll && (isLinkLocal6(ip) || !l3.addrs.some((a) => a.addr.version === 6)) ? l3.ll : undefined;
    const src = ll || l3.addrs.find((a) => a.addr.version === ip.version && inNetAddr(a, ip)) || l3.addrs.find((a) => a.addr.version === ip.version) || (ip.version === 4 ? this.borrowed(dev, l3) : undefined);
    if (!src) return;
    const sim = l3.macSimulated ? ' (simulated)' : '';
    if (ip.version === 4) {
      const label = `ARP Request (${mac ? 'unicast' : 'broadcast'}): who has ${formatAddr(ip)}?`;
      const msg: Msg = { protocol: 'arp', type: 'ARP Request', label, detail: `ARP Request (${mac ? 'unicast refresh' : 'broadcast'}): who has ${formatAddr(ip)}? Tell ${formatAddr(src.addr)} — sender ${formatAddr(src.addr)} at ${l3.mac}${sim}, target ${formatAddr(ip)} at 00:00:00:00:00:00, to ${mac || BROADCAST}${l3.vlan ? ', VLAN ' + l3.vlan : ''}` };
      this.note('message', msg.protocol, dev, '', msg.type, '', msg.detail, this.now, msg);
      this.emit(dev, l3, { src: l3.mac, dst: mac || BROADCAST, msg, arp: { op: 'request', sha: l3.mac, spa: src.addr, tha: '00:00:00:00:00:00', tpa: ip } });
      return;
    }
    const sn = solicitedNode(ip);
    const msg: Msg = { protocol: 'ndp', type: 'Neighbor Solicitation', label: `NDP NS Who has ${formatAddr(ip)}?`, detail: `Neighbor Solicitation (ICMPv6 135): ${formatAddr(src.addr)} at ${l3.mac}${sim} asks for ${formatAddr(ip)} — to ${mac ? 'unicast ' + mac : formatAddr(sn) + ' (' + multicastMac(sn) + ')'}` };
    const pkt = this.newPacket(src.addr, mac ? ip : sn, l3.vrf, msg, [], 255);
    pkt.l4 = { proto: 'icmp', num: 58, icmpType: 135, icmpCode: 0, icmpName: 'Neighbor Solicitation' };
    pkt.len = 32;
    this.note('message', msg.protocol, dev, '', msg.type, '', msg.detail, this.now, msg);
    this.emit(dev, l3, { src: l3.mac, dst: mac || multicastMac(sn), msg, nd: { op: 'NS', src: src.addr, target: ip, lladdr: l3.mac, solicited: false }, ip: pkt });
  }

  /**
   * The address an unnumbered interface (no IPv4 address of its own) uses:
   * the device's loopback address in its VRF (as `ip unnumbered Loopback0`),
   * for its ARP requests and the ARP requests it answers.
   */
  private borrowed(dev: string, l3: L3Iface): SimAddr | undefined {
    if (l3.kind === 'loopback' || l3.addrs.some((a) => a.addr.version === 4)) return undefined;
    const sd = this.net.devices.get(dev) as SimDevice;
    const loops = Array.from(sd.l3.values()).filter((l) => l.kind === 'loopback' && l.vrf === l3.vrf).sort((x, y) => cmp(x.id, y.id));
    for (const l of loops) for (const a of l.addrs) if (a.addr.version === 4) return a;
    return undefined;
  }

  private arpReceive(dev: string, l3: L3Iface, frame: Frame, a: ArpPdu): void {
    const tab = this.arp.get(dev) as Map<string, ArpEntry>;
    const key = this.entryKey(l3.id, a.spa);
    const e = tab.get(key);
    const lent = this.borrowed(dev, l3);
    const ownTarget = l3.addrs.some((x) => compareAddr(x.addr, a.tpa) === 0) || (!!lent && compareAddr(lent.addr, a.tpa) === 0);
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
      this.note('message', msg.protocol, dev, '', msg.type, '', msg.detail, this.now, msg);
      this.emit(dev, l3, { src: mac, dst: a.sha, msg, arp: { op: 'reply', sha: mac, spa: a.tpa, tha: a.sha, tpa: a.spa } });
      return;
    }
    if (a.op === 'reply' && compareAddr(a.tpa, a.spa) !== 0 && (ownTarget || e)) {
      this.learnEntry(dev, l3, a.spa, a.sha, isVirtual(a.sha) ? 'virtual' : 'dynamic', 'ARP Reply');
      return;
    }
    if (e && e.mac && e.mac !== a.sha) this.learnEntry(dev, l3, a.spa, a.sha, isVirtual(a.sha) ? 'virtual' : 'dynamic', 'ARP from the owner');
  }

  private ndReceive(dev: string, l3: L3Iface, frame: Frame, nd: NdPdu): void {
    const tab = this.arp.get(dev) as Map<string, ArpEntry>;
    if (nd.op === 'NS') {
      const own = this.hasOwn(l3, nd.target) && !(this.v6Hook && this.v6Hook.unusable(dev, l3, nd.target));
      const vip = this.protocols ? this.protocols.owns(dev, l3.id).find((o) => compareAddr(o.addr, nd.target) === 0) : undefined;
      if (nd.dad) {
        // duplicate address detection by another node: the owner defends its address (an NA to all-nodes, RFC 4861 §7.2.4);
        // a node probing the same tentative address learns it is a duplicate (RFC 4862 §5.4.3)
        if (this.v6Hook) this.v6Hook.dadProbe(dev, l3, nd.target);
        if (!own) return;
        const all = parseAddress('ff02::1') as IpAddr;
        const msg: Msg = { protocol: 'ndp', type: 'Neighbor Advertisement', label: `NDP NA ${formatAddr(nd.target)} is in use`, detail: `Neighbor Advertisement (ICMPv6 136, not solicited, override): ${formatAddr(nd.target)} is at ${l3.mac} — to ff02::1 (all nodes): it defends its address against a duplicate address detection probe` };
        const pkt = this.newPacket(nd.target, all, l3.vrf, msg, [], 255);
        pkt.l4 = { proto: 'icmp', num: 58, icmpType: 136, icmpCode: 0, icmpName: 'Neighbor Advertisement' };
        pkt.len = 32;
        this.note('message', 'ndp', dev, '', msg.type, '', msg.detail, this.now, msg);
        this.emit(dev, l3, { src: l3.mac, dst: multicastMac(all), msg, nd: { op: 'NA', src: nd.target, target: nd.target, lladdr: l3.mac, solicited: false }, ip: pkt });
        return;
      }
      if (!own && !vip) return;
      // RFC 4861 7.2.3: the solicitation's source goes in as STALE (created or updated)
      const k = this.entryKey(l3.id, nd.src);
      const e = tab.get(k);
      if (!e || e.mac !== nd.lladdr) this.learnEntry(dev, l3, nd.src, nd.lladdr, 'dynamic', 'Neighbor Solicitation', 'STALE');
      const mac = vip ? vip.mac : l3.mac;
      const sim = !vip && l3.macSimulated ? ' (simulated)' : vip ? ' (virtual MAC)' : '';
      const msg: Msg = { protocol: 'ndp', type: 'Neighbor Advertisement', label: `NDP NA ${formatAddr(nd.target)} is at ${shortMac(mac)}`, detail: `Neighbor Advertisement (ICMPv6 136, solicited): ${formatAddr(nd.target)} is at ${mac}${sim} — unicast to ${formatAddr(nd.src)} at ${nd.lladdr}` };
      const pkt = this.newPacket(nd.target, nd.src, l3.vrf, msg, [], 255);
      pkt.l4 = { proto: 'icmp', num: 58, icmpType: 136, icmpCode: 0, icmpName: 'Neighbor Advertisement' };
      pkt.len = 32;
      this.note('message', msg.protocol, dev, '', msg.type, '', msg.detail, this.now, msg);
      this.emit(dev, l3, { src: mac, dst: nd.lladdr, msg, nd: { op: 'NA', src: nd.target, target: nd.target, lladdr: mac, solicited: true }, ip: pkt });
      return;
    }
    // an advertisement (RFC 4861 §7.2.5; its Override flag set, as every NA of the simulation): it updates an entry, never
    // creates one — Solicited: REACHABLE; not solicited (an unsolicited one, or one defending an address against a DAD
    // probe): STALE when it brings another link-layer address (or completes an incomplete entry), else the entry stays as it is
    if (this.v6Hook) this.v6Hook.advert(dev, l3, nd.target, nd.lladdr);
    const k = this.entryKey(l3.id, nd.target);
    const e = tab.get(k);
    if (!e) return;
    if (nd.solicited) {
      this.learnEntry(dev, l3, nd.target, nd.lladdr, isVirtual(nd.lladdr) ? 'virtual' : 'dynamic', 'Neighbor Advertisement', 'REACHABLE');
      return;
    }
    if (e.mac !== nd.lladdr) this.learnEntry(dev, l3, nd.target, nd.lladdr, isVirtual(nd.lladdr) ? 'virtual' : nd.unsolicited ? 'gratuitous' : 'dynamic', nd.unsolicited ? 'unsolicited Neighbor Advertisement' : 'Neighbor Advertisement', 'STALE');
  }

  /** An entry is learned or refreshed; waiting packets go. */
  private learnEntry(dev: string, l3: L3Iface, ip: IpAddr, mac: string, type: ArpType, why: string, ndState: NdState = 'REACHABLE'): void {
    const tab = this.arp.get(dev) as Map<string, ArpEntry>;
    const key = this.entryKey(l3.id, ip);
    let e = tab.get(key);
    const was = e ? e.type + '/' + e.state + '/' + e.mac : '';
    if (!e) {
      e = { ip, ipText: formatAddr(ip), mac, iface: l3.id, vlan: l3.vlan, type, state: ip.version === 6 ? ndState : 'VALID', learned: this.now, refreshed: this.now, timer: 0, tries: 0, used: false, queue: [], sentAt: 0 };
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
    if (this.protocols && this.protocols.sweep) this.protocols.sweep();
    for (const [dev, tab] of this.arp) {
      for (const [k, e] of Array.from(tab)) {
        const l3 = (this.net.devices.get(dev) as SimDevice).l3.get(e.iface);
        if (!l3) continue;
        if (e.type === 'incomplete' || e.state === 'PROBE' || e.state === 'REFRESHING') {
          // the retransmit interval in effect now (a change applies to the next request)
          e.timer = e.sentAt + this.retrans(dev, e.iface);
          if (t < e.timer) continue;
          if (e.tries >= this.retries(dev, e.iface)) {
            tab.delete(k);
            this.tableNote(dev, e, 'removed', `${e.ipText} removed: no answer to ${e.tries} ${e.ip.version === 4 ? 'ARP Requests' : 'solicitations'}${e.queue.length ? '; ' + e.queue.length + ' waiting packet' + (e.queue.length === 1 ? '' : 's') + ' dropped' : ''}`);
            for (const w of e.queue) {
              this.withTest(w.pkt.msg.test, () => {
                this.note('drop', w.pkt.msg.protocol, dev, '', w.pkt.msg.type, '', `dropped at ${dev}: ${e.ipText} could not be resolved (${w.pkt.msg.label})`);
                if (w.fwd) this.icmpError(dev, w.pkt, 'host', { from: l3 });
                else if (this.protocols && this.protocols.localError) this.protocols.localError(dev, w.pkt, 'host', `${e.ipText} does not answer ${e.ip.version === 4 ? 'ARP' : 'neighbour solicitations'} (host unreachable)`);
              });
            }
            continue;
          }
          e.tries++;
          e.sentAt = t;
          e.timer = t + this.retrans(dev, e.iface);
          // a retry for a Send test's packet is the test's too
          const tq = e.queue.find((w) => w.pkt.msg.test !== undefined);
          this.withTest(tq ? tq.pkt.msg.test : null, () => this.solicit(dev, l3, e.ip, e.type === 'incomplete' ? '' : e.mac));
          continue;
        }
        if (e.ip.version === 4) {
          const life = this.arpTimeout(dev, e.iface) / this.timerScale;
          if (t - e.refreshed < life) continue;
          if (e.used) {
            // used since its last refresh: refreshed by a unicast ARP Request before it goes
            e.state = 'REFRESHING';
            e.tries = 1;
            e.sentAt = t;
            e.timer = t + this.retrans(dev, e.iface);
            this.tableNote(dev, e, 'refreshing', `${e.ipText}: timeout reached while in use — refreshing (unicast ARP Request)`);
            this.solicit(dev, l3, e.ip, e.mac);
          } else {
            tab.delete(k);
            this.tableNote(dev, e, 'expired', `${e.ipText} expired (timeout ${resolvedText(this.params.get('arp-timeout', dev, null, ifaceRef(dev, e.iface)))}${this.timerScale !== 1 ? ', timer scale 1:' + this.timerScale : ''})`);
          }
          continue;
        }
        if (e.state === 'REACHABLE') {
          const life = this.ndReachable(dev, e.iface) / this.timerScale;
          if (t - e.refreshed >= life) {
            e.state = 'STALE';
            this.tableNote(dev, e, 'STALE', `${e.ipText}: reachable time over without confirmation`);
          }
        } else if (e.state === 'DELAY' && t >= e.timer) {
          e.state = 'PROBE';
          e.tries = 1;
          e.sentAt = t;
          e.timer = t + this.retrans(dev, e.iface);
          this.tableNote(dev, e, 'PROBE', `${e.ipText}: probing with unicast Neighbor Solicitations`);
          this.solicit(dev, l3, e.ip, e.mac);
        }
      }
    }
    for (const [dev, tab] of this.macs) {
      const aging = this.macAging(dev);
      for (const [k, e] of Array.from(tab)) {
        if (e.type !== 'dynamic' || t - e.refreshed < aging) continue;
        tab.delete(k);
        this.macFullNoted.delete(dev);
        this.note('table', 'stp', dev, '', `MAC entry ${e.mac}`, 'aged out', `${dev} MAC table: ${e.mac} (VLAN ${e.vlan || 'untagged'}, port ${e.port}) aged out after ${resolvedText(this.params.get('mac-aging', dev))}${this.timerScale !== 1 ? ' (timer scale 1:' + this.timerScale + ')' : ''}`);
      }
    }
  }

  // ------------------------------------------------------------ gratuitous ARP

  /** A gratuitous ARP (or unsolicited Neighbor Advertisement) for an address on an interface, with a MAC (a virtual one for a new master). */
  gratuitous(dev: string, l3: L3Iface, addr: IpAddr, mac: string, why: string, protocol = 'garp'): void {
    if (addr.version === 4) {
      const msg: Msg = { protocol, type: 'Gratuitous ARP', label: `ARP Gratuitous ${formatAddr(addr)} is at ${shortMac(mac)}`, detail: `Gratuitous ARP (${why}): sender ${formatAddr(addr)} at ${mac}${this.simulatedMac(mac) ? ' (simulated)' : isVirtual(mac) ? ' (virtual MAC)' : ''}, target ${formatAddr(addr)} — to ${BROADCAST}` };
      this.note('message', msg.protocol, dev, '', msg.type, '', msg.detail, this.now, msg);
      this.emit(dev, l3, { src: mac, dst: BROADCAST, msg, arp: { op: 'request', sha: mac, spa: addr, tha: '00:00:00:00:00:00', tpa: addr, gratuitous: true } });
      return;
    }
    const all = parseAddr('ff02::1') as IpAddr;
    const msg: Msg = { protocol, type: 'Unsolicited NA', label: `NDP NA ${formatAddr(addr)} is at ${shortMac(mac)}`, detail: `Unsolicited Neighbor Advertisement (${why}): ${formatAddr(addr)} is at ${mac} — to ff02::1 (33:33:00:00:00:01)` };
    const pkt = this.newPacket(addr, all, l3.vrf, msg, [], 255);
    pkt.l4 = { proto: 'icmp', num: 58, icmpType: 136, icmpCode: 0, icmpName: 'Neighbor Advertisement' };
    pkt.len = 32;
    this.note('message', msg.protocol, dev, '', msg.type, '', msg.detail, this.now, msg);
    this.emit(dev, l3, { src: mac, dst: multicastMac(all), msg, nd: { op: 'NA', src: addr, target: addr, lladdr: mac, solicited: false, unsolicited: true }, ip: pkt });
  }

  // ------------------------------------------------------------ network events

  /** The cables at a device's ports, by id. */
  private linksOf(dev: string): string[] {
    const out: string[] = [];
    for (const [id, l] of this.net.links) if (l.a.device === dev || l.b.device === dev) out.push(id);
    return out.sort(cmp);
  }

  /** Did the port's own device take its cable down (shut, powered off)? Then it knows at once. */
  private localCause(dev: string, key: string): boolean {
    return this.shutPorts.has(key) || (this.off.has(dev) && !this.bypass.has(dev));
  }

  /** Is a cable physically up: nothing takes it down (a failure, flapping, a shut port, a device powered off)? */
  private physUp(id: string): boolean {
    if (this.failedLinks.has(id) || this.parked.has(id)) return false;
    const fl = this.flaps.get(id);
    if (fl && fl.down) return false;
    const l = this.net.links.get(id) as Link;
    for (const e of [l.a, l.b]) {
      if (this.off.has(e.device) && !this.bypass.has(e.device)) return false;
      if (this.shutPorts.has(portKey(e.device, e.iface || '@' + id))) return false;
    }
    return true;
  }

  /** The link-up delay of a cable: its access point's association time for a wireless link, else the simulation's. */
  private linkUpDelay(id: string): Resolved {
    const l = this.net.links.get(id) as Link;
    if (l.medium === 'wireless') {
      for (const e of [l.a, l.b]) {
        const d = this.model.index.devices.get(e.device);
        if (d && capabilities(d).wirelessAccess) return this.params.get('ap-association', d.id);
      }
    }
    // each end negotiates: the cable is up when the slower port is
    const ends = [l.a, l.b].map((e) => this.params.get('link-up-delay', e.device, null, ifaceRef(e.device, e.iface || '@' + id)));
    return Number(ends[1].value) > Number(ends[0].value) ? ends[1] : ends[0];
  }

  /**
   * A cable's state follows what takes it down. Going dark it drops what is
   * on it at once, and its ports notice after the loss-of-signal detection
   * time (a port whose own device took it down: at once). Coming back
   * before they noticed, it simply carries on; else its ports come up after
   * the link-up delay.
   */
  private updateCable(id: string): void {
    const l = this.net.links.get(id) as Link;
    const was = this.cable.get(id) || 'up';
    const ends = [l.a, l.b].map((e) => ({ dev: e.device, port: linkPort(this.model, l, e), key: portKey(e.device, linkPort(this.model, l, e)) }));
    if (!this.physUp(id)) {
      if (was !== 'down') {
        this.cable.set(id, 'down');
        this.stateVersion++;
        this.cut('link:' + id);
      }
      for (const x of ends) {
        const det = this.params.get('los-detect', x.dev, null, ifaceRef(x.dev, x.port));
        if (this.carrier.get(x.key) === false || this.carrierToken.has(x.key)) {
          // already down, or noticing: a device that takes it down itself knows at once
          if (this.carrier.get(x.key) !== false && this.localCause(x.dev, x.key)) this.setCarrier(x.dev, x.port, false, id, null);
          continue;
        }
        if (this.localCause(x.dev, x.key) || Number(det.value) <= 0) this.setCarrier(x.dev, x.port, false, id, this.localCause(x.dev, x.key) ? null : det);
        else {
          const tok = ++this.tokens;
          this.carrierToken.set(x.key, tok);
          this.at(this.now + Number(det.value), () => {
            if (this.carrierToken.get(x.key) !== tok) return;
            this.carrierToken.delete(x.key);
            if (!this.physUp(id)) this.setCarrier(x.dev, x.port, false, id, det);
          });
        }
      }
      return;
    }
    if (was === 'up' || was === 'negotiating') return;
    for (const x of ends) this.carrierToken.delete(x.key);
    if (!ends.some((x) => this.carrier.get(x.key) === false)) {
      // back before its ports noticed the loss: they never went down
      this.cable.set(id, 'up');
      this.stateVersion++;
      this.note('link', 'link', l.a.device, l.b.device, 'Cable up', 'up', `Cable ${id} is up again before its ports noticed the loss (loss-of-signal detection ${resolvedText(this.params.get('los-detect'))})`);
      return;
    }
    this.cable.set(id, 'negotiating');
    this.stateVersion++;
    const d = this.linkUpDelay(id);
    // a wireless client waits for its access point's next beacon before it associates
    const ap = l.medium === 'wireless' ? [l.a.device, l.b.device].find((x) => capabilities(this.model.index.devices.get(x) || { type: '' }).wirelessAccess) : undefined;
    const beacon = ap ? this.beaconWait(ap, this.now, (l.a.device === ap ? l.a : l.b).iface || '@' + id) : 0;
    const tok = ++this.tokens;
    this.carrierToken.set('link:' + id, tok);
    this.note('link', 'link', l.a.device, l.b.device, 'Cable negotiating', 'negotiating', `Cable ${id} is physically up again: its ports come up after ${beacon ? `the next beacon (${durationText(beacon)}, beacon interval ${resolvedText(this.params.get('ap-beacon', ap as string))}) and ` : ''}${resolvedText(d)} (${d.def.label.toLowerCase()})`);
    if (ap) this.wifiActive.set(id, this.now + beacon + Number(d.value));
    this.at(this.now + beacon + Number(d.value), () => {
      if (this.carrierToken.get('link:' + id) !== tok) return;
      this.carrierToken.delete('link:' + id);
      if (!this.physUp(id)) return;
      this.cable.set(id, 'up');
      this.stateVersion++;
      for (const x of ends) if (this.carrier.get(x.key) === false && !this.localCause(x.dev, x.key)) this.setCarrier(x.dev, x.port, true, id, d);
    });
  }

  /** A port's carrier as its device sees it changes: tables, the spanning tree, interfaces and routing follow. */
  private setCarrier(dev: string, port: string, up: boolean, link: string, why: Resolved | null): void {
    const key = portKey(dev, port);
    if (up) this.carrier.delete(key);
    else this.carrier.set(key, false);
    this.stateVersion++;
    if (!this.off.has(dev) || this.bypass.has(dev)) {
      const first = up && !this.cameUp.has('port:' + key);
      if (up) this.cameUp.add('port:' + key);
      const how = up ? `carrier${first ? '' : ' again'} (${why ? why.def.label.toLowerCase() + ' ' + resolvedText(why) : 'up'})` : why ? `lost carrier: loss of signal detected after ${resolvedText(why)}` : 'is down';
      this.note('link', 'link', dev, '', `${port} ${up ? 'up' : 'down'}`, up ? 'up' : 'down', `${dev}:${port} ${up ? 'has ' + how : how} (cable ${link})`);
    }
    if (!up) this.flushPort(dev, port, `its cable ${link} went down`);
    this.uplinkChange(dev, port, up);
    this.recomputeTrees([link]);
    if (up) this.stpPortUp(dev, port, link);
    this.syncInterfaces();
    this.routingChanged();
    if (this.protocols) this.protocols.linkChange('link:' + link, this.linkUp(link));
  }

  /** Fail a cable or relation ("link:x" / "relation:x"); false when it is failed already or not there. */
  fail(ref: string): boolean {
    const id = ref.slice(ref.indexOf(':') + 1);
    if (ref.indexOf('link:') === 0) {
      if (!this.net.links.has(id) || this.failedLinks.has(id)) return false;
      this.failedLinks.set(id, this.now);
      this.note('link', 'link', '', '', 'Cable failed', 'down', `Cable ${id} fails at t = ${fmtSec(this.now)}`);
      this.updateCable(id);
    } else if (ref.indexOf('relation:') === 0) {
      if (!this.model.index.relations.has(id) || this.failedRels.has(id)) return false;
      this.failedRels.set(id, this.now);
      this.note('link', 'link', '', '', 'Relation failed', 'down', `Relation ${id} fails at t = ${fmtSec(this.now)}`);
      this.syncInterfaces();
      this.routingChanged();
      if (this.protocols) this.protocols.linkChange(ref, false);
    } else return false;
    this.stateVersion++;
    return true;
  }

  /** Restore a failed cable or relation. */
  restore(ref: string): boolean {
    const id = ref.slice(ref.indexOf(':') + 1);
    if (ref.indexOf('link:') === 0) {
      if (!this.failedLinks.delete(id)) return false;
      this.note('link', 'link', '', '', 'Cable restored', 'up', `Cable ${id} is restored at t = ${fmtSec(this.now)}`);
      this.updateCable(id);
    } else if (ref.indexOf('relation:') === 0) {
      if (!this.failedRels.delete(id)) return false;
      this.note('link', 'link', '', '', 'Relation restored', 'up', `Relation ${id} is restored at t = ${fmtSec(this.now)}`);
      this.syncInterfaces();
      this.routingChanged();
      if (this.protocols) this.protocols.linkChange(ref, true);
    } else return false;
    this.stateVersion++;
    return true;
  }

  /**
   * The cable of a flapping target: a cabled port ("iface:dev:port") only.
   * Flapping is an interface's action: a cable ("link:x") is no target (it
   * goes down and up as a consequence of its ports).
   */
  private flapLink(ref: string): string | null {
    if (ref.indexOf('iface:') === 0) {
      const rest = ref.slice(6);
      const i = rest.indexOf(':');
      const p = this.simPort(rest.slice(0, i), rest.slice(i + 1));
      const e = this.net.ends.get(portKey(p.device, p.port));
      return e ? e.link : null;
    }
    return null;
  }

  /** Where a model port's cable ends in the simulation (a host's uplink at its virtual switch, a passthrough port at its VM). */
  simPort(dev: string, port: string): { device: string; port: string } {
    return this.net.moved.get(portKey(dev, port)) || { device: dev, port };
  }

  /** The model's name of a simulated port key ("hv1/vSwitch0|vmnic0" → "hv1:vmnic0"). */
  private modelPortRef(key: string): string {
    for (const [k, v] of this.net.moved) if (portKey(v.device, v.port) === key) return 'iface:' + portRefOf(k);
    return 'iface:' + portRefOf(key);
  }

  /**
   * Start flapping an interface (a cabled port, "iface:dev:port"): it goes down for the flapping down time, up
   * for the up time, for the cycles (0: until stopped); its cable follows (down while the port is). A cable is
   * no target, and one cable flaps from one of its ends at a time.
   */
  startFlap(ref: string, why = '', configured = false): boolean {
    const link = this.flapLink(ref);
    if (!link || this.flaps.has(link)) return false;
    const fl: Flap = { link, ref, since: this.now, down: false, done: 0, token: ++this.tokens };
    if (configured) fl.configured = true;
    this.flaps.set(link, fl);
    const p = (k: string): string => resolvedText(this.params.get(k));
    this.note('link', 'link', '', '', 'Flapping', 'flapping', `Port ${ref.slice(6)} starts flapping${why} (its cable ${link} follows): down ${p('flap-down')}, up ${p('flap-up')}, ${p('flap-cycles')} cycles`);
    this.stateVersion++;
    this.flapStep(fl);
    return true;
  }

  private flapStep(fl: Flap): void {
    if (this.flaps.get(fl.link) !== fl) return;
    fl.down = !fl.down;
    if (!fl.down) fl.done++;
    // (a transition of flapping started from outside changes the network: the display's steady state starts afresh;
    // the model's own flapping is the scenario)
    if (!fl.configured) this.flapTransitions++;
    const cycles = this.params.num('flap-cycles');
    this.note('link', 'link', '', '', fl.down ? 'Flap down' : 'Flap up', fl.down ? 'down' : 'up', `Flapping port ${fl.ref.slice(6)}: ${fl.down ? 'down' : 'up'}, its cable ${fl.link} with it (cycle ${fl.done + (fl.down ? 1 : 0)}${cycles ? ' of ' + cycles : ''})`);
    this.updateCable(fl.link);
    this.stateVersion++;
    if (!fl.down && cycles > 0 && fl.done >= cycles) {
      this.flaps.delete(fl.link);
      fl.ended = 'done';
      fl.endedAt = this.now;
      this.note('link', 'link', '', '', 'Flapping over', 'up', `Port ${fl.ref.slice(6)} stops flapping after ${fl.done} cycle${fl.done === 1 ? '' : 's'}`);
      return;
    }
    this.at(this.now + this.params.num(fl.down ? 'flap-down' : 'flap-up'), () => this.flapStep(fl));
  }

  /** The flapping going on now on a port's cable (from this port or its other end; the object stays the same until it ends). */
  flapOf(ref: string): Flap | undefined {
    const link = this.flapLink(ref);
    return link ? this.flaps.get(link) : undefined;
  }

  /**
   * An interface's state as Interface actions shows it: administratively (shut or not) and in operation
   * (its cable up, down or coming up; a logical interface up or down), with what holds it down.
   */
  portStatus(dev: string, iface: string): { admin: 'up' | 'down'; oper: 'up' | 'down' | 'negotiating' | 'no cable'; why: string } {
    const admin = this.isShut(dev, iface) ? 'down' : 'up';
    const at = this.simPort(dev, iface);
    const e = this.net.ends.get(portKey(at.device, at.port));
    if (!e) {
      const sd = this.net.devices.get(dev);
      if (sd && sd.l3.has(iface)) {
        const up = admin === 'up' && this.isL3Up(dev, iface);
        return { admin, oper: up ? 'up' : 'down', why: admin === 'down' ? 'shut' : up ? '' : this.off.has(dev) ? 'the device is off' : 'what it runs over is down' };
      }
      return { admin, oper: 'no cable', why: 'no cable' };
    }
    const id = e.link;
    const st = this.cable.get(id) || 'up';
    if (st === 'up') return { admin, oper: 'up', why: '' };
    const l = this.net.links.get(id) as Link;
    const far = l.a.device === at.device && (l.a.iface || '') === at.port ? l.b : l.a;
    const fl = this.flaps.get(id);
    const why =
      admin === 'down'
        ? 'shut'
        : this.failedLinks.has(id)
          ? `cable ${id} failed`
          : fl && fl.down
            ? 'flapping (down)'
            : this.off.has(dev)
              ? 'the device is off'
              : this.off.has(far.device) && !this.bypass.has(far.device)
                ? `${far.device} is off`
                : this.shutPorts.has(portKey(far.device, far.iface || '@' + id))
                  ? `${far.device}:${far.iface} is shut`
                  : this.parked.has(id)
                    ? 'not in use (its VM runs on another host)'
                    : st === 'negotiating'
                      ? 'coming up (link-up delay)'
                      : 'its cable is down';
    return { admin, oper: st === 'negotiating' ? 'negotiating' : 'down', why };
  }

  /** Is an interface shut (by No shut it comes back)? */
  isShut(dev: string, iface: string): boolean {
    const at = this.simPort(dev, iface);
    return this.shutPorts.has(portKey(at.device, at.port)) || this.shutL3.has(dev + ':' + iface);
  }

  stopFlap(ref: string): boolean {
    const link = this.flapLink(ref);
    const fl = link ? this.flaps.get(link) : undefined;
    if (!fl || !link) return false;
    this.flaps.delete(link);
    fl.ended = 'stopped';
    fl.endedAt = this.now;
    this.note('link', 'link', '', '', 'Flapping stopped', 'up', `Port ${fl.ref.slice(6)} stops flapping (Stop flapping); its cable ${link} as it would be without it`);
    this.updateCable(link);
    this.stateVersion++;
    return true;
  }

  /** Shut an interface: a cabled port takes its cable down (the far end notices after the loss-of-signal detection); a logical interface goes down. */
  shut(dev: string, iface: string): boolean {
    // (a host's uplink or passthrough port: where its cable ends now; the notes keep the model's name)
    const at = this.simPort(dev, iface);
    if (at.device !== dev) return this.shutMoved(dev, iface, at, true);
    const sd = this.net.devices.get(dev);
    if (!sd) return false;
    const key = portKey(dev, iface);
    const e = this.net.ends.get(key);
    if (this.shutPorts.has(key) || this.shutL3.has(dev + ':' + iface)) return false;
    if (e || !sd.l3.has(iface)) {
      if (!e && !this.model.index.interfaces.has(dev + ':' + iface)) return false;
      this.shutPorts.set(key, this.now);
      this.note('link', 'link', dev, '', `${iface} shut`, 'down', `${dev}:${iface} is shut (administratively down) at t = ${fmtSec(this.now)}`);
      if (e) this.updateCable(e.link);
      else {
        this.syncInterfaces();
        this.routingChanged();
      }
    } else {
      this.shutL3.set(dev + ':' + iface, this.now);
      this.note('link', 'link', dev, '', `${iface} shut`, 'down', `${dev}:${iface} is shut (administratively down) at t = ${fmtSec(this.now)}`);
      this.syncInterfaces();
      this.routingChanged();
    }
    this.stateVersion++;
    return true;
  }

  noShut(dev: string, iface: string): boolean {
    const at = this.simPort(dev, iface);
    if (at.device !== dev) return this.shutMoved(dev, iface, at, false);
    const key = portKey(dev, iface);
    if (this.shutPorts.delete(key)) {
      this.note('link', 'link', dev, '', `${iface} no shut`, 'up', `${dev}:${iface}: no shut at t = ${fmtSec(this.now)}`);
      const e = this.net.ends.get(key);
      if (e) this.updateCable(e.link);
      else {
        this.syncInterfaces();
        this.routingChanged();
      }
    } else if (this.shutL3.delete(dev + ':' + iface)) {
      this.note('link', 'link', dev, '', `${iface} no shut`, 'up', `${dev}:${iface}: no shut at t = ${fmtSec(this.now)}`);
      this.syncInterfaces();
      this.routingChanged();
    } else return false;
    this.stateVersion++;
    return true;
  }

  /** Shut or no shut a host port whose cable ends at its virtual switch or its passthrough VM in the simulation. */
  private shutMoved(dev: string, iface: string, at: { device: string; port: string }, shut: boolean): boolean {
    const key = portKey(at.device, at.port);
    if (shut === this.shutPorts.has(key)) return false;
    if (shut) this.shutPorts.set(key, this.now);
    else this.shutPorts.delete(key);
    this.note('link', 'link', dev, '', `${iface} ${shut ? 'shut' : 'no shut'}`, shut ? 'down' : 'up', shut ? `${dev}:${iface} is shut (administratively down) at t = ${fmtSec(this.now)}` : `${dev}:${iface}: no shut at t = ${fmtSec(this.now)}`);
    const e = this.net.ends.get(key);
    if (e) this.updateCable(e.link);
    this.stateVersion++;
    return true;
  }

  /** VMs and containers that went down with their host (or its container engine): the host. */
  private hostedOff = new Map<string, string>();
  /** virtual links not in use: an HA standby's, until its VM is restarted there */
  private parked = new Set<string>();
  /** a VM restarted on another member of its HA cluster: where it runs now */
  readonly vmHost = new Map<string, string>();
  /** container engines stopped by the event, with when */
  readonly enginesOff = new Map<string, number>();
  /** containers stopped by hand (restart policy unless-stopped keeps them stopped) */
  private userStopped = new Set<string>();

  /** Power a device off: its ports go dark, its tables and sessions are gone (an inline appliance that fails open passes frames on). */
  powerOff(dev: string, why = ''): boolean {
    const sd = this.net.devices.get(dev);
    if (!sd) return false;
    if (this.off.has(dev)) {
      if (!this.booting.has(dev)) return false;
      // powered off again while booting
      this.booting.delete(dev);
      this.note('link', 'link', dev, '', 'Powered off', 'off', `${dev} is powered off again while booting`);
      this.stateVersion++;
      return true;
    }
    this.off.set(dev, this.now);
    this.powerEpochs.set(dev, this.powerEpoch(dev) + 1);
    const open = sd.caps.inspection && this.params.str('ips-fail', dev) === 'open';
    if (open) this.bypass.add(dev);
    const mode = sd.caps.inspection ? ` It fails ${open ? 'open: frames pass through unchecked' : 'closed: nothing passes'} (${resolvedText(this.params.get('ips-fail', dev))}).` : '';
    this.note('link', 'link', dev, '', 'Powered off', 'off', `${dev} is powered off at t = ${fmtSec(this.now)}${why}: its ports go dark, its tables and sessions are gone.${mode}`);
    this.stateVersion++;
    const tab = this.arp.get(dev);
    if (tab) tab.clear();
    const macs = this.macs.get(dev);
    if (macs) for (const [k, e] of Array.from(macs)) if (e.type === 'dynamic') macs.delete(k);
    for (const d of this.pending) if (d.dev === dev) d.cancelled = true;
    if (this.protocols && this.protocols.deviceDown) this.protocols.deviceDown(dev);
    // a container stopped by hand stays stopped (restart policy unless-stopped)
    if (why === '') this.userStopped.add(dev);
    // its engine is gone with it (it starts again when the host boots)
    this.enginesOff.delete(dev);
    // its virtual switches and container networks stop with it
    this.virtPower(dev, false, false);
    for (const id of this.linksOf(dev)) this.updateCable(id);
    this.recomputeTrees(this.linksOf(dev));
    this.syncInterfaces();
    this.routingChanged();
    // its VMs and containers go down with it; a VM of an HA cluster is restarted on another member
    for (const g of this.guestsOn(dev)) {
      if (this.off.has(g)) continue;
      this.hostedOff.set(g, dev);
      this.powerOff(g, ` with its host ${dev}`);
      if (isVm(this.model.index.devices.get(g))) this.haRestart(g, dev);
    }
    return true;
  }

  /** The VMs and containers on a device now (a VM restarted on another member counts there). */
  private guestsOn(dev: string): string[] {
    return this.model.devices.filter((d) => isGuest(d) && (this.vmHost.get(d.id) || d.host) === dev).map((d) => d.id).sort(cmp);
  }

  /** Where a VM runs now. */
  hostNow(guest: string): string | undefined {
    const d = this.model.index.devices.get(guest);
    return this.vmHost.get(guest) || (d ? d.host : undefined);
  }

  /** The virtual switches and container networks of a device go off or on with it (quietly: its guests' notes say it); `cnetOnly`: its container engine's. */
  private virtPower(dev: string, on: boolean, cnetOnly: boolean): void {
    const ids: string[] = [];
    for (const sd of this.net.devices.values()) if (sd.virt && sd.virt.owner === dev && (!cnetOnly || sd.virt.kind === 'cnet')) ids.push(sd.id);
    if (!ids.length) return;
    for (const id of ids.sort(cmp)) {
      if (on) this.off.delete(id);
      else this.off.set(id, this.now);
      const macs = this.macs.get(id);
      if (!on && macs) for (const [k, e] of Array.from(macs)) if (e.type === 'dynamic') macs.delete(k);
      for (const l of this.linksOf(id)) this.updateCable(l);
    }
    this.stateVersion++;
  }

  /** A VM whose host went down: its HA cluster restarts it on another member that is on, after the VM restart time. */
  private haRestart(vm: string, host: string): void {
    const stand = this.net.standby.get(vm);
    if (!stand || !stand.size) return;
    const r = this.params.get('vm-restart', host, null, hvRef(host));
    this.at(this.now + Number(r.value), () => {
      if (this.hostedOff.get(vm) !== host || !this.off.has(vm) || this.booting.has(vm)) return;
      const home = (this.model.index.devices.get(vm) || { host: undefined }).host;
      const cands = Array.from(stand.keys()).concat(home !== undefined ? [home] : []);
      const other = cands.sort(cmp).find((m) => m !== host && !this.off.has(m));
      if (!other) {
        this.note('link', 'link', vm, '', 'Not restarted', 'off', `${vm} is not restarted after the VM restart time ${resolvedText(r)}: no other member of its HA cluster is on (it starts again with ${host})`);
        return;
      }
      this.moveVm(vm, other);
      this.hostedOff.delete(vm);
      this.note('link', 'link', vm, other, 'Restarted', 'booting', `${vm} is restarted on ${other} by its HA cluster after the VM restart time ${resolvedText(r)}: its virtual NICs join the same port groups there`);
      this.powerOn(vm);
    });
  }

  /** the links a VM had at its own host, by the port key at its end (kept when it moves) */
  private homeLinks = new Map<string, Map<string, string>>();

  /** Move a VM to another host: its links there take over, the ones it had are parked. */
  private moveVm(vm: string, to: string): void {
    const home = (this.model.index.devices.get(vm) || { host: undefined }).host;
    const stand = this.net.standby.get(vm) as Map<string, Map<string, string>>;
    const keys = new Set<string>();
    stand.forEach((m) => m.forEach((_, k) => keys.add(k)));
    if (!this.homeLinks.has(vm)) {
      const hl = new Map<string, string>();
      for (const k of keys) {
        const e = this.net.ends.get(k);
        if (e) hl.set(k, e.link);
      }
      this.homeLinks.set(vm, hl);
    }
    const target = to === home ? (this.homeLinks.get(vm) as Map<string, string>) : stand.get(to);
    if (!target) return;
    const changed: string[] = [];
    for (const [k, lid] of target) {
      const cur = this.net.ends.get(k);
      if (cur && cur.link !== lid) {
        this.parked.add(cur.link);
        changed.push(cur.link);
      }
      this.parked.delete(lid);
      const l = this.net.links.get(lid) as Link;
      const sep = k.indexOf('|');
      this.net.ends.set(k, { link: lid, end: l.b.device === k.slice(0, sep) && l.b.iface === k.slice(sep + 1) ? 'b' : 'a', device: k.slice(0, sep), port: k.slice(sep + 1) });
      changed.push(lid);
    }
    if (to === home) this.vmHost.delete(vm);
    else this.vmHost.set(vm, to);
    for (const id of changed) this.updateCable(id);
    this.stateVersion++;
  }

  /** A container's start time: its engine's (the host it runs on). */
  private containerStart(c: string): Resolved | null {
    const d = this.model.index.devices.get(c);
    if (!d || !isContainer(d) || d.host === undefined) return null;
    return this.params.get('container-start', d.host, null, ceRef(d.host));
  }

  /** Does a container start again when its host boots or its engine starts (its restart policy)? */
  private restarts(c: string): { yes: boolean; why: string } {
    const r = this.params.get('restart-policy', c);
    const p = String(r.value);
    const yes = p === 'always' || (p === 'unless-stopped' && !this.userStopped.has(c));
    return { yes, why: `restart policy ${resolvedText(r)}${p === 'unless-stopped' && this.userStopped.has(c) ? ', and it was stopped by hand' : ''}` };
  }

  /** Stop a device's container engine: its containers and container networks stop. */
  stopEngine(dev: string): boolean {
    const d = this.model.index.devices.get(dev);
    if (!d || !d.containerEngine || this.enginesOff.has(dev) || this.off.has(dev)) return false;
    this.enginesOff.set(dev, this.now);
    this.note('link', 'link', dev, '', 'Container engine stopped', 'off', `${dev}: the container engine is stopped at t = ${fmtSec(this.now)}: its containers and its container networks stop`);
    this.virtPower(dev, false, true);
    for (const c of this.guestsOn(dev)) {
      if (this.off.has(c) || !isContainer(this.model.index.devices.get(c))) continue;
      this.hostedOff.set(c, dev);
      this.powerOff(c, ` with the container engine of ${dev}`);
    }
    this.syncInterfaces();
    this.routingChanged();
    this.stateVersion++;
    return true;
  }

  /** Start a device's container engine again: its networks come back, its containers as their restart policy says. */
  startEngine(dev: string): boolean {
    if (!this.enginesOff.has(dev)) return false;
    this.enginesOff.delete(dev);
    this.note('link', 'link', dev, '', 'Container engine started', 'up', `${dev}: the container engine starts again at t = ${fmtSec(this.now)}`);
    this.virtPower(dev, true, true);
    this.wakeGuests(dev);
    this.syncInterfaces();
    this.routingChanged();
    this.stateVersion++;
    return true;
  }

  /** The guests that waited for their host (or its engine): VMs start, containers as their restart policy says. */
  private wakeGuests(dev: string): void {
    for (const [g, host] of Array.from(this.hostedOff)) {
      if (host !== dev) continue;
      const gd = this.model.index.devices.get(g);
      if (gd && isContainer(gd)) {
        if (this.enginesOff.has(dev)) continue;
        const r = this.restarts(g);
        this.hostedOff.delete(g);
        if (!r.yes) {
          this.note('link', 'link', g, dev, 'Not restarted', 'off', `${g} is not started again (${r.why}): Power on starts it`);
          continue;
        }
      } else this.hostedOff.delete(g);
      this.powerOn(g);
    }
  }

  /** Power a device on: it boots for its boot time, then its ports negotiate and its sessions start afresh. */
  powerOn(dev: string): boolean {
    if (!this.off.has(dev) || this.booting.has(dev)) return false;
    // a guest needs its host (and a container its engine)
    const host = this.hostNow(dev);
    if (host !== undefined && (this.off.has(host) || this.booting.has(host) || this.enginesOff.has(host))) {
      this.hostedOff.set(dev, host);
      this.note('link', 'link', dev, host, 'Waits for its host', 'off', `${dev} starts when ${this.enginesOff.has(host) ? 'the container engine of ' + host + ' is started again' : 'its host ' + host + ' is on'}`);
      return true;
    }
    this.userStopped.delete(dev);
    const r = this.containerStart(dev) || this.params.get('boot-time', dev);
    const at = this.now + Number(r.value);
    this.booting.set(dev, at);
    this.note('link', 'link', dev, '', 'Powered on', 'booting', `${dev} is powered on at t = ${fmtSec(this.now)}: it boots for ${resolvedText(r)} (up at t = ${fmtSec(at)})`);
    this.stateVersion++;
    this.at(at, () => {
      if (this.booting.get(dev) !== at) return;
      this.booting.delete(dev);
      this.off.delete(dev);
      this.bypass.delete(dev);
      this.stateVersion++;
      this.note('link', 'link', dev, '', 'Booted', 'up', `${dev} has ${this.containerStart(dev) ? 'started' : 'booted'}: its ports come up, its tables are empty, its sessions start afresh`);
      this.virtPower(dev, true, false);
      for (const id of this.linksOf(dev)) this.updateCable(id);
      this.recomputeTrees(this.linksOf(dev));
      this.syncInterfaces();
      if (this.protocols && this.protocols.deviceUp) this.protocols.deviceUp(dev);
      this.routingChanged();
      // its VMs start with it, its containers as their restart policy says
      this.wakeGuests(dev);
    });
    return true;
  }

  /** The network events in effect, for the window (each with what ends it). */
  netEvents(): NetEvent[] {
    const out: NetEvent[] = [];
    for (const [id, t] of this.failedLinks) out.push({ kind: 'fail', ref: 'link:' + id, since: t, state: 'failed' });
    for (const [id, t] of this.failedRels) out.push({ kind: 'fail', ref: 'relation:' + id, since: t, state: 'failed' });
    for (const fl of this.flaps.values()) {
      const cycles = this.params.num('flap-cycles');
      out.push({ kind: 'flap', ref: fl.ref, since: fl.since, state: `${fl.down ? 'down' : 'up'}, cycle ${fl.done + (fl.down ? 1 : 0)}${cycles ? ' of ' + cycles : ''}` });
    }
    for (const [k, t] of this.shutPorts) out.push({ kind: 'shut', ref: this.modelPortRef(k), since: t, state: 'shut' });
    for (const [k, t] of this.shutL3) out.push({ kind: 'shut', ref: 'iface:' + k, since: t, state: 'shut' });
    for (const [d, t] of this.enginesOff) out.push({ kind: 'engine', ref: 'device:' + d, since: t, state: 'container engine stopped' });
    for (const [d, t] of this.off) {
      if (this.net.devices.has(d) && (this.net.devices.get(d) as SimDevice).virt) continue;
      if (this.hostedOff.has(d) && !this.booting.has(d)) {
        const h = this.hostedOff.get(d) as string;
        out.push({ kind: 'power', ref: 'device:' + d, since: t, state: this.enginesOff.has(h) ? `stopped with the container engine of ${h}` : `down with its host ${h}`, hosted: true });
        continue;
      }
      const b = this.booting.get(d);
      out.push({ kind: 'power', ref: 'device:' + d, since: t, state: b !== undefined ? `booting (up at t = ${fmtSec(b)})` : this.bypass.has(d) ? 'off (failed open)' : 'off' });
    }
    return out.sort((a, b) => a.since - b.since || cmp(a.ref, b.ref));
  }

  /** What the diagram marks as down now: cables that are not up, failed relations, shut interfaces, devices off. */
  downRefs(): string[] {
    const out: string[] = [];
    for (const [id, st] of this.cable) if (st !== 'up') out.push('link:' + id);
    for (const id of this.failedRels.keys()) out.push('relation:' + id);
    for (const k of this.shutPorts.keys()) out.push(this.modelPortRef(k));
    for (const k of this.shutL3.keys()) out.push('iface:' + k);
    for (const [d] of this.off) if (!this.bypass.has(d) && !(this.net.devices.get(d) || { virt: undefined }).virt) out.push('device:' + d);
    // a VM's links at its own host while it runs elsewhere are not "down": they are not in use
    return out.filter((r) => !(r.indexOf('link:~') === 0 && this.parked.has(r.slice(5)))).sort(cmp);
  }

  /** Ports with `simulation: {flapping: "on"}` start flapping once the network had time to come up (after the flapping up time). */
  startConfigured(): void {
    for (const d of this.model.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
      for (const i of d.interfaces) {
        if (!i.simulation || i.simulation.get('flapping') !== 'on') continue;
        this.at(this.params.num('flap-up'), () => this.startFlap(`iface:${d.id}:${i.id}`, ' (configured on the interface)', true));
      }
    }
  }

  // ------------------------------------------------------------ parameters during the simulation

  /** Set a simulation-wide parameter now (undefined: back to its default). */
  setParam(key: string, v: ParamValue | undefined): ParamChange | null {
    const c = this.params.setSim(key, v);
    if (c) this.applyChanges([c]);
    return c;
  }

  /**
   * The objects' attributes of a model (interfaces, VLANs, relations): set
   * (they apply now, as a device's do); returns the changes in effect.
   */
  objectParamsFrom(model: Model): ParamChange[] {
    const want = new Map<string, { dev?: string; values: Map<string, ParamValue> }>();
    for (const d of model.devices) for (const i of d.interfaces.concat(d.logical)) if (i.simulation && i.simulation.size) want.set(ifaceRef(d.id, i.id), { dev: d.id, values: i.simulation });
    for (const n of model.networks) {
      if (n.vlan === undefined || !n.simulation || !n.simulation.size) continue;
      // (two networks of one VLAN, IPv4 and IPv6: their values together)
      const w = want.get(vlanRef(n.vlan)) || { values: new Map<string, ParamValue>() };
      for (const [k, v] of n.simulation) if (!w.values.has(k)) w.values.set(k, v);
      want.set(vlanRef(n.vlan), w);
    }
    for (const r of model.relations) if (r.simulation && r.simulation.size) want.set(relRef(r.id), { values: r.simulation });
    // a server's DHCP scopes and DNS zones
    for (const d of model.devices) {
      const ns = d.netServices;
      if (!ns) continue;
      if (ns.dhcp) ns.dhcp.scopes.forEach((sc, k) => {
        if (sc.simulation && sc.simulation.size) want.set(scopeRef(d.id, k), { dev: d.id, values: sc.simulation });
      });
      if (ns.dns) for (const z of ns.dns.zones) if (z.simulation && z.simulation.size) want.set(zoneRef(d.id, z.name), { dev: d.id, values: z.simulation });
    }
    // a hypervisor's service and its virtual switches, a container engine
    for (const d of model.devices) {
      if (d.hypervisor) {
        if (d.hypervisor.simulation && d.hypervisor.simulation.size) want.set(hvRef(d.id), { dev: d.id, values: d.hypervisor.simulation });
        for (const vs of d.hypervisor.vswitches) if (vs.simulation && vs.simulation.size) want.set(vswRef(d.id, vs.name), { dev: d.id, values: vs.simulation });
      }
      if (d.containerEngine && d.containerEngine.simulation && d.containerEngine.simulation.size) want.set(ceRef(d.id), { dev: d.id, values: d.containerEngine.simulation });
    }
    const out: ParamChange[] = [];
    const refs = new Set<string>(Array.from(want.keys()).concat(this.params.objects('iface:'), this.params.objects('vlan:'), this.params.objects('rel:'), this.params.objects('scope:'), this.params.objects('zone:'), this.params.objects('hv:'), this.params.objects('vsw:'), this.params.objects('ce:')));
    for (const ref of Array.from(refs).sort()) {
      const w = want.get(ref);
      const dev = w ? w.dev : /^(iface|scope|zone|hv|vsw|ce):/.test(ref) ? ref.split(':')[1] : undefined;
      out.push(...this.params.setObject(ref, dev, w ? w.values : new Map()));
    }
    return out;
  }

  /** The objects' attributes changed in the model: they apply now. */
  setObjectParams(model: Model): ParamChange[] {
    const cs = this.objectParamsFrom(model);
    if (cs.length) this.applyChanges(cs);
    return cs;
  }

  /** A device's attributes changed in the model (the Simulation section of the Edit tab): they apply now. */
  setDeviceParams(dev: string, type: string, values: Map<string, ParamValue>): ParamChange[] {
    const cs = this.params.setDevice(dev, type, values);
    if (cs.length) this.applyChanges(cs);
    return cs;
  }

  /**
   * Changes apply at once, at the current simulated time: each is logged;
   * the tables are checked against their new timeouts (a shorter ARP
   * timeout expires older entries now); periodic timers are rescheduled
   * (protocols.ts); latency, loss and flapping act from the next frame or
   * cycle on.
   */
  private applyChanges(cs: ParamChange[]): void {
    for (const c of cs) this.note('note', 'link', c.device || '', '', 'Parameter changed', '', changeText(c));
    this.estimates.clear();
    // spanning tree switched on or off, a priority, a cost, a port's settings: the trees again (a loop opens or closes)
    if (cs.some((c) => c.key.indexOf('stp-') === 0 || c.key.indexOf('bridge-') === 0)) {
      for (const v of this.net.vlans) this.tree(v);
      this.recomputeTrees();
    }
    this.sweep();
    if (this.protocols && this.protocols.paramsChanged) this.protocols.paramsChanged(cs);
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

  /** Cut what is on its way over a cable that went down: those dots are dropped, what they would deliver never arrives. */
  private cut(ref: string): void {
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
        this.note('drop', f.protocol, '', '', f.label, '', `lost on ${ref.slice(5)} when it went down: ${f.label}`);
      }
    }
    for (const d of this.pending) if (dead.has(d.flight)) d.cancelled = true;
  }

  // ------------------------------------------------------------ broadcast domains

  /** The VLANs a cable carries at its bridge ends (0: untagged; [0] when neither end is a bridge). */
  linkVlans(link: string): number[] {
    const l = this.net.links.get(link);
    if (!l) return [];
    const out = new Set<number>();
    for (const e of [l.a, l.b]) {
      const sd = this.net.devices.get(e.device);
      const bpId = sd && sd.bridge ? sd.portOf.get(linkPort(this.model, l, e)) : undefined;
      if (!sd || bpId === undefined) continue;
      const pv = (sd.bridgePorts.get(bpId) as BridgePort).vlans;
      // a port without a mode says nothing about tagging: its frames are untagged
      if (pv.mode === 'none' || pv.tagged === 'all') out.add(pv.untagged !== null ? pv.untagged : 0);
      else {
        for (const v of pv.tagged) out.add(v);
        if (pv.untagged !== null) out.add(pv.untagged);
      }
    }
    if (!out.size) out.add(0);
    return Array.from(out).sort((a, b) => a - b);
  }

  /**
   * What a broadcast reaches now, from a device's interface or within a
   * cable's VLAN: the devices, ports and cables it crosses through the
   * bridges of its VLAN (ports that are up, not blocked, carrying the
   * VLAN). It ends at every layer-3 interface: no router passes it on.
   */
  broadcastDomain(from: { dev: string; iface: string } | { link: string; vlan: number }): { vlan: number; refs: string[]; devices: string[]; links: string[] } {
    // (one definition with the static analysis: net.ts l2Domain, here in the simulation's state)
    const d = l2Domain(this.net, from, {
      cableUp: (id) => this.cableUp(id),
      portUp: (dev, port) => this.portUp(dev, port),
      forwards: (dev) => !(this.off.has(dev) && !this.bypass.has(dev)),
      blocked: (dev, bp, v) => this.blocked(dev, bp, v),
      memberReady: (dev, port) => this.memberReady(dev, port),
    });
    const refs = new Set<string>();
    const devs = new Set<string>();
    for (const b of d.bridges) devs.add(b.dev);
    for (const r of d.reached) {
      devs.add(r.dev);
      refs.add(`iface:${r.dev}:${'link' in from || r.l3.kind === 'svi' || !(r.dev === from.dev && r.l3.id === from.iface) ? r.port : r.l3.id}`);
    }
    // (the start's own port it leaves by)
    if (!('link' in from)) {
      const first = d.out.find((k) => k.split('|')[0] === from.dev);
      if (first) refs.add(`iface:${from.dev}:${first.split('|')[1]}`);
    }
    for (const k of d.entered.concat(d.left)) refs.add(`iface:${k.split('|')[0]}:${k.split('|')[1]}`);
    for (const x of devs) refs.add('device:' + x);
    for (const l of d.links) refs.add('link:' + l);
    return { vlan: d.vlan === null ? 0 : d.vlan, refs: Array.from(refs).sort(cmp), devices: Array.from(devs).sort(cmp), links: d.links.slice().sort(cmp) };
  }

  /**
   * The one device that has an address on the segment a device's interface reaches now (its broadcast domain), with the
   * interface it has it on (its VRF is that interface's); null: none or several.
   */
  holderOnSegment(dev: string, iface: string, a: IpAddr): { dev: string; iface: string } | null {
    const d = l2Domain(this.net, { dev, iface }, {
      cableUp: (id) => this.cableUp(id),
      portUp: (x, port) => this.portUp(x, port),
      forwards: (x) => !(this.off.has(x) && !this.bypass.has(x)),
      blocked: (x, bp, v) => this.blocked(x, bp, v),
      memberReady: (x, port) => this.memberReady(x, port),
    });
    const found = new Map<string, { dev: string; iface: string }>();
    for (const r of d.reached) if (r.dev !== dev && this.effectiveAddrs(r.dev).some((x) => x.iface === r.l3.id && compareAddr(x.addr, a) === 0)) found.set(`${r.dev}:${r.l3.id}`, { dev: r.dev, iface: r.l3.id });
    const devs = new Set(Array.from(found.values()).map((x) => x.dev));
    return found.size === 1 && devs.size === 1 ? Array.from(found.values())[0] : null;
  }

  /**
   * Which device an address is, seen from a device in a VRF: the one device that has it; else, following the
   * routes from there, the holder of each next hop on the segment it is reached on, to the one that has the
   * address on the last segment — so an address two VRFs both have is the one this traffic goes to. Each next
   * hop is continued in the VRF of the interface it was reached on (never another interface of that device that
   * happens to have the same address). Equal-cost next hops are all followed: the owner is the one they all lead
   * to. `out`, `via`: the interface the packet actually leaves by and its next hop there (the forwarding choice already
   * made: two gateways can share an interface) — only that next hop is followed from here. A device on the way is the
   * owner only when it has the address in the routing context walked (Engine.ownsAddress — what forwarding itself
   * decides), never because it has it in another VRF. Null when that can't be told (no route, several on one segment,
   * next hops leading to different owners, or more than 16 hops).
   */
  ownerSeenFrom(dev: string, vrf: string, a: IpAddr, out?: string, via?: IpAddr | null): string | null {
    const all = Array.from(this.net.devices.keys()).filter((x) => this.effectiveAddrs(x).some((y) => compareAddr(y.addr, a) === 0));
    if (all.length <= 1) return all.length ? all[0] : null;
    const owners = new Set<string>();
    let unknown = false;
    const seen = new Set<string>();
    const walk = (at: string, v: string, depth: number): void => {
      if (unknown) return;
      if (depth > 16) {
        unknown = true;
        return;
      }
      if (at !== dev && this.ownsAddress(at, a, v)) {
        owners.add(at);
        return;
      }
      const key = `${at}|${v}`;
      if (seen.has(key)) return;
      seen.add(key);
      const d = lookup(this.model, at, v, a, this.ctx(at));
      if (d.kind === 'local') {
        owners.add(at);
        return;
      }
      if (d.kind !== 'forward' || !d.hops.length) {
        unknown = true;
        return;
      }
      const chosen = depth === 0 && out !== undefined ? d.hops.filter((h) => h.iface === out && (via === undefined || (via === null ? !h.gateway : !!h.gateway && compareAddr(h.gateway, via) === 0))) : [];
      for (const h of chosen.length ? chosen : d.hops) {
        const target = h.gateway || a;
        const next = this.holderOnSegment(at, h.iface, target);
        if (!next) {
          unknown = true;
          return;
        }
        if (!h.gateway) owners.add(next.dev);
        else {
          const nl = (this.net.devices.get(next.dev) as SimDevice).l3.get(next.iface);
          walk(next.dev, nl ? nl.vrf : '', depth + 1);
        }
      }
    };
    walk(dev, vrf, 0);
    return !unknown && owners.size === 1 ? Array.from(owners)[0] : null;
  }

  /** A device's interfaces a broadcast can start from (with an IPv4 or IPv6 address, not a loopback or tunnel). */
  broadcastIfaces(dev: string): string[] {
    const sd = this.net.devices.get(dev);
    if (!sd) return [];
    return Array.from(sd.l3.values())
      .filter((l) => l.kind !== 'loopback' && l.kind !== 'tunnel' && (l.addrs.length > 0 || l.kind === 'svi'))
      .map((l) => l.id)
      .sort(cmp);
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
      if (e.type === 'incomplete' || e.state === 'PROBE' || e.state === 'REFRESHING') remaining = Math.max(0, e.sentAt + this.retrans(dev, e.iface) - t + Math.max(0, this.retries(dev, e.iface) - e.tries) * this.retrans(dev, e.iface));
      else if (version === 4) remaining = Math.max(0, this.arpTimeout(dev, e.iface) / this.timerScale - (t - e.refreshed));
      else if (e.state === 'REACHABLE') remaining = Math.max(0, this.ndReachable(dev, e.iface) / this.timerScale - (t - e.refreshed));
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
    const aging = this.macAging(dev);
    return Array.from(tab.values())
      .filter((e) => e.type === 'static' || (t - e.refreshed < aging && e.learned <= t))
      .map((e) => ({ mac: e.mac, macSimulated: this.simulatedMac(e.mac), vlan: e.vlan, port: e.port, type: e.type, age: e.type === 'static' ? 0 : t - e.refreshed, remaining: e.type === 'static' ? null : Math.max(0, aging - (t - e.refreshed)) }))
      .sort((a, b) => a.vlan - b.vlan || cmp(a.mac, b.mac));
  }

  /** A timer of a table as its top shows it: the value in effect and where it comes from. */
  private tableTimer(key: string, dev: string): TableTimer {
    const r = this.params.get(key, dev);
    return { label: r.def.label, value: formatValue(r.def, r.value), source: r.source, origin: sourceText(r, true) };
  }

  /** The timers at the top of a device's ARP / neighbour table, with where each comes from. */
  arpTimers(dev: string): TableTimer[] {
    const out = ['arp-timeout', 'ndp-reachable', 'arp-retransmit', 'arp-retries'].map((k) => this.tableTimer(k, dev));
    // an interface that sets its own (the device's values above are its interfaces' default)
    const sd = this.net.devices.get(dev);
    for (const l3 of sd ? Array.from(sd.l3.values()).sort((a, b) => cmp(a.id, b.id)) : []) {
      for (const k of ['arp-timeout', 'ndp-reachable', 'arp-retransmit', 'arp-retries']) {
        const r = this.params.get(k, dev, null, ifaceRef(dev, l3.id));
        if (r.source === 'object') out.push({ label: `${r.def.label} (${l3.id})`, value: formatValue(r.def, r.value), source: r.source, origin: sourceText(r, true) });
      }
    }
    return out;
  }

  /** A switch's MAC table timers. */
  macTimers(dev: string): TableTimer[] {
    return ['mac-aging', 'mac-table-size'].map((k) => this.tableTimer(k, dev));
  }

  /** Change the timer scale (from now on: the entries' remaining times follow the new scale). */
  setTimerScale(n: number): void {
    if (n === this.timerScale || n < 1) return;
    this.note('note', 'link', '', '', 'Timer scale', '', `The ARP, neighbour and MAC table timers run ${n === 1 ? 'in real time' : n + ' times faster (1:' + n + ')'} from t = ${fmtSec(this.now)}; the configured values are unchanged`);
    this.timerScale = n;
  }

  // ------------------------------------------------------------ estimates (for the logical view's dots)

  /** About how long a packet from a device to an address takes: its traced path's cables × a hop's time (cached per routing state). */
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
    const ms = cables * this.hopTime();
    this.estimates.set(key, ms);
    return ms;
  }
}

/** The bytes of an IP packet: its header, the encapsulation's, and what it carries (its own length, else its message's size). */
export function ipLen(p: Pkt): number {
  // (an IPv6 fragment has its 8-byte fragment header besides; the Router Alert option: 4 bytes in IPv4, an 8-byte Hop-by-Hop header in IPv6)
  const hdr = (p.dst.version === 4 ? 20 : p.frag ? 48 : 40) + (p.routerAlert ? (p.dst.version === 4 ? 4 : 8) : 0);
  if (p.inner) return hdr + (p.encap && /ESP/i.test(p.encap) ? 36 : 4) + ipLen(p.inner);
  if (p.len !== undefined) return hdr + p.len;
  const d = p.msg.data as { size?: unknown } | undefined;
  return hdr + (d && typeof d.size === 'number' ? d.size : p.msg.protocol === 'demand' ? 1400 : PAYLOAD);
}

/** The type, code and names of an ICMP (ICMPv6) error. */
export function icmpType(kind: IcmpKind, v: 4 | 6): { type: number; code: number; name: string; short: string } {
  const unreach = (code4: number, code6: number, what: string, short: string): { type: number; code: number; name: string; short: string } => ({ type: v === 4 ? 3 : 1, code: v === 4 ? code4 : code6, name: `Destination Unreachable: ${what}`, short });
  switch (kind) {
    case 'net':
      return v === 4 ? unreach(0, 0, 'net unreachable', 'Net Unreachable') : unreach(0, 0, 'no route to destination', 'No Route');
    case 'host':
      return v === 4 ? unreach(1, 3, 'host unreachable', 'Host Unreachable') : unreach(1, 3, 'address unreachable', 'Address Unreachable');
    case 'port':
      return unreach(3, 4, 'port unreachable', 'Port Unreachable');
    case 'admin':
      return unreach(13, 1, v === 4 ? 'communication administratively prohibited' : 'communication with destination administratively prohibited', 'Admin Prohibited');
    case 'frag':
      return v === 4 ? { type: 3, code: 4, name: 'Destination Unreachable: fragmentation needed and DF set', short: 'Frag Needed' } : { type: 2, code: 0, name: 'Packet Too Big', short: 'Packet Too Big' };
    case 'ttl':
      return { type: v === 4 ? 11 : 3, code: 0, name: v === 4 ? 'Time Exceeded: TTL exceeded in transit' : 'Time Exceeded: hop limit exceeded in transit', short: v === 4 ? 'TTL exceeded' : 'Hop Limit exceeded' };
    default:
      return { type: v === 4 ? 11 : 3, code: 1, name: 'Time Exceeded: fragment reassembly time exceeded', short: 'Reassembly Time exceeded' };
  }
}

/** A quoted header as the log writes it: "10.0.0.5 → 10.9.9.9 TCP 49152 → 443, TTL 1". */
export function quoteText(q: Quote): string {
  return `${q.src} → ${q.dst} ${q.proto === 'ip' ? 'IP' : q.proto.toUpperCase()}${q.sport !== undefined && q.dport !== undefined ? ` ${q.sport} → ${q.dport}` : ''}, TTL ${q.ttl}`;
}

/** The cast of a destination MAC. */
export function castOf(mac: string): Cast {
  return mac === BROADCAST ? 'broadcast' : isGroupMac(mac) ? 'multicast' : 'unicast';
}

/** An IPv4 subnet's broadcast address (host bits set). */
export function subnetBroadcast(a: { net: IpAddr & { prefix: number } }): IpAddr {
  const bytes = a.net.bytes.slice();
  let bits = a.net.prefix;
  for (let i = 0; i < bytes.length; i++, bits -= 8) {
    const keep = bits >= 8 ? 0xff : bits <= 0 ? 0 : (0xff << (8 - bits)) & 0xff;
    bytes[i] = (bytes[i] & keep) | (~keep & 0xff);
  }
  return { version: a.net.version, bytes };
}

/** The limited broadcast 255.255.255.255. */
/** Is it an IPv6 link-local unicast address (fe80::/10)? */
export function isLinkLocal6(a: IpAddr): boolean {
  return a.version === 6 && a.bytes[0] === 0xfe && (a.bytes[1] & 0xc0) === 0x80;
}

export function isLimitedBroadcast(a: IpAddr): boolean {
  return a.version === 4 && a.bytes.every((b) => b === 255);
}

/** The IP protocol of a packet as the inspector names it ("TCP (6)", "GRE (47)"). */
function protoText(p: Pkt): string {
  const l = p.l4;
  // (an encapsulation: its outer header's protocol — ESP, GRE, IP-in-IP, or UDP for WireGuard, VXLAN …)
  if (p.inner && (!l || l.proto === 'other')) return l && l.num === 4 ? 'IP-in-IP (4)' : l && l.num === 50 ? 'ESP (50)' : !l && /ESP/i.test(p.encap || '') ? 'ESP (50)' : l && l.num !== 47 ? `${l.num}` : 'GRE (47)';
  if (!l) return '—';
  if (l.proto === 'icmp') return p.dst.version === 4 ? 'ICMP (1)' : 'ICMPv6 (58)';
  if (l.proto === 'tcp') return 'TCP (6)';
  if (l.proto === 'udp') return 'UDP (17)';
  if (l.proto === 'igmp') return 'IGMP (2)';
  return `${l.num}`;
}

/** What a frame's destination MAC is. */
function macNote(frame: Frame): string {
  const d = frame.dst;
  if (d === BROADCAST) return 'broadcast: every station in the VLAN takes it';
  const g = frame.ip && isMulticastIp(frame.ip.dst) ? formatAddr(frame.ip.dst) : '';
  if (/^01:00:5e:/.test(d)) return `IPv4 multicast${g ? ' ' + g : ''}: 01:00:5e + the group’s low 23 bits (32 groups share each MAC)`;
  if (/^33:33:/.test(d)) return `IPv6 multicast${g ? ' ' + g : ''}: 33:33 + the group’s low 32 bits`;
  const l2: { [m: string]: string } = {
    '01:80:c2:00:00:00': 'bridge group address (STP BPDUs): never forwarded by a bridge',
    '01:80:c2:00:00:02': 'slow protocols (LACP): never forwarded by a bridge',
    '01:80:c2:00:00:0e': 'LLDP nearest bridge: never forwarded by a bridge',
    '01:80:c2:00:00:14': 'all level 1 IS-IS routers',
    '01:80:c2:00:00:15': 'all level 2 IS-IS routers',
    '01:00:0c:cc:cc:cc': 'CDP: never forwarded by a bridge',
  };
  if (l2[d]) return l2[d];
  if (isGroupMac(d)) return 'multicast';
  if (isVirtual(d)) return 'unicast, a virtual MAC (first-hop redundancy group)';
  return 'unicast';
}

/** A VLAN's spanning tree: its root, the blocked bridge ports ("dev|port"), every bridge port in it, the root ports, the ports root guard blocks, and the cables of loops left open. */
interface Tree {
  root: string;
  blocked: Set<string>;
  ports: Set<string>;
  rootPorts: Set<string>;
  inconsistent: Set<string>;
  loops: string[];
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
  return /^00:00:5e:00:0[12]:/.test(mac) || /^00:00:0c:07:ac:/.test(mac) || /^00:00:0c:9f:f/.test(mac) || /^00:05:73:a0:0/.test(mac) || /^00:07:b4:/.test(mac);
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
/** A time left, rounded to the second: "45 s", "4 min 53 s", "1 h 5 min" ("—": never). */
export function fmtDur(ms: number): string {
  if (!isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ' ' + (s % 60) + ' s' : ''}`;
  return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ' ' + Math.floor((s % 3600) / 60) + ' min' : ''}`;
}

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

/** A device's NAT service: its inside and outside interfaces and its rules (undefined: none). */
function natOf(model: Model, dev: string): { inside: string[]; outside: string[]; rules: Array<{ [k: string]: unknown }> } | undefined {
  const d = model.index.devices.get(dev);
  const n = d && d.appServices ? d.appServices.get('nat') : undefined;
  if (!n) return undefined;
  const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
  return { inside: list(n.values.inside), outside: list(n.values.outside), rules: n.lists.rules || [] };
}

/** Is an address in a prefix (or the address) as written? */
function inNetText(text: string, a: IpAddr): boolean {
  const p = parsePrefix(text, false);
  return !!p && p.version === a.version && inPrefix(p, a);
}

/** The Inspection rule of an IDS/IPS that a frame matches ("tcp/23"), else null. */
function inspectionMatch(model: Model, dev: string, frame: Frame): string | null {
  const d = model.index.devices.get(dev);
  const ins = d && d.appServices ? d.appServices.get('inspection') : undefined;
  const block = ins && Array.isArray(ins.values.block) ? (ins.values.block as string[]) : [];
  const pkt = frame.ip;
  if (!block.length || !pkt || !pkt.l4) return null;
  const proto = pkt.l4.proto;
  if (proto !== 'tcp' && proto !== 'udp' && proto !== 'icmp') return null;
  for (const b of block) {
    const r = parsePorts(b);
    if ('list' in r && portsMatch(r.list, proto, proto === 'icmp' ? 0 : (pkt.l4.dport as number))) return b;
  }
  return null;
}

/** A flow's identity at NAT, one side of it: TCP and UDP the port, an ICMP echo (request or reply) its identifier. */
function natPort(l4: L4 | undefined, side: 'src' | 'dst'): number | undefined {
  if (!l4) return undefined;
  if (l4.proto === 'icmp') return l4.quote ? undefined : l4.echoId;
  return side === 'src' ? l4.sport : l4.dport;
}

/** The header with that identity replaced (the port, or the echo identifier). */
function withNatPort(l4: L4, side: 'src' | 'dst', v: number): L4 {
  if (l4.proto === 'icmp') return { ...l4, echoId: v };
  return side === 'src' ? { ...l4, sport: v } : { ...l4, dport: v };
}
