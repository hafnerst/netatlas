/**
 * Multicast in the simulation: group membership (IGMPv2 / v3 for IPv4,
 * MLDv1 / v2 for IPv6), IGMP / MLD snooping on switches, PIM routing
 * (sparse mode with its shared tree, registers and the switch to the
 * shortest-path tree; source-specific multicast; dense mode's flood and
 * prune) and the streams and joins of the hosts.
 *
 * Membership. Every multicast router (a router that runs PIM, or the
 * router end of an IGMP relation) with its querier on takes part in the
 * querier election of each of its subnets: the lowest address queries
 * (General Queries every query interval), the others stay silent and take
 * over when they heard no query for the other-querier-present interval
 * (robustness × query interval + response interval ÷ 2). A host that
 * joins reports at once and repeats it after the unsolicited report
 * interval; it answers a query after a random delay (from the seed) up to
 * the response interval; IGMPv2 / MLDv1 hosts that hear another member's
 * report for the group first send none (report suppression). A host that
 * leaves sends a Leave (v2) or a report that blocks its sources (v3); the
 * querier asks with group-specific queries, robustness times one last
 * member query interval apart, and the membership goes when nobody
 * answers. A membership not reported for robustness × query interval +
 * response interval expires.
 *
 * Snooping (RFC 4541) is a switch's own configuration, an explicit choice
 * per VLAN (`igmp_mld_snooping`, model/snooping.ts), for IGMP and MLD
 * together. Enabled: a port where queries or PIM Hellos arrive is a router
 * port (for the router-port aging time), a port where a report arrives a
 * member port of the group in that VLAN (for the membership interval; at a
 * Leave at once with fast leave, else after the group queries). Reports go
 * to the router ports only (other hosts never hear them); a group's data
 * goes to its member ports and the router ports; a group without members
 * to the router ports only (never flooded to the hosts); link-local groups
 * (224.0.0.0/24, ff02::/16: queries, the routing protocols) are flooded.
 * Disabled: everything is flooded in the VLAN; not configured (an error of
 * the checks): flooded too, and the log says so. A link that goes down
 * takes what was learned on its port with it. A switch with the snooping
 * querier on (snooping enabled, an address in the VLAN) queries a VLAN
 * that has no router port. Snooping is Layer 2 only: what crosses a VLAN
 * interface is multicast routing (PIM), never the switch's snooping.
 *
 * PIM. The designated router of a segment (the highest DR priority, then
 * the highest address) joins on behalf of its members: towards the RP for
 * any-source groups ((*,G), sparse mode), towards each source for
 * source-specific ones ((S,G), SSM), hop by hop along the unicast route
 * (its RPF neighbour must be a PIM neighbour). Joins are refreshed every
 * Join/Prune period and held for 3.5 periods (210 s); a router whose
 * outgoing interfaces are all gone prunes upstream. The first-hop router
 * of a source sends its data to the RP in Registers until the RP, which
 * has joined towards the source, receives it natively and answers with a
 * Register-Stop. A last-hop router switches to the source's tree at the
 * first packet (SPT switchover immediately; never: it stays on the shared
 * tree) and prunes the source off the shared tree. Data that arrives on
 * another interface than the one towards its source (or the RP) fails the
 * RPF check and is dropped; packets with TTL 1 and link-local groups are
 * never routed. When the unicast routes change (a link fails), every
 * entry's RPF interface is checked again: new Joins upstream, Prunes to the
 * old neighbour, and the tree moves; branches lose the stream until it is
 * rebuilt. Dense mode floods to every PIM neighbour and member interface,
 * and a router without receivers prunes itself off for 210 s (a Graft
 * brings it back when a member joins).
 *
 * Pure and deterministic: the random delays come from the engine's seed.
 */
import { IpAddr, parseAddress } from '../../model/ip';
import { relationDevices } from '../../model/types';
import { compareAddr, formatAddr } from '../ipmath';
import { lookup } from '../routing';
import { tunnelRelation } from '../trace';
import { Frame, fmtDur as dur, fmtSec } from './engine';
import { isLinkLocalGroup, isMulticastIp, isSsmGroup, multicastMac } from './mac';
import { L3Iface, SimDevice } from './net';
import { durationText, formatValue, ifaceRef, relRef, resolvedText, sourceText, vlanRef } from './params';
import { routerId } from './proto-routing';
import { RpChoice, RpEnv, pimDomain, rpFor, staticRp } from '../pim-rp';
import { ProtocolSim, Sess } from './protocols';
import { representativeText } from '../../model/speed';
import { SnoopingChoice, snoopingChoice, switchedVlans } from '../../model/snooping';
import { vlanRangesShown } from '../../model/derive';
import { GridTable, L4, McPort, Msg, NetEvent, Pkt, SessionStatus, SnoopResult, TableTimer } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** A VLAN in words ("VLAN 20"; 0: a port's untagged frames without a VLAN). */
const vlanName = (v: number): string => (v ? 'VLAN ' + v : 'the untagged frames');
const A = (s: string): IpAddr => parseAddress(s) as IpAddr;
/** PIM Join/Prune holdtime: 3.5 × the 60 s period (RFC 7761 §4.11). */
const JOIN_HOLD = 210000;
/** A first-hop router that saw no data of a source for this long forgets it (RFC 7761 Keepalive_Period 210 s). */
const SG_KEEPALIVE = 210000;
/** Dense mode: an outgoing interface flooded to (a PIM neighbour there), until pruned. */
const FLOOD = Number.MAX_SAFE_INTEGER;

/** A group a host has joined on an interface. */
interface HostGroup {
  group: string;
  sources: string[];
  /** where it comes from: the model (an interface's join, an IGMP relation) or a Join group… event */
  origin: 'model' | 'event';
  since: number;
  gen: number;
  /** a pending answer to a query (cancelled by suppression) */
  answer: number;
  /** joined by Network events: the id its join and leave reports carry */
  tag?: number;
}

/** A group a router knows members of on an interface. */
interface RGroup {
  group: string;
  reporter: string;
  version: string;
  expires: number;
  sources: string[];
  /** group-specific queries still to send after a leave */
  gsq: number;
  /** a member left: the group goes unless the group-specific queries are answered */
  leaving: boolean;
}

/** A querier candidate's role: provisionally the querier (startup), the querier, a non-querier, not a candidate (configured off), down. */
export type QuerierRole = 'starting' | 'querier' | 'non-querier' | 'off' | 'down';

/** A querier candidate and its role as the tables and the diagram show it. */
/**
 * A snooping switch's state in one of its VLANs with snooping enabled: its
 * own part (an elected querier, one in its startup, a standby candidate, a
 * candidate that is down, or snooping only — no candidate) and, apart from
 * that, whether the VLAN has a querier (itself, or one it hears, with who).
 * From the protocol's state, never from the configuration alone.
 */
export interface SnoopRole {
  dev: string;
  vlan: number;
  /** querier: elected; starting: its startup queries; standby: a candidate that yields; down: a candidate not running (not yet up); snooping: no candidate; off: the switch is powered off (it snoops nothing) */
  role: 'querier' | 'starting' | 'standby' | 'down' | 'snooping' | 'off' | 'booting';
  /** the VLAN's querier: itself, one heard (address, device, the port it is behind), or none */
  querier: { self: true } | { self: false; addr: string; dev: string; port: string; until: number } | null;
  /** its multicast router ports there now (a query or PIM Hello arrived: a router or the querier behind it), until when */
  routerPorts: Array<{ port: string; until: number }>;
  /** where a group without members goes there */
  unregistered: string;
  /** the badge: "VLAN 20 · Querier", "VLAN 10 · Snooping · no querier" */
  text: string;
  /** the same in a sentence (the tooltip, the accessible name, the table) */
  detail: string;
}

export interface QuerierInfo {
  dev: string;
  kind: 'router' | 'switch';
  /** a router's interface, a switch's VLAN */
  iface?: string;
  vlan?: number;
  /** its LAN in words: "VLAN 20", "10.5.0.0/24" */
  lan: string;
  family: string;
  addr: string;
  role: QuerierRole;
  /** the querier it heard (a non-querier), and how long until it takes over if that one stays silent */
  other?: string;
  otherLeft?: number;
  queries: number;
  lastQuery: number;
  since: number;
  /** its next General Query is due at (-1: none), the startup query it is at ("1 of 2"; '' when past its startup), when it would take over (non-querier) */
  nextAt: number;
  startup: string;
  takeoverAt: number;
}

/**
 * A querier candidate on one LAN: a router's interface with IGMP / MLD, or
 * a switch's VLAN with the snooping querier on. Its election state is the
 * protocol's: the queries it heard and sent (heardQuery, startElection).
 */
interface Cand {
  dev: string;
  /** "r1:g0", "sw (VLAN 20)" */
  name: string;
  lan: string;
  iface?: string;
  vlan?: number;
  /** where its timers are read (an interface's reference; null: the device's) */
  at: string | null;
  addr: IpAddr;
  querier: boolean;
  /** when the querier it yields to was last heard (-1: none) */
  otherAt: number;
  otherAddr: string;
  /** startup queries left (RFC 3376 §8.7) */
  startup: number;
  running: boolean;
  /** its schedules: a newer generation ends the older one */
  gen: number;
  otherTok: number;
  /** general queries sent, the last one */
  queries: number;
  lastQuery: number;
  /** when it started or took over */
  since: number;
  /** its next General Query is due at (simulated ms; -1: none scheduled), and when it would take over (-1: not waiting) */
  nextAt: number;
  takeoverAt: number;
  /** startup queries in all (robustness) */
  startupOf: number;
  /** configured to take part, up, and how it sends a General Query */
  enabled: () => boolean;
  up: () => boolean;
  send: () => void;
}

/** A router interface's IGMP / MLD: its querier election and the groups with members. */
interface RIface extends Cand {
  l3: L3Iface;
  groups: Map<string, RGroup>;
}

/** A switch's snooping querier in a VLAN (from its VLAN interface's address). */
interface SQ extends Cand {
  svi: L3Iface;
  vlan: number;
}

/** A member port a switch learned for a group: until when, from whose report, its version and sources (IGMPv3 / MLDv2). */
interface SnoopPort {
  until: number;
  reporter: string;
  version: string;
  sources: string[];
  /** a leave was heard there: it goes at `until` (after the last member queries) unless a member answers */
  leaving?: boolean;
}

/** A switch's snooping state in one VLAN: its multicast router ports (until when), the member ports of each group. */
interface Snoop {
  routerPorts: Map<string, number>;
  groups: Map<string, Map<string, SnoopPort>>;
  /** the querier it last heard (a general query) and on which port, until the other querier present interval is over */
  querier?: { addr: string; dev: string; port: string; until: number };
}

/** An entry of a router's multicast routing table: (*, G) or (S, G). */
interface MRoute {
  s: string;
  g: string;
  iif: string | null;
  /** the RPF neighbour (a device), null: none (a directly connected source, the RP itself) */
  nbr: string | null;
  /** outgoing interfaces: until when (Infinity: members of its own) */
  oil: Map<string, number>;
  /** dense mode: interfaces pruned until */
  pruned: Map<string, number>;
  /** (*, G): sources pruned off the shared tree per interface ("S|iface") */
  rptPruned: Set<string>;
  spt: boolean;
  /** first-hop router: registering to the RP (until a Register-Stop) */
  registering: boolean;
  /** first-hop router: the source is on its interface */
  local: boolean;
  created: number;
  lastData: number;
  /** what the last forwarding was (logged when it changes) */
  logged: string;
  mode: 'sparse' | 'dense' | 'ssm';
}

/** A stream a host sends. */
export interface Stream {
  id: number;
  dev: string;
  iface: string;
  group: string;
  port: number;
  interval: number;
  size: number;
  /** model: configured; event: Network events (real time); demand: a demand; experiment: an experiment's action (scenario time, checked as an event is) */
  origin: 'model' | 'event' | 'demand' | 'experiment';
  label: string;
  running: boolean;
  since: number;
  sent: number;
  gen: number;
  sport: number;
  /** its datagrams each member received, by device */
  rx: Map<string, number>;
  /** started by Network events: the id its datagrams carry (drawn whatever is ticked, found by their event) */
  tag?: number;
  /** when it was stopped (Stop stream) */
  stoppedAt?: number;
  /** started by Network events: datagrams due while its source was off (not sent, counted) */
  offMissed?: number;
  /** the simulated time of its last datagram, and between the last two (what a receiver may expect) */
  lastAt?: number;
  gap?: number;
}

/** An entry the network learned of a host's membership, followed after it leaves. */
export interface LeaveWatch {
  kind: 'snoop' | 'router';
  dev: string;
  vlan?: number;
  port?: string;
  iface?: string;
  group: string;
  /** "core (VLAN 20, port ap)", "r1:g0" */
  where: string;
}

/** What a receiver got of a group. */
interface Rx {
  dev: string;
  group: string;
  count: number;
  first: number;
  last: number;
  sources: Set<string>;
  gapNoted: boolean;
}

export class Multicast {
  /** a multicast demand's stated bandwidth, by "source device|group" (its stream is representative, never that load) */
  private demandBps = new Map<string, number>();
  readonly P: ProtocolSim;
  /** joined groups by "dev|iface" */
  private hosts = new Map<string, Map<string, HostGroup>>();
  /** router interfaces running IGMP / MLD, by "dev|iface" */
  private rifs = new Map<string, RIface>();
  /** snooping state by "dev|vlan" */
  private snoops = new Map<string, Snoop>();
  /** the switches' snooping queriers by "dev|vlan" */
  private sqs = new Map<string, SQ>();
  /** the last query each host interface heard, by "dev|iface|family" */
  private heard = new Map<string, { from: string; at: number }>();
  /** multicast routes by device, then "S|G" ("*|G") */
  private mroutes = new Map<string, Map<string, MRoute>>();
  readonly streams: Stream[] = [];
  private rx = new Map<string, Rx>();
  /** Join / Leave / Start / Stop events in effect */
  private events: NetEvent[] = [];
  private seq = 0;
  private noted = new Map<string, number>();
  /** a test's datagram reached a member: the transport layer's callback */
  onTestReceived: ((test: number, dev: string, from: IpAddr) => void) | null = null;

  constructor(P: ProtocolSim) {
    this.P = P;
  }

  private get e() {
    return this.P.e;
  }

  // ------------------------------------------------------------ installing

  install(): void {
    const P = this.P;
    P.shared.set('multicast', this);
    P.pimHook = (s, msg, l3) => this.pimMessage(s, msg, l3);
    P.handlers.set('igmp', (dev, l3, msg, pkt) => {
      if (pkt && l3) this.igmpIn(dev, l3, msg, pkt);
    });
    P.handlers.set('mcast', (dev, l3, msg, pkt) => {
      if (pkt && l3) this.dataIn(dev, l3, pkt);
    });
    P.fallback.set('pim', (dev, l3, msg, pkt) => this.pimUnrelated(dev, l3, msg, pkt));
    P.snoopHook = (sd, from, vlan, frame, t) => this.snoop(sd, from, vlan, frame, t);
    P.mrouteHook = (dev, l3, pkt) => this.mroute(dev, l3, pkt);
    P.joinedHook = (dev, iface, group) => this.isMember(dev, iface, formatAddr(group));
    P.routesHooks.push((dev) => this.routesChanged(dev));
    P.sweepHooks.push(() => this.sweep());
    P.ifaceHooks.push((dev, l3, up) => {
      if (!up) this.ifaceDown(dev, l3);
      else this.ifaceUp(dev, l3);
    });
    P.linkHooks.push((ref, up) => {
      if (!up) this.linkDown(ref);
    });
    P.deviceHooks.push((dev, up) => (up ? this.deviceUp(dev) : this.deviceDown(dev)));
    P.bootHooks.push(() => this.boot());
    P.extraStatus.push(() => this.status());
  }

  // ------------------------------------------------------------ the model's configuration

  /** The groups the model has a device join: an interface's `multicast: join`, and an IGMP relation's `group` at its host end. */
  private modelJoins(): Array<{ dev: string; iface: string; group: string; sources: string[] }> {
    const out: Array<{ dev: string; iface: string; group: string; sources: string[] }> = [];
    for (const d of this.P.m.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
      for (const i of d.interfaces.concat(d.logical)) if (i.multicast) for (const j of i.multicast.joins) out.push({ dev: d.id, iface: i.id, group: j.group, sources: j.sources.slice() });
    }
    for (const r of this.P.m.relations.slice().sort((a, b) => cmp(a.id, b.id))) {
      if (this.e.base(r) !== 'igmp') continue;
      const g = r.attrs.find(([k]) => k === 'group');
      const group = g && parseAddress(g[1]) ? g[1] : '239.1.1.1';
      for (const ep of r.endpoints) {
        const sd = this.P.sd(ep.device);
        if (!sd || sd.routes) continue;
        const l3 = ep.iface ? sd.l3.get(ep.iface) : Array.from(sd.l3.values()).find((l) => l.addrs.length && l.kind !== 'loopback');
        if (l3 && !out.some((x) => x.dev === ep.device && x.iface === l3.id && x.group === group)) out.push({ dev: ep.device, iface: l3.id, group, sources: [] });
      }
    }
    return out;
  }

  private boot(): void {
    // the routers' IGMP / MLD on their interfaces
    for (const sd of Array.from(this.e.net.devices.values()).sort((a, b) => cmp(a.id, b.id))) {
      if (!this.mcRouter(sd.id) && !this.igmpRouter(sd.id)) continue;
      for (const l3 of Array.from(sd.l3.values()).sort((a, b) => cmp(a.id, b.id))) {
        if (l3.kind === 'loopback' || l3.kind === 'tunnel') continue;
        for (const v of [4, 6] as Array<4 | 6>) {
          const a = l3.addrs.find((x) => x.addr.version === v);
          if (!a) continue;
          const key = `${sd.id}|${l3.id}|${v}`;
          const at = ifaceRef(sd.id, l3.id);
          const dev = sd.id;
          const ri: RIface = {
            dev, name: `${dev}:${l3.id}`, lan: this.lanOf(l3, a.addr), iface: l3.id, at, addr: a.addr, l3, groups: new Map(),
            querier: false, otherAt: -1, otherAddr: '', startup: 0, startupOf: 0, nextAt: -1, takeoverAt: -1, running: false, gen: 0, otherTok: 0, queries: 0, lastQuery: -1, since: -1,
            enabled: () => this.e.params.str('igmp-querier', dev, at) === 'on',
            up: () => this.e.deviceOn(dev) && this.e.isL3Up(dev, l3.id),
            send: () => this.generalQuery(ri),
          };
          this.rifs.set(key, ri);
          // the election starts as soon as its interface is up (RFC 3376 §6.6), in parallel with everything else
          this.P.whenIfaceUp(dev, l3.id, () => {
            if (!ri.running) this.startElection(ri);
          });
        }
      }
    }
    // switches with a snooping querier in a VLAN
    for (const sd of Array.from(this.e.net.devices.values()).sort((a, b) => cmp(a.id, b.id))) if (sd.bridge && sd.caps.switchFeatures) this.snoopCandidates(sd);
    // the hosts' joins and streams of the model, a moment after the start
    // a host joins its groups as soon as its interface is up (an unsolicited report), all of them together
    for (const j of this.modelJoins()) this.P.whenIfaceUp(j.dev, j.iface, () => this.join(j.dev, j.iface, j.group, j.sources, 'model'));
    for (const d of this.P.m.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
      for (const i of d.interfaces.concat(d.logical)) {
        if (!i.multicast) continue;
        for (const s of i.multicast.streams) this.addStream(d.id, i.id, s.group, s.port, s.interval, s.size, 'model', 4000 + this.e.jitter());
      }
    }
    // the model's multicast demands are streams too
    for (const dm of this.P.m.demands.slice().sort((a, b) => cmp(a.id, b.id))) {
      const g = parseAddress(dm.destination);
      if (!g || !isMulticastIp(g)) continue;
      const sd = this.P.sd(dm.source.split(':')[0]);
      if (!sd) continue;
      const l3 = Array.from(sd.l3.values()).find((l) => l.kind !== 'loopback' && l.kind !== 'tunnel' && l.addrs.some((a) => a.addr.version === g.version));
      if (!l3) continue;
      const ms = Math.round(Math.max(1000, Math.min(4000, 4000 / (1 + Math.log10(1 + dm.bps / 1e7)))));
      this.addStream(sd.id, l3.id, dm.destination, 5001, ms, 1316, 'demand', 4000 + this.e.jitter(), dm.label || dm.id);
      this.demandBps.set(sd.id + '|' + dm.destination, dm.bps);
    }
  }

  /** Does a device route multicast (it runs PIM)? */
  mcRouter(dev: string): boolean {
    const d = this.P.m.index.devices.get(dev);
    const sd = this.P.sd(dev);
    return !!d && !!sd && sd.routes && d.services.some((s) => s.id === 'pim');
  }

  /** A router at an IGMP relation (a querier without PIM). */
  private igmpRouter(dev: string): boolean {
    const sd = this.P.sd(dev);
    return !!sd && sd.routes && this.P.m.relations.some((r) => this.e.base(r) === 'igmp' && relationDevices(r).indexOf(dev) >= 0);
  }

  /** A router's PIM mode for a group: SSM for a source-specific group, else its own (sparse unless written). */
  private mode(dev: string, group: IpAddr): 'sparse' | 'dense' | 'ssm' {
    if (isSsmGroup(group)) return 'ssm';
    const d = this.P.m.index.devices.get(dev);
    const s = d ? d.services.find((x) => x.id === 'pim') : undefined;
    const m = s ? s.values.get('mode') : undefined;
    return m === 'dense' ? 'dense' : m === 'ssm' ? 'ssm' : 'sparse';
  }

  /** What the RP choice (analysis/pim-rp.ts) reads of the simulation: the addresses and router IDs as they are now, who is on. */
  private rpEnv(): RpEnv {
    return {
      ownerOf: (a) => this.e.ownerOf(a),
      routerId: (d) => (this.P.sd(d) ? A(routerId(this.P, d, 'pim')) : null),
      v6Addr: (d) => {
        const sd = this.P.sd(d);
        if (!sd) return null;
        const ls = Array.from(sd.l3.values()).sort((x, y) => Number(y.kind === 'loopback') - Number(x.kind === 'loopback') || cmp(x.id, y.id));
        for (const l of ls) for (const x of l.addrs) if (x.addr.version === 6 && x.addr.bytes[0] !== 0xfe) return x.addr;
        return null;
      },
      on: (d) => this.e.deviceOn(d),
    };
  }

  /**
   * The RP a router uses for an any-source group, in its own context
   * (analysis/pim-rp.ts: its static RP, its PIM relations' rp, its PIM
   * domain's candidate RP; the group's address family). Null: none — the
   * group can't be joined there. Routers that disagree keep their own
   * (their trees do not meet), and the log says so once.
   */
  rp(dev: string, group: string): RpChoice | null {
    const env = this.rpEnv();
    const g = parseAddress(group);
    const v: 4 | 6 = g ? g.version : 4;
    const own = staticRp(this.P.m, env, dev, v);
    if (own === 'family') this.note(`rpfamily|${dev}|${v}`, 'note', dev, `PIM: ${dev}'s static RP ${(this.P.m.index.devices.get(dev) as { services: Array<{ id: string; values: Map<string, string> }> }).services.find((x) => x.id === 'pim')!.values.get('rp')} is IPv${v === 4 ? 6 : 4}: no RP for its IPv${v} groups from it`);
    const res = rpFor(this.P.m, env, dev, group);
    if (res && own && own !== 'family') {
      for (const d of Array.from(pimDomain(this.P.m, dev)).sort(cmp)) {
        const o = d === dev ? null : staticRp(this.P.m, env, d, v);
        if (o && o !== 'family' && compareAddr(o.addr, res.addr) !== 0) this.note(`rpconflict|${[dev, d].sort().join('|')}|${v}`, 'note', dev, `PIM: ${dev}'s RP is ${formatAddr(res.addr)} (its static RP), ${d}'s is ${formatAddr(o.addr)} (its static RP): they disagree in one PIM domain — each joins and registers towards its own, and their trees do not meet`);
      }
    }
    return res;
  }

  // ------------------------------------------------------------ IGMP / MLD messages

  /** The IGMP / MLD version of an interface (its own, else its device's, …); without one, the device's. */
  private ver(dev: string, iface?: string): 'v2' | 'v3' {
    return this.e.params.str('igmp-version', dev, iface ? ifaceRef(dev, iface) : null) === 'v2' ? 'v2' : 'v3';
  }

  private name(v: 4 | 6): string {
    return v === 4 ? 'IGMP' : 'MLD';
  }

  private verName(v: 4 | 6, ver: string): string {
    return v === 4 ? `IGMP${ver}` : ver === 'v3' ? 'MLDv2' : 'MLDv1';
  }

  /** Send an IGMP / MLD message out of an interface (TTL 1, link-local or the group). */
  private igmpSend(dev: string, l3: L3Iface, src: IpAddr, dst: IpAddr, type: string, label: string, detail: string, f: NonNullable<L4['igmp']>, data: { [k: string]: unknown }): void {
    const v = dst.version;
    const msg: Msg = { protocol: 'igmp', type, label, detail, data: { from: dev, ...data } };
    const pkt = this.e.newPacket(src, dst, l3.vrf, msg, [], 1);
    const icmp6: { [k: string]: number } = { Query: 130, 'Report v1': 131, Leave: 132, 'Report v2': 143 };
    const kind = type.indexOf('Query') >= 0 ? 'Query' : type === 'Leave' ? 'Leave' : f.version === 'MLDv2' ? 'Report v2' : 'Report v1';
    pkt.l4 = v === 4 ? { proto: 'igmp', num: 2, igmp: f } : { proto: 'icmp', num: 58, icmpType: icmp6[kind], icmpCode: 0, icmpName: `MLD ${type}`, igmp: f };
    pkt.len = 8 + 4 * ((f.sources || []).length + (f.records || []).length);
    this.e.note('message', 'igmp', dev, '', type, '', detail, this.e.now, msg);
    this.e.send(dev, pkt, l3);
  }

  /** The IP address of a host's interface for a group's family. */
  private hostAddr(dev: string, iface: string, v: 4 | 6): { l3: L3Iface; addr: IpAddr } | null {
    const sd = this.P.sd(dev);
    const l3 = sd ? sd.l3.get(iface) : undefined;
    const a = l3 ? l3.addrs.find((x) => x.addr.version === v) : undefined;
    return l3 && a ? { l3, addr: a.addr } : null;
  }

  /** A host reports its membership of a group (v3 / MLDv2: a record with its sources; v2: to the group). */
  private report(dev: string, iface: string, hg: HostGroup, why: string, leave = false): void {
    const g = A(hg.group);
    const h = this.hostAddr(dev, iface, g.version);
    if (!h || !this.e.deviceOn(dev)) return;
    const ver = this.ver(dev, iface);
    const n = this.name(g.version);
    const vn = this.verName(g.version, ver);
    if (leave) {
      if (ver === 'v2') {
        const all = A(g.version === 4 ? '224.0.0.2' : 'ff02::2');
        this.igmpSend(dev, h.l3, h.addr, all, 'Leave', `${n} Leave ${hg.group}`, `${vn} ${g.version === 4 ? 'Leave Group' : 'Done'} from ${dev} (${formatAddr(h.addr)}) for ${hg.group} to ${formatAddr(all)}: ${why}`, { type: g.version === 4 ? 'Leave Group' : 'Done', version: vn, group: hg.group }, { group: hg.group, leave: true });
      } else {
        const all = A(g.version === 4 ? '224.0.0.22' : 'ff02::16');
        const rec = hg.sources.length ? `BLOCK (${hg.group}, {${hg.sources.join(', ')}})` : `TO_IN (${hg.group}, {})`;
        this.igmpSend(dev, h.l3, h.addr, all, 'Report', `${n} Report ${hg.group} (leave)`, `${vn} Report from ${dev} (${formatAddr(h.addr)}) to ${formatAddr(all)}: ${rec}, ${why}`, { type: 'Membership Report', version: vn, group: hg.group, records: [rec] }, { group: hg.group, leave: true, sources: hg.sources });
      }
      return;
    }
    if (ver === 'v2') {
      this.igmpSend(dev, h.l3, h.addr, g, 'Report', `${n} Report ${hg.group}`, `${vn} Membership Report from ${dev} (${formatAddr(h.addr)}) to ${hg.group}: ${why}`, { type: 'Membership Report', version: vn, group: hg.group }, { group: hg.group });
    } else {
      const all = A(g.version === 4 ? '224.0.0.22' : 'ff02::16');
      const rec = hg.sources.length ? `ALLOW / IS_IN (${hg.group}, {${hg.sources.join(', ')}})` : `IS_EX (${hg.group}, {})`;
      this.igmpSend(dev, h.l3, h.addr, all, 'Report', `${n} Report ${hg.group}`, `${vn} Report from ${dev} (${formatAddr(h.addr)}) to ${formatAddr(all)}: ${rec}, ${why}`, { type: 'Membership Report', version: vn, group: hg.group, sources: hg.sources, records: [rec] }, { group: hg.group, sources: hg.sources });
    }
  }

  // ------------------------------------------------------------ hosts: join and leave

  /** A host joins a group on an interface (the model's join, or a Join group… event); a text when it cannot. */
  /** Why a host can't join a group on an interface now, or null (the checks of `join`, nothing changed). */
  joinProblem(dev: string, iface: string, group: string, sources: string[]): string | null {
    const g = parseAddress(group.trim());
    if (!g || !isMulticastIp(g)) return `${group} is not a multicast group`;
    if (isLinkLocalGroup(g)) return `${group} is a link-local group: it is never joined`;
    if (isSsmGroup(g) && !sources.length) return `${group} is a source-specific group: name its sources`;
    if (sources.length && this.ver(dev, iface) === 'v2') return `${dev} runs ${this.verName(g.version, 'v2')}: it cannot join with a source list`;
    for (const s of sources) {
      const a = parseAddress(s.trim());
      if (!a || a.version !== g.version) return `${s} is not an IPv${g.version} source address`;
    }
    if (!this.hostAddr(dev, iface, g.version)) return `${dev}:${iface} has no IPv${g.version} address`;
    const m = this.hosts.get(dev + '|' + iface);
    if (m && m.has(formatAddr(g))) return `${dev}:${iface} has already joined ${formatAddr(g)}`;
    return null;
  }

  /** Is a host a member of a group on an interface now? */
  isMember(dev: string, iface: string, group: string): boolean {
    const g = parseAddress(group.trim());
    const m = this.hosts.get(dev + '|' + iface);
    return !!g && !!m && m.has(formatAddr(g));
  }

  /** Called when a multicast router's interface records a member's report (Network events follow joins by it). */
  onMember: ((dev: string, iface: string, group: string, reporter: string) => void) | null = null;

  join(dev: string, iface: string, group: string, sources: string[], origin: 'model' | 'event', tag?: number): string | null {
    const bad = this.joinProblem(dev, iface, group, sources);
    if (bad) return bad;
    const g = parseAddress(group.trim()) as IpAddr;
    const key = dev + '|' + iface;
    let m = this.hosts.get(key);
    if (!m) this.hosts.set(key, (m = new Map()));
    const hg: HostGroup = { group: formatAddr(g), sources: sources.map((s) => s.trim()), origin, since: this.e.now, gen: 0, answer: 0, tag };
    m.set(hg.group, hg);
    const ev = this.events.findIndex((x) => x.kind === 'leave' && x.ref === `iface:${dev}:${iface}` && x.group === hg.group);
    if (ev >= 0) this.events.splice(ev, 1);
    else if (origin === 'event') this.events.push({ kind: 'join', ref: `iface:${dev}:${iface}`, group: hg.group, since: this.e.now, state: `joined ${hg.group}${hg.sources.length ? ` (sources ${hg.sources.join(', ')})` : ''}` });
    this.e.note('state', 'igmp', dev, '', 'joins', 'member', `${dev}:${iface} joins ${hg.group}${hg.sources.length ? ' (sources ' + hg.sources.join(', ') + ')' : ''}${origin === 'event' ? ' (Join group)' : ''}`);
    this.e.stateVersion++;
    // an unsolicited report now, repeated after the unsolicited report interval (robustness − 1 more times);
    // a join of Network events: they are its traffic (its answers to later queries are the membership's, not the join's)
    this.e.withTest(hg.tag, () => this.report(dev, iface, hg, 'joins (unsolicited)'));
    const gen = ++hg.gen;
    this.e.after(this.unsolicited(dev, iface), () => {
      if (hg.gen === gen && (this.hosts.get(key) || new Map()).get(hg.group) === hg) this.e.withTest(hg.tag, () => this.report(dev, iface, hg, 'joins (unsolicited, repeated)'));
    });
    return null;
  }

  /** The unsolicited report interval of a host's interface (its second report of a join follows after it). */
  unsolicited(dev: string, iface: string): number {
    const r = this.e.params.num('igmp-unsolicited', dev, null, ifaceRef(dev, iface));
    return r > 0 ? r : this.ver(dev, iface) === 'v2' ? 10000 : 1000;
  }

  /** A host leaves a group (a Leave group… event, or the end of a join event). */
  /**
   * A host leaves a group on an interface: its membership (its intent) ends
   * now — no more answers to queries, its pending answer cancelled — and it
   * says so: an IGMPv2 Leave / MLDv1 Done, or a v3 / MLDv2 report that
   * blocks its sources, through the network like any report (`tag`: the id
   * its leave carries, a Leave group of Network events). The switches and
   * routers then do their part (group-specific queries, their timers).
   */
  leave(dev: string, iface: string, group: string, tag?: number): boolean {
    const key = dev + '|' + iface;
    const m = this.hosts.get(key);
    const g = parseAddress(group.trim());
    const hg = m && g ? m.get(formatAddr(g)) : undefined;
    if (!m || !hg) return false;
    m.delete(hg.group);
    hg.gen++;
    hg.answer++;
    if (tag !== undefined) hg.tag = tag;
    const ev = this.events.findIndex((x) => x.kind === 'join' && x.ref === `iface:${dev}:${iface}` && x.group === hg.group);
    if (ev >= 0) this.events.splice(ev, 1);
    else this.events.push({ kind: 'leave', ref: `iface:${dev}:${iface}`, group: hg.group, since: this.e.now, state: `left ${hg.group}` });
    this.e.note('state', 'igmp', dev, '', 'leaves', '', `${dev}:${iface} leaves ${hg.group}`);
    this.e.stateVersion++;
    this.e.withTest(hg.tag, () => this.report(dev, iface, hg, 'leaves the group', true));
    return true;
  }

  /** Why a host can't leave a group on an interface now (null: it can), the checks of `leave` with nothing changed. */
  leaveProblem(dev: string, iface: string, group: string): string | null {
    const g = parseAddress(group.trim());
    if (!g || !isMulticastIp(g)) return `${group} is not a multicast group`;
    const m = this.hosts.get(dev + '|' + iface);
    if (!m || !m.has(formatAddr(g))) {
      const mine = this.joined(dev).filter((j) => j.iface === iface).map((j) => j.group);
      return `${dev}:${iface} is no member of ${formatAddr(g)}${mine.length ? ` (its groups: ${mine.join(', ')})` : ' (it has joined no group)'}`;
    }
    return null;
  }

  /** What a leave of a host's group will send, and where (its address and VLAN): the form's note. */
  leaveContext(dev: string, iface: string, group: string): string {
    const g = parseAddress(group.trim());
    if (!g || !isMulticastIp(g)) return '';
    const h = this.hostAddr(dev, iface, g.version);
    if (!h) return '';
    const ver = this.ver(dev, iface);
    const v = g.version;
    const vn = this.verName(v, ver);
    const what = ver === 'v2' ? (v === 4 ? 'an IGMPv2 Leave Group to 224.0.0.2' : 'an MLDv1 Done to ff02::2') : `an ${vn} report that blocks ${formatAddr(g)} to ${v === 4 ? '224.0.0.22' : 'ff02::16'}`;
    const net = this.P.m.networks.find((n) => n.vlan !== undefined && !!n.cidr && h.l3.addrs.some((a) => `${formatAddr(a.net)}/${a.net.prefix}` === n.cidr));
    return `${dev}:${iface} (${formatAddr(h.addr)}${net ? ', VLAN ' + net.vlan : ''}) sends ${what}; its membership ends at once.`;
  }

  /** Can a host send its report on an interface now (on, the interface up)? */
  canReport(dev: string, iface: string): boolean {
    return this.e.deviceOn(dev) && this.e.isL3Up(dev, iface);
  }

  /**
   * What the network learned of a host's membership, before it leaves: each
   * snooping switch's member port of the group that faces the host (its MAC
   * learned on that port in that VLAN), and each multicast router's group on
   * the host's subnet. A Leave group of Network events follows these until
   * they are gone (or kept by another member).
   */
  leaveWatch(dev: string, iface: string, group: string): LeaveWatch[] {
    const sd = this.P.sd(dev);
    const l3 = sd ? sd.l3.get(iface) : undefined;
    const g = parseAddress(group.trim());
    if (!l3 || !g) return [];
    const gt = formatAddr(g);
    const out: LeaveWatch[] = [];
    for (const [k, st] of Array.from(this.snoops).sort((a, b) => cmp(a[0], b[0]))) {
      const sw = k.slice(0, k.indexOf('|'));
      const vlan = Number(k.slice(k.indexOf('|') + 1));
      const ports = st.groups.get(gt);
      if (!ports) continue;
      const facing = this.e.macRows(sw).find((r) => r.vlan === vlan && r.mac === l3.mac);
      if (facing && ports.has(facing.port)) out.push({ kind: 'snoop', dev: sw, vlan, port: facing.port, group: gt, where: `${sw} (VLAN ${vlan}, port ${facing.port})` });
    }
    for (const ri of Array.from(this.rifs.values()).sort((a, b) => cmp(a.name, b.name))) {
      if (!ri.groups.has(gt) || !l3.addrs.some((a) => ri.l3.addrs.some((r) => inNet(r, a.addr)))) continue;
      out.push({ kind: 'router', dev: ri.dev, iface: ri.l3.id, group: gt, where: `${ri.dev}:${ri.l3.id}` });
    }
    return out;
  }

  /** A watched entry now: still there (and who reported it last), or gone. */
  watchState(w: LeaveWatch): { present: boolean; reporter?: string } {
    if (w.kind === 'snoop') {
      const st = this.snoops.get(w.dev + '|' + w.vlan);
      const e = st ? (st.groups.get(w.group) || new Map<string, SnoopPort>()).get(w.port as string) : undefined;
      return e && e.until > this.e.now ? { present: true, reporter: e.reporter } : { present: false };
    }
    for (const ri of this.rifs.values()) {
      if (ri.dev !== w.dev || ri.l3.id !== w.iface) continue;
      const g = ri.groups.get(w.group);
      if (g) return { present: true, reporter: g.reporter };
    }
    return { present: false };
  }

  /** How long the network may take after a leave (the last member queries of the slowest, and a second for the way). */
  leaveTime(watch: LeaveWatch[]): number {
    let t = 0;
    for (const w of watch) t = Math.max(t, this.e.params.num('igmp-robustness', w.dev) * this.e.params.num('igmp-lmqi', w.dev));
    return t + 1000;
  }

  /** The groups a host has joined now, by interface. */
  joined(dev: string): Array<{ iface: string; group: string; sources: string[]; origin: string }> {
    const out: Array<{ iface: string; group: string; sources: string[]; origin: string }> = [];
    for (const [k, m] of Array.from(this.hosts).sort((a, b) => cmp(a[0], b[0]))) {
      if (k.slice(0, k.indexOf('|')) !== dev) continue;
      for (const hg of m.values()) out.push({ iface: k.slice(k.indexOf('|') + 1), group: hg.group, sources: hg.sources, origin: hg.origin });
    }
    return out;
  }

  /** Is a host a member of a group on an interface, for a source (SSM: only its sources)? */
  member(dev: string, iface: string, group: IpAddr, source: IpAddr): boolean {
    const m = this.hosts.get(dev + '|' + iface);
    const hg = m ? m.get(formatAddr(group)) : undefined;
    return !!hg && (!hg.sources.length || hg.sources.indexOf(formatAddr(source)) >= 0);
  }

  // ------------------------------------------------------------ routers: queriers and membership

  /** A querier's General Queries, from now on (its first at once). */
  // ------------------------------------------------------------ the querier election (routers and snooping switches alike)

  /**
   * A candidate starts (its interface, or the switch, came up): it takes
   * itself for the querier (RFC 3376 §6.6, RFC 3810 §7.6) and sends its
   * startup queries — robustness of them, a quarter of the query interval
   * apart (§8.6, §8.7) — then one General Query every query interval while
   * it stays the querier. One schedule per candidate: a newer start (its
   * generation) ends an older one, so nothing runs twice.
   */
  private startElection(c: Cand): void {
    c.gen++;
    c.otherTok++;
    c.running = true;
    c.otherAt = -1;
    c.otherAddr = '';
    c.querier = c.enabled();
    c.startup = c.querier ? Math.max(1, this.e.params.num('igmp-robustness', c.dev, null, c.at)) : 0;
    c.startupOf = c.startup;
    c.since = this.e.now;
    c.takeoverAt = -1;
    if (c.querier) this.e.note('state', 'igmp', c.dev, '', 'querier (starting)', 'querier', `${c.name} starts as ${this.name(c.addr.version)} querier candidate (${formatAddr(c.addr)}): it queries until it hears a lower address (startup: ${c.startup} queries ${durationText(this.e.params.num('igmp-query', c.dev, null, c.at) / 4)} apart)`);
    const gen = c.gen;
    const tick = (): void => {
      if (c.gen !== gen || !c.running) return;
      if (c.querier && c.enabled() && c.up()) {
        c.send();
        c.queries++;
        c.lastQuery = this.e.now;
        if (c.startup > 0 && --c.startup === 0) this.e.note('state', 'igmp', c.dev, '', 'querier', 'querier', `${c.name} is the ${this.name(c.addr.version)} querier: its startup queries are sent and no lower address was heard`);
      }
      const q = this.e.params.num('igmp-query', c.dev, null, c.at);
      const wait = c.querier && c.startup > 0 ? Math.max(250, Math.round(q / 4)) : q;
      c.nextAt = c.querier ? this.e.now + wait : -1;
      this.e.after(wait, tick);
    };
    tick();
  }

  /** A candidate stops taking part (its interface or device went down): its schedules end, its role with them. */
  private stopElection(c: Cand): void {
    c.gen++;
    c.otherTok++;
    c.running = false;
    c.querier = false;
    c.startup = 0;
    c.otherAt = -1;
    c.nextAt = -1;
    c.takeoverAt = -1;
  }

  /**
   * A candidate hears another's query. A lower address wins (IGMPv2 / v3 and
   * MLD alike): it stops querying and waits; when it hears nothing from the
   * winner for the other querier present interval (robustness × query
   * interval + response interval ÷ 2) it takes over. A higher address it
   * ignores (that one stops on hearing this one).
   */
  private heardQuery(c: Cand, src: IpAddr, from: string, t: number): void {
    if (!c.running || compareAddr(src, c.addr) >= 0) return;
    const was = c.querier;
    c.querier = false;
    c.startup = 0;
    c.nextAt = -1;
    c.otherAt = t;
    c.otherAddr = formatAddr(src) + (from ? ` (${from})` : '');
    if (was) this.e.at(t, () => this.e.note('state', 'igmp', c.dev, from, 'not querier', '', `${c.name} hears a query from ${formatAddr(src)} (lower than its ${formatAddr(c.addr)}): it stops querying (querier election)`));
    const tok = ++c.otherTok;
    const wait = this.otherPresent(c.dev, c.iface, c.at);
    c.takeoverAt = t + wait;
    this.e.at(t + wait, () => {
      if (c.otherTok !== tok || !c.running || !c.enabled() || c.querier) return;
      c.querier = true;
      c.since = this.e.now;
      c.takeoverAt = -1;
      this.e.note('state', 'igmp', c.dev, '', 'querier', 'querier', `${c.name} takes over as ${this.name(c.addr.version)} querier: no query from ${c.otherAddr} for ${durationText(wait)} (other querier present interval)`);
      // its regular schedule from now: a General Query at once, then every query interval
      c.gen++;
      const gen = c.gen;
      const tick = (): void => {
        if (c.gen !== gen || !c.running) return;
        if (c.querier && c.enabled() && c.up()) {
          c.send();
          c.queries++;
          c.lastQuery = this.e.now;
        }
        const q = this.e.params.num('igmp-query', c.dev, null, c.at);
        c.nextAt = c.querier ? this.e.now + q : -1;
        this.e.after(q, tick);
      };
      tick();
    });
  }

  /** A candidate's role now: starting (provisionally the querier), querier, non-querier, not a candidate (configured off), or down. */
  private roleOf(c: Cand): QuerierRole {
    if (!c.running) return 'down';
    if (!c.enabled()) return 'off';
    if (c.querier) return c.startup > 0 ? 'starting' : 'querier';
    return 'non-querier';
  }

  /**
   * Every querier candidate and its role (Show IGMP / MLD groups, the
   * snooping table, the diagram's querier marks): a router's interfaces with
   * IGMP / MLD, a switch's VLANs with the snooping querier on, snooping
   * enabled and an address there. The role is the election's (the queries
   * heard and sent), never the configuration's.
   */
  querierRoles(dev?: string): QuerierInfo[] {
    const out: QuerierInfo[] = [];
    const now = this.e.now;
    for (const c of this.candidates()) {
      if (dev !== undefined && c.dev !== dev) continue;
      const role = this.roleOf(c);
      const left = role === 'non-querier' && c.otherAt >= 0 ? Math.max(0, c.otherAt + this.otherPresent(c.dev, c.iface, c.at) - now) : undefined;
      out.push({ dev: c.dev, kind: c.vlan !== undefined ? 'switch' : 'router', iface: c.iface, vlan: c.vlan, lan: c.lan, family: this.name(c.addr.version), addr: formatAddr(c.addr), role, other: role === 'non-querier' ? c.otherAddr || undefined : undefined, otherLeft: left, queries: c.queries, lastQuery: c.lastQuery, since: c.since, nextAt: role === 'starting' || role === 'querier' ? c.nextAt : -1, startup: role === 'starting' ? `${c.startupOf - c.startup + 1} of ${c.startupOf}` : '', takeoverAt: role === 'non-querier' ? c.takeoverAt : -1 });
    }
    return out.sort((a, b) => cmp(a.dev, b.dev) || cmp(a.lan, b.lan) || cmp(a.family, b.family));
  }

  /**
   * A switch's role in each VLAN where its snooping is enabled, in VLAN
   * order (none: no snooping switch, or snooping enabled nowhere). Every
   * such VLAN has one, whatever happens in it.
   */
  snoopRoles(dev: string): SnoopRole[] {
    const sd = this.P.m.index.devices.get(dev);
    const sim = this.e.net.devices.get(dev);
    if (!sd || !sim || !sim.bridge || !sim.caps.switchFeatures) return [];
    const now = this.e.now;
    const cands = new Map<number, QuerierInfo>();
    for (const q of this.querierRoles(dev)) if (q.kind === 'switch' && q.vlan !== undefined && q.family === 'IGMP') cands.set(q.vlan, q);
    const out: SnoopRole[] = [];
    const ps = this.e.powerState(dev);
    const down = ps && ps.state !== 'on' ? ps.state : null;
    for (const vlan of switchedVlans(sd).slice().sort((a, b) => a - b)) {
      if (this.snoopMode(dev, vlan) !== 'enabled') continue;
      // powered off or still booting: it snoops nothing yet (its tables empty, learned again once it is up)
      if (down) {
        out.push({ dev, vlan, role: down === 'booting' ? 'booting' : 'off', querier: null, routerPorts: [], unregistered: this.unregisteredPolicy(dev, vlan), text: `VLAN ${vlan} · ${down === 'booting' ? 'Booting' : 'Off'}`, detail: `${dev}: ${down === 'booting' ? 'booting' : 'powered off'}: it snoops nothing in VLAN ${vlan} (its tables are empty; learned again once it is up)` });
        continue;
      }
      const st = this.snoops.get(dev + '|' + vlan);
      const c = cands.get(vlan);
      const role: SnoopRole['role'] = !c || c.role === 'off' ? 'snooping' : c.role === 'non-querier' ? 'standby' : c.role === 'down' ? 'down' : c.role;
      const heard = st && st.querier && st.querier.until > now ? st.querier : null;
      const querier: SnoopRole['querier'] = role === 'querier' || role === 'starting' ? { self: true } : heard ? { self: false, ...heard } : null;
      const routerPorts = st ? Array.from(st.routerPorts).filter(([, u]) => u > now).sort((a, b) => cmp(a[0], b[0])).map(([port, until]) => ({ port, until })) : [];
      const presence = querier ? 'querier heard' : 'no querier';
      const word = role === 'querier' ? 'Querier' : role === 'starting' ? 'Querier (startup)' : role === 'standby' ? 'Standby' : role === 'down' ? `Candidate down · ${presence}` : `Snooping · ${presence}`;
      const who = querier && !querier.self ? `${querier.dev || querier.addr} (${querier.addr}, behind port ${querier.port})` : '';
      const own = role === 'querier' ? `the elected IGMP querier of VLAN ${vlan} (snooping querier${c ? `, from ${c.addr}` : ''})` : role === 'starting' ? `the IGMP querier of VLAN ${vlan} for now, sending its startup queries${c ? ` from ${c.addr}` : ''}` : role === 'standby' ? `a standby querier candidate in VLAN ${vlan}: ${who || 'another querier'} queries` : role === 'down' ? `a querier candidate in VLAN ${vlan} that is down (its VLAN interface or ports)` : `snooping only in VLAN ${vlan} (no querier candidate)`;
      const q = querier ? (querier.self ? '' : role === 'standby' ? '' : `; the querier there is ${who}`) : `; no querier heard there: members are learned from their own reports only, and a group without members reaches no host`;
      const rp = routerPorts.length ? `; multicast router port${routerPorts.length > 1 ? 's' : ''} ${routerPorts.map((r) => r.port).join(', ')}` : '; no multicast router port';
      const un = `; unregistered multicast ${this.unregisteredPolicy(dev, vlan) === 'flood' ? 'flooded' : 'to the router ports only'}`;
      out.push({ dev, vlan, role, querier, routerPorts, unregistered: this.unregisteredPolicy(dev, vlan), text: `VLAN ${vlan} · ${word}`, detail: `${dev}: ${own}${q}${rp}${un}` });
    }
    return out;
  }

  /**
   * The VLANs where a snooping switch has members (someone joined) but no
   * querier: no query heard there (no router port) and it is no querier of
   * its own. Its memberships are then only learned from the members' own
   * reports, and age out after the membership interval.
   */
  noQuerierVlans(dev: string): number[] {
    const out: number[] = [];
    const now = this.e.now;
    for (const [k, st] of Array.from(this.snoops).sort((a, b) => cmp(a[0], b[0]))) {
      if (k.slice(0, k.indexOf('|')) !== dev) continue;
      const vlan = Number(k.slice(k.indexOf('|') + 1));
      if (!vlan || this.snoopMode(dev, vlan) !== 'enabled') continue;
      const members = Array.from(st.groups.values()).some((ports) => Array.from(ports.values()).some((e) => e.until > now));
      const routers = Array.from(st.routerPorts.values()).some((u) => u > now);
      const own = this.sqs.get(dev + '|' + vlan);
      if (members && !routers && !(own && own.running && own.querier)) out.push(vlan);
    }
    return out;
  }

  /** The candidates, routers' interfaces and switches' VLANs, in a fixed order. */
  private candidates(): Cand[] {
    const out: Cand[] = [];
    for (const k of Array.from(this.rifs.keys()).sort(cmp)) out.push(this.rifs.get(k) as Cand);
    for (const k of Array.from(this.sqs.keys()).sort(cmp)) out.push(this.sqs.get(k) as Cand);
    return out;
  }

  /** A router interface's object reference (its querier's settings). */
  private at(ri: RIface): string {
    return ifaceRef(ri.dev, ri.l3.id);
  }

  /** robustness × query interval + response interval ÷ 2 (RFC 3376 §8.5), of an interface (none: the device's; `at`: where its timers are). */
  private otherPresent(dev: string, iface?: string, where?: string | null): number {
    const at = where !== undefined ? where : iface ? ifaceRef(dev, iface) : null;
    return this.e.params.num('igmp-robustness', dev, null, at) * this.e.params.num('igmp-query', dev, null, at) + this.e.params.num('igmp-max-resp', dev, null, at) / 2;
  }

  /** robustness × query interval + response interval (RFC 3376 §8.4), of an interface (none: the device's). */
  private gmi(dev: string, iface?: string): number {
    const at = iface ? ifaceRef(dev, iface) : null;
    return this.e.params.num('igmp-robustness', dev, null, at) * this.e.params.num('igmp-query', dev, null, at) + this.e.params.num('igmp-max-resp', dev, null, at);
  }

  private generalQuery(ri: RIface): void {
    ri.queries++;
    const v = ri.addr.version;
    const all = A(v === 4 ? '224.0.0.1' : 'ff02::1');
    const mrt = this.e.params.num('igmp-max-resp', ri.dev, null, this.at(ri));
    const vn = this.verName(v, this.ver(ri.dev, ri.l3.id));
    this.igmpSend(ri.dev, ri.l3, ri.addr, all, 'Query', `${this.name(v)} Query (general)`, `${vn} General Query from ${ri.dev} (${formatAddr(ri.addr)}, the querier) to ${formatAddr(all)}: which groups have members? Answer within ${durationText(mrt)}`, { type: 'Membership Query (general)', version: vn, maxResp: mrt / 1000 }, { maxResp: mrt, querier: formatAddr(ri.addr) });
  }

  private groupQuery(ri: RIface, group: string): void {
    const v = ri.addr.version;
    const lmqi = this.e.params.num('igmp-lmqi', ri.dev, null, this.at(ri));
    const vn = this.verName(v, this.ver(ri.dev, ri.l3.id));
    this.igmpSend(ri.dev, ri.l3, ri.addr, A(group), 'Query', `${this.name(v)} Query ${group}`, `${vn} Group-Specific Query from ${ri.dev} (${formatAddr(ri.addr)}) to ${group}: any members left? Answer within ${durationText(lmqi)}`, { type: 'Membership Query (group-specific)', version: vn, group, maxResp: lmqi / 1000 }, { maxResp: lmqi, group, querier: formatAddr(ri.addr) });
  }

  private rifsAt(dev: string, l3: L3Iface, v: 4 | 6): RIface | undefined {
    return this.rifs.get(`${dev}|${l3.id}|${v}`);
  }

  /** IGMP / MLD at a device: a router learns members and queriers; a host answers queries (or suppresses its answer). */
  private igmpIn(dev: string, l3: L3Iface, msg: Msg, pkt: Pkt): void {
    const d = (msg.data || {}) as { group?: string; leave?: boolean; sources?: string[]; maxResp?: number; querier?: string; from?: string };
    if (d.from === dev) return;
    const v = pkt.src.version;
    const ri = this.rifsAt(dev, l3, v);
    if (ri) {
      if (msg.type === 'Query') {
        // the querier election: a query from a lower address makes that one the querier
        this.heardQuery(ri, pkt.src, d.from || '', this.e.now);
        // a group-specific query after a leave: the membership runs out after the last member queries
        if (d.group && ri.groups.has(d.group)) {
          const g = ri.groups.get(d.group) as RGroup;
          g.expires = Math.min(g.expires, this.e.now + this.e.params.num('igmp-robustness', dev, null, this.at(ri)) * this.e.params.num('igmp-lmqi', dev, null, this.at(ri)));
          g.leaving = true;
          this.expireAt(g.expires);
        }
        return;
      }
      if (!d.group) return;
      if (d.leave) this.memberLeft(ri, d.group, formatAddr(pkt.src), d.sources || []);
      else this.memberReported(ri, d.group, formatAddr(pkt.src), msg, d.sources || []);
      return;
    }
    // a host
    // (the last query it heard: who queries its LAN, for its memberships table)
    if (msg.type === 'Query') this.heard.set(`${dev}|${l3.id}|${v}`, { from: `${formatAddr(pkt.src)}${d.from ? ' (' + d.from + ')' : ''}`, at: this.e.now });
    const m = this.hosts.get(dev + '|' + l3.id);
    if (!m) return;
    if (msg.type === 'Query') {
      const mrt = d.maxResp || 10000;
      const list = d.group ? [m.get(d.group)].filter((x): x is HostGroup => !!x) : Array.from(m.values());
      for (const hg of list.sort((a, b) => cmp(a.group, b.group))) {
        if (A(hg.group).version !== v) continue;
        const delay = Math.floor(this.e.random() * mrt);
        const tok = ++hg.answer;
        this.e.after(delay, () => {
          if (hg.answer !== tok || m.get(hg.group) !== hg) return;
          this.report(dev, l3.id, hg, `answers the ${d.group ? 'group-specific' : 'general'} query of ${formatAddr(pkt.src)} after ${durationText(delay)} (random, up to ${durationText(mrt)})`);
        });
      }
      return;
    }
    // another member's report for a group: an IGMPv2 / MLDv1 host sends none of its own (report suppression)
    if (msg.type === 'Report' && d.group && !d.leave && this.ver(dev, l3.id) === 'v2') {
      const hg = m.get(d.group);
      if (hg && hg.answer > 0) {
        hg.answer++;
        this.e.note('table', 'igmp', dev, '', 'report suppressed', '', `${dev} hears ${d.from}'s report for ${d.group}: its own answer is suppressed (${this.verName(v, 'v2')})`);
      }
    }
  }

  private memberReported(ri: RIface, group: string, reporter: string, msg: Msg, sources: string[]): void {
    const isNew = !ri.groups.has(group);
    const g: RGroup = ri.groups.get(group) || { group, reporter, version: '', expires: 0, sources: [], gsq: 0, leaving: false };
    g.leaving = false;
    g.reporter = reporter;
    g.version = (msg.data && (msg.data as { version?: string }).version) || this.verName(A(group).version, sources.length ? 'v3' : this.ver(this.e.ownerOf(A(reporter)) || ri.dev));
    g.expires = this.e.now + this.gmi(ri.dev, ri.l3.id);
    g.gsq = 0;
    for (const s of sources) if (g.sources.indexOf(s) < 0) g.sources.push(s);
    ri.groups.set(group, g);
    if (this.onMember) this.onMember(ri.dev, ri.l3.id, group, reporter);
    if (isNew) {
      this.e.note('table', 'igmp', ri.dev, '', 'member', 'members', `${ri.dev}:${ri.l3.id}: ${group} has a member (${reporter}${sources.length ? ', sources ' + sources.join(', ') : ''}); kept for ${durationText(this.gmi(ri.dev))} without a report (robustness × query interval + response interval)`);
      this.membersChanged(ri.dev, ri.l3, group);
    }
  }

  private memberLeft(ri: RIface, group: string, who: string, sources: string[]): void {
    const g = ri.groups.get(group);
    if (!g) return;
    void sources;
    const lmqi = this.e.params.num('igmp-lmqi', ri.dev, null, this.at(ri));
    const rob = this.e.params.num('igmp-robustness', ri.dev, null, this.at(ri));
    g.expires = Math.min(g.expires, this.e.now + rob * lmqi);
    g.leaving = true;
    this.expireAt(g.expires);
    if (!ri.querier) return;
    // the querier asks: group-specific queries, robustness times, one last member query interval apart
    g.gsq = rob;
    this.e.note('table', 'igmp', ri.dev, '', 'leave', '', `${ri.dev}:${ri.l3.id}: ${who} leaves ${group}; ${rob} group-specific queries ${durationText(lmqi)} apart, then the group goes unless a member answers`);
    const ask = (): void => {
      if (g.gsq <= 0 || ri.groups.get(group) !== g || !ri.querier) return;
      g.gsq--;
      this.groupQuery(ri, group);
      if (g.gsq > 0) this.e.after(lmqi, ask);
    };
    ask();
  }

  // ------------------------------------------------------------ snooping

  /** A switch's IGMP / MLD snooping in a VLAN: its own configuration (model/snooping.ts), enabled, disabled or not configured. */
  snoopMode(dev: string, vlan: number): SnoopingChoice {
    return snoopingChoice(this.P.m.index.devices.get(dev), vlan);
  }

  private snoopState(dev: string, vlan: number): Snoop {
    const k = dev + '|' + vlan;
    let s = this.snoops.get(k);
    if (!s) this.snoops.set(k, (s = { routerPorts: new Map(), groups: new Map() }));
    return s;
  }

  /**
   * A switch forwards a frame to a group MAC in a VLAN (RFC 4541 §2.1): the
   * ports that get it and why. Snooping enabled: it learns router ports
   * (queries, PIM Hellos: a multicast router or a querier there) and member
   * ports (reports, per group); reports and leaves go to the router ports
   * only (§2.1.1); link-local groups (224.0.0.0/24, ff02::/16: queries, the
   * routing protocols) are flooded; a group's data goes to its member ports
   * and the router ports (§2.1.2). A group without members (unregistered)
   * goes by the VLAN's own policy, `unregistered_multicast`: to the router
   * ports only (the default: what the RFC requires; none there, nowhere), or
   * flooded to every port (what it allows). Snooping disabled or not
   * configured: flooded in the VLAN (not configured is a configuration
   * error, said once). Never back out of the ingress port (the caller).
   */
  snoop(sd: SimDevice, from: string | null, vlan: number, frame: Frame, t: number): SnoopResult | null {
    if (!sd.caps.switchFeatures || !frame.ip || !isMulticastIp(frame.ip.dst)) return null;
    const p = frame.ip;
    const mode = this.snoopMode(sd.id, vlan);
    const unregistered = this.unregisteredPolicy(sd.id, vlan);
    if (mode !== 'enabled') {
      if (mode === 'unset' && !isLinkLocalGroup(p.dst)) this.snoopNote(`snoopunset|${sd.id}|${vlan}`, 'note', sd.id, `${sd.id} floods ${frame.msg.label} to ${formatAddr(p.dst)} in ${vlanName(vlan)}: its IGMP / MLD snooping is not configured there (a configuration error: choose enabled or disabled)`, t, frame.msg);
      return { ports: null, members: new Map(), routers: new Map(), kind: isLinkLocalGroup(p.dst) ? 'linklocal' : 'off', mode, unregistered };
    }
    const st = this.snoopState(sd.id, vlan);
    const msg = p.msg;
    const d = (msg.data || {}) as { group?: string; leave?: boolean; sources?: string[]; from?: string };
    const routerMap = (): Map<string, number> => {
      const out = new Map<string, number>();
      for (const [port, until] of st.routerPorts) if (until > t) out.set(port, until);
      return out;
    };
    const fam = p.dst.version === 4 ? 'IGMP' : 'MLD';
    if (from !== null) {
      // a query or a PIM Hello: a multicast router (or the VLAN's querier) there
      if ((msg.protocol === 'igmp' && msg.type === 'Query') || (msg.protocol === 'pim' && msg.type === 'Hello')) {
        if (!st.routerPorts.has(from) || (st.routerPorts.get(from) as number) <= t) this.noteAt(t, 'table', sd.id, `${sd.id}: port ${from} is a multicast router port in ${vlanName(vlan)} (${msg.protocol === 'pim' ? 'PIM Hello' : fam + ' query'} from ${formatAddr(p.src)})`);
        st.routerPorts.set(from, t + this.e.params.num('mrouter-aging', sd.id));
        // the querier this VLAN hears (its general queries), until the other querier present interval is over
        if (msg.protocol === 'igmp' && !d.group) st.querier = { addr: formatAddr(p.src), dev: d.from || '', port: from, until: t + this.otherPresent(sd.id) };
        // its own snooping querier of the VLAN hears it: the querier election
        const sq = this.sqs.get(sd.id + '|' + vlan);
        if (sq && msg.protocol === 'igmp' && p.src.version === 4) this.heardQuery(sq, p.src, d.from || '', t);
      }
      if (msg.protocol === 'igmp' && msg.type !== 'Query' && d.group) {
        let ports = st.groups.get(d.group);
        if (!ports) st.groups.set(d.group, (ports = new Map()));
        const cur = ports.get(from);
        if (d.leave) {
          if (this.e.params.str('fast-leave', sd.id, vlanRef(vlan)) === 'on') {
            if (ports.delete(from)) this.noteAt(t, 'table', sd.id, `${sd.id}: port ${from} leaves ${d.group} in ${vlanName(vlan)} at once (fast leave)`);
          } else if (cur) {
            cur.until = Math.min(cur.until, t + this.e.params.num('igmp-robustness', sd.id) * this.e.params.num('igmp-lmqi', sd.id));
            cur.leaving = true;
            this.expireAt(cur.until);
            // the VLAN's querier itself: it asks whether a member is left (another member behind that port keeps it)
            const sq = this.sqs.get(sd.id + '|' + vlan);
            if (sq && sq.querier && sq.running && p.src.version === 4) this.snoopLeave(sd, sq, d.group, formatAddr(p.src), t);
          }
          if (!ports.size) st.groups.delete(d.group);
        } else {
          if (!cur) {
            this.noteAt(t, 'table', sd.id, `${sd.id}: port ${from} is a member port of ${d.group} in ${vlanName(vlan)} (${fam} report from ${formatAddr(p.src)})`);
            const grp = d.group;
            if (this.onMember) this.e.at(t, () => (this.onMember as NonNullable<Multicast['onMember']>)(sd.id, `${vlanName(vlan)}, port ${from}`, grp, formatAddr(p.src)));
          }
          const f = p.l4 && p.l4.igmp ? p.l4.igmp : null;
          ports.set(from, { until: t + this.gmi(sd.id), reporter: formatAddr(p.src), version: f && f.version ? f.version : fam, sources: (d.sources || []).slice() });
        }
      }
    }
    // a group-specific query: the members of that group time out after the last member queries
    if (msg.protocol === 'igmp' && msg.type === 'Query' && d.group) {
      const ports = st.groups.get(d.group);
      if (ports)
        for (const e of ports.values()) {
          e.until = Math.min(e.until, t + this.e.params.num('igmp-robustness', sd.id) * this.e.params.num('igmp-lmqi', sd.id));
          e.leaving = true;
          this.expireAt(e.until);
        }
    }
    const routers = routerMap();
    // reports and leaves go to the router ports only: other hosts never hear them
    if (msg.protocol === 'igmp' && msg.type !== 'Query') return { ports: new Set(routers.keys()), members: new Map(), routers, kind: 'control', mode, unregistered };
    // link-local groups (queries, PIM, OSPF …: the protocols' own control traffic) are flooded
    if (isLinkLocalGroup(p.dst)) return { ports: null, members: new Map(), routers, kind: 'linklocal', mode, unregistered };
    // a group's data: its member ports and the router ports
    const g = formatAddr(p.dst);
    const members = new Map<string, number>();
    const leaving = new Set<string>();
    const mine = st.groups.get(g);
    if (mine)
      for (const [port, e] of mine)
        if (e.until > t) {
          members.set(port, e.until);
          if (e.leaving) leaving.add(port);
        }
    // unregistered (no member): its VLAN's policy — the router ports only, or flooded
    if (!members.size && unregistered === 'flood') {
      this.snoopNote(`snoopflood|${sd.id}|${vlan}|${g}|${msg.test}`, 'note', sd.id, `${sd.id} floods ${g} in ${vlanName(vlan)}: no member reported it there, and its unregistered multicast is flooded (unregistered_multicast: flood)`, t, msg);
      return { ports: null, members, leaving, routers, kind: 'data', mode, unregistered };
    }
    const keep = new Set<string>([...routers.keys(), ...members.keys()]);
    // (nowhere at all: where the group's way ends, as a drop of its traffic; to router ports only: a note)
    const own = this.sqs.get(sd.id + '|' + vlan);
    const why = own && own.running && own.querier ? `it is the VLAN's querier itself and no multicast router is there` : `no query or PIM Hello heard in ${vlanName(vlan)}: no querier there`;
    if (!members.size) this.snoopNote(`snoopnone|${sd.id}|${vlan}|${g}|${msg.test}`, keep.size ? 'note' : 'drop', sd.id, keep.size ? `${sd.id} sends ${g} to no host port in ${vlanName(vlan)}: no member reported it there (IGMP / MLD snooping enabled); only to its multicast router port${keep.size > 1 ? 's' : ''} ${Array.from(keep).sort(cmp).join(', ')}` : `${sd.id} forwards ${g} to no port in ${vlanName(vlan)}: no member reported it there and it has no multicast router port (${why}; unregistered multicast goes to the router ports only)`, t, msg);
    return { ports: keep, members, leaving, routers, kind: 'data', mode, unregistered };
  }

  /** A switch's policy for unregistered multicast in a VLAN (a group without members): 'router-ports' or 'flood'. */
  unregisteredPolicy(dev: string, vlan: number): string {
    return this.e.params.str('unregistered-mc', dev, vlanRef(vlan));
  }

  /** A line of a switch's snooping about a frame, at the moment it passes, at most every 10 s per key (its traffic's: a stream's events find it). */
  private snoopNote(key: string, kind: 'drop' | 'note', dev: string, text: string, t: number, msg: Msg): void {
    this.e.at(t, () => {
      const last = this.noted.get(key);
      if (last !== undefined && this.e.now - last < 10000) return;
      this.noted.set(key, this.e.now);
      this.e.withTest(msg.test, () => this.e.note(kind, 'mcast', dev, '', kind === 'drop' ? 'filtered' : 'snooping', '', text));
    });
  }

  /** A switch's port lost its link: the router and member ports learned there go (in every VLAN). */
  private portDown(dev: string, port: string): void {
    for (const [k, st] of Array.from(this.snoops).sort((a, b) => cmp(a[0], b[0]))) {
      if (k.slice(0, k.indexOf('|')) !== dev) continue;
      const vlan = Number(k.slice(k.indexOf('|') + 1));
      if (st.routerPorts.delete(port)) this.e.note('table', 'igmp', dev, '', 'router port removed', '', `${dev}: port ${port} is no multicast router port in ${vlanName(vlan)} any more (its link went down)`);
      for (const [g, ports] of Array.from(st.groups)) {
        if (ports.delete(port)) this.e.note('table', 'igmp', dev, '', 'member port removed', '', `${dev}: port ${port} is no member port of ${g} in ${vlanName(vlan)} any more (its link went down)`);
        if (!ports.size) st.groups.delete(g);
      }
    }
  }

  /** A link went down: each switch at its ends forgets what it learned on that port. */
  private linkDown(ref: string): void {
    for (const sd of Array.from(this.e.net.devices.values()).sort((a, b) => cmp(a.id, b.id))) {
      if (!sd.bridge || !sd.caps.switchFeatures) continue;
      for (const bp of Array.from(sd.bridgePorts.values()).sort((a, b) => cmp(a.id, b.id))) {
        const hit = bp.members.some((m) => {
          const e = this.e.net.ends.get(sd.id + '|' + m);
          return !!e && 'link:' + e.link === ref;
        });
        if (hit) this.portDown(sd.id, bp.id);
      }
    }
  }

  /**
   * A switch's snooping querier candidates: each VLAN it carries with the
   * snooping querier on (the VLAN's attribute) and snooping enabled (its
   * own setting), from its VLAN interface's IPv4 address there. Enabling
   * snooping alone makes no candidate, and a VLAN without an address can't
   * have one (the log says so). Each takes part in the election of its VLAN
   * as a router does (the lowest address queries), from the moment the
   * switch's first port is up.
   */
  private snoopCandidates(sd: SimDevice): void {
    const vlans = new Set<number>();
    for (const bp of sd.bridgePorts.values()) {
      if (bp.vlans.tagged !== 'all') for (const v of bp.vlans.tagged) vlans.add(v);
      if (bp.vlans.untagged !== null) vlans.add(bp.vlans.untagged);
    }
    const dev = sd.id;
    for (const vlan of Array.from(vlans).sort((a, b) => a - b)) {
      if (!vlan || this.e.params.str('snoop-querier', dev, vlanRef(vlan)) !== 'on') continue;
      if (this.snoopMode(dev, vlan) !== 'enabled') {
        this.e.after(0, () => this.note(`snoopq|${dev}|${vlan}`, 'note', dev, `${dev} is no snooping querier candidate in VLAN ${vlan}: its IGMP / MLD snooping is not enabled there`));
        continue;
      }
      const svi = Array.from(sd.l3.values()).find((l) => l.kind === 'svi' && l.vlan === vlan && l.addrs.some((a) => a.addr.version === 4));
      if (!svi) {
        this.e.after(0, () => this.note(`snoopq|${dev}|${vlan}`, 'note', dev, `${dev} is no snooping querier candidate in VLAN ${vlan}: it has no IPv4 address there (a VLAN interface) to query from`));
        continue;
      }
      const addr = (svi.addrs.find((a) => a.addr.version === 4) as { addr: IpAddr }).addr;
      const c: SQ = {
        dev, name: `${dev} (VLAN ${vlan})`, lan: `VLAN ${vlan}`, vlan, svi, at: null, addr,
        querier: false, otherAt: -1, otherAddr: '', startup: 0, startupOf: 0, nextAt: -1, takeoverAt: -1, running: false, gen: 0, otherTok: 0, queries: 0, lastQuery: -1, since: -1,
        enabled: () => this.e.params.str('snoop-querier', dev, vlanRef(vlan)) === 'on' && this.snoopMode(dev, vlan) === 'enabled',
        up: () => this.e.deviceOn(dev),
        send: () => this.snoopQuery(sd, c),
      };
      this.sqs.set(dev + '|' + vlan, c);
      this.P.whenAnyPortUp(dev, () => {
        if (!c.running) this.startElection(c);
      });
    }
  }

  /** A switch's snooping querier sends a General Query (or a group's query) into its VLAN, from its VLAN interface's address. */
  private snoopQuery(sd: SimDevice, c: SQ, group?: string): void {
    const all = A('224.0.0.1');
    const dst = group ? A(group) : all;
    const mrt = group ? this.e.params.num('igmp-lmqi', sd.id) : this.e.params.num('igmp-max-resp', sd.id);
    const vn = this.verName(4, this.ver(sd.id));
    const detail = group
      ? `${vn} Group-Specific Query from ${sd.id} (snooping querier, ${formatAddr(c.addr)}) to ${group} in VLAN ${c.vlan}: any members left? Answer within ${durationText(mrt)}`
      : `${vn} General Query from ${sd.id} (snooping querier, ${formatAddr(c.addr)}) in VLAN ${c.vlan}: which groups have members? Answer within ${durationText(mrt)}`;
    const msg: Msg = { protocol: 'igmp', type: 'Query', label: group ? `IGMP Query ${group}` : 'IGMP Query (general)', detail, data: { from: sd.id, maxResp: mrt, querier: formatAddr(c.addr), snooping: true, vlan: c.vlan, ...(group ? { group } : {}) } };
    const pkt = this.e.newPacket(c.addr, dst, '', msg, [], 1);
    pkt.l4 = { proto: 'igmp', num: 2, igmp: { type: group ? 'Membership Query (group-specific)' : 'Membership Query (general)', version: vn, maxResp: mrt / 1000, ...(group ? { group } : {}) } };
    pkt.len = 12;
    this.e.note('message', 'igmp', sd.id, '', 'Query', '', detail, this.e.now, msg);
    this.e.floodFrom(sd.id, c.vlan, { src: sd.bridgeId.split('.')[1] || '00:00:00:00:00:00', dst: multicastMac(dst), msg, ip: pkt });
  }

  /** A leave reached a switch that is its VLAN's querier: it asks with group-specific queries (robustness times, a last member query interval apart). */
  private snoopLeave(sd: SimDevice, c: SQ, group: string, who: string, t: number): void {
    const rob = this.e.params.num('igmp-robustness', sd.id);
    const lmqi = this.e.params.num('igmp-lmqi', sd.id);
    this.e.at(t, () => {
      this.e.note('table', 'igmp', sd.id, '', 'leave', '', `${sd.id} (VLAN ${c.vlan}): ${who} leaves ${group}; ${rob} group-specific queries ${durationText(lmqi)} apart, then its port goes unless a member there answers`);
      let left = rob;
      const gen = c.gen;
      const ask = (): void => {
        if (left <= 0 || c.gen !== gen || !c.querier || !c.running) return;
        left--;
        this.snoopQuery(sd, c, group);
        if (left > 0) this.e.after(lmqi, ask);
      };
      ask();
    });
  }

  // ------------------------------------------------------------ PIM: neighbours, the DR, joins

  /** The PIM sessions of a router on an interface that are up (its neighbours there). */
  private neighbours(dev: string, iface?: string): Sess[] {
    return Array.from(this.P.sessions.values())
      .filter((s) => s.protocol === 'pim' && s.dev === dev && s.up && (iface === undefined || s.local.l3.id === iface))
      .sort((a, b) => cmp(a.key, b.key));
  }

  /** Is the router the designated router of an interface (the highest DR priority, then address, among it and its PIM neighbours there)? */
  private isDr(dev: string, l3: L3Iface, v: 4 | 6): { dr: boolean; who: string } {
    const own = l3.addrs.find((a) => a.addr.version === v);
    if (!own) return { dr: false, who: '' };
    let best = { dev, prio: this.e.params.num('pim-dr-priority', dev, null, ifaceRef(dev, l3.id)), addr: own.addr };
    for (const s of this.neighbours(dev, l3.id)) {
      if (s.remote.addr.version !== v) continue;
      const c = { dev: s.peer, prio: this.e.params.num('pim-dr-priority', s.peer, null, ifaceRef(s.peer, s.remote.l3.id)), addr: s.remote.addr };
      if (c.prio > best.prio || (c.prio === best.prio && compareAddr(c.addr, best.addr) > 0)) best = c;
    }
    return { dr: best.dev === dev, who: best.dev };
  }

  private table(dev: string): Map<string, MRoute> {
    let t = this.mroutes.get(dev);
    if (!t) this.mroutes.set(dev, (t = new Map()));
    return t;
  }

  /** Where an entry's traffic comes from: the RPF interface and neighbour towards the source (or the RP). */
  private rpf(dev: string, target: IpAddr): { iif: string | null; nbr: Sess | null; gateway: IpAddr | null; why: string } {
    const sd = this.P.sd(dev);
    for (const l of sd.l3.values()) if (l.addrs.some((a) => compareAddr(a.addr, target) === 0)) return { iif: null, nbr: null, gateway: null, why: 'itself' };
    const d = lookup(this.P.m, dev, '', target, this.e.ctx(dev));
    if (d.kind !== 'forward' || !d.hops.length) return { iif: null, nbr: null, gateway: null, why: `no route to ${formatAddr(target)}` };
    const hop = d.hops[0];
    if (!hop.gateway) return { iif: hop.iface, nbr: null, gateway: null, why: 'directly connected' };
    const nbr = this.neighbours(dev, hop.iface).find((s) => compareAddr(s.remote.addr, hop.gateway as IpAddr) === 0) || null;
    return { iif: hop.iface, nbr, gateway: hop.gateway, why: nbr ? `RPF neighbour ${nbr.peer}` : `the RPF neighbour ${formatAddr(hop.gateway)} on ${hop.iface} is no PIM neighbour` };
  }

  /** Send a Join or a Prune for an entry to an upstream neighbour (on its PIM session). */
  private joinPrune(dev: string, nbr: Sess, s: string, g: string, prune: boolean, rpt = false): void {
    const what = s === '*' ? `(*, ${g})` : `(${s}, ${g})${rpt ? ', RPT' : ''}`;
    const group = A(nbr.local.addr.version === 4 ? '224.0.0.13' : 'ff02::d');
    this.P.multicast(nbr, group, 'Join/Prune', `${prune ? 'prune' : 'join'} ${what}; upstream neighbour ${nbr.peer}`, { target: nbr.peer, s, g, prune, rpt });
  }

  /** The upstream join of an entry: towards the RP ((*, G)) or the source ((S, G)); refreshed every period while it is wanted. */
  private joinUp(dev: string, e: MRoute, why: string): void {
    const target = e.s === '*' ? (this.rp(dev, e.g) || { addr: null }).addr : A(e.s);
    if (!target) {
      this.note(`norp|${dev}|${e.g}`, 'wait', dev, `PIM Join (*, ${e.g}) at ${dev} waiting for an RP (no static RP, no rp on a PIM relation, no candidate RP)`);
      return;
    }
    const r = this.rpf(dev, target);
    const was = e.nbr;
    e.iif = r.iif;
    e.nbr = r.nbr ? r.nbr.peer : null;
    if (r.iif === null && r.why !== 'itself') {
      // the RPF route is missing: the join waits for it (the unicast routing may still be converging; tried again when routes change)
      this.note(`norpf|${dev}|${e.s}|${e.g}`, 'wait', dev, `PIM Join ${this.entryName(e)} at ${dev} waiting for an RPF route to ${formatAddr(target)}: ${r.why}`);
      return;
    }
    if (!r.nbr) {
      if (r.gateway) this.note(`nonbr|${dev}|${e.s}|${e.g}`, 'wait', dev, `PIM Join ${this.entryName(e)} at ${dev} waiting for a PIM neighbour on its RPF interface towards ${formatAddr(target)}: ${r.why}`);
      return;
    }
    if (was !== r.nbr.peer) this.e.note('route', 'pim', dev, r.nbr.peer, 'join', '', `${dev} joins ${this.entryName(e)} towards ${e.s === '*' ? 'the RP ' + formatAddr(target) : 'the source'}: RPF interface ${r.iif}, neighbour ${r.nbr.peer} (${why})`);
    this.joinPrune(dev, r.nbr, e.s, e.g, false);
  }

  private entryName(e: { s: string; g: string }): string {
    return e.s === '*' ? `(*, ${e.g})` : `(${e.s}, ${e.g})`;
  }

  /** An entry, created (with its upstream join) when it is missing. */
  private entry(dev: string, s: string, g: string, why: string, join = true): MRoute {
    const t = this.table(dev);
    const k = s + '|' + g;
    let e = t.get(k);
    if (e) return e;
    e = { s, g, iif: null, nbr: null, oil: new Map(), pruned: new Map(), rptPruned: new Set(), spt: false, registering: false, local: false, created: this.e.now, lastData: -1, logged: '', mode: this.mode(dev, A(g)) };
    t.set(k, e);
    const entry = e;
    if (join && e.mode !== 'dense') {
      this.joinUp(dev, e, why);
      // refreshed every Join/Prune period; tried again every 5 s while there is no upstream PIM neighbour yet
      this.P.periodic(
        () => t.get(k) === entry,
        () => (entry.nbr ? 60000 : 5000),
        () => {
          if (this.wanted(dev, entry)) this.joinUp(dev, entry, entry.nbr ? 'periodic refresh' : 'tried again');
        },
        entry.nbr ? 60000 : 5000,
      );
    }
    return e;
  }

  /** Is an entry wanted downstream (an outgoing interface, or members of its own)? */
  private wanted(dev: string, e: MRoute): boolean {
    for (const until of e.oil.values()) if (until > this.e.now) return true;
    return false;
  }

  /** The members on a router's interface changed: its own outgoing interface of the group, and the joins. */
  private membersChanged(dev: string, l3: L3Iface, group: string): void {
    if (!this.mcRouter(dev)) return;
    const g = A(group);
    const ri = this.rifsAt(dev, l3, g.version);
    const rg = ri ? ri.groups.get(group) : undefined;
    const dr = this.isDr(dev, l3, g.version);
    if (rg && !dr.dr) {
      this.note(`notdr|${dev}|${l3.id}|${group}`, 'note', dev, `${dev}:${l3.id} has members of ${group} but ${dr.who} is the designated router there: ${dr.who} joins for them`);
      return;
    }
    const mode = this.mode(dev, g);
    const keys = mode === 'ssm' || (rg && rg.sources.length) ? (rg ? rg.sources : []).map((s) => s + '|' + group) : ['*|' + group];
    if (mode === 'dense') {
      // dense mode: un-prune (graft) the entries of the group
      for (const e of this.table(dev).values()) {
        if (e.g !== group) continue;
        if (rg) {
          const was = this.wanted(dev, e);
          e.oil.set(l3.id, Infinity);
          if (!was) this.graft(dev, e);
        } else e.oil.delete(l3.id);
      }
      return;
    }
    if (rg) {
      for (const k of keys) {
        const [s] = k.split('|');
        const e = this.entry(dev, s, group, `members on ${l3.id}`);
        if (e.oil.get(l3.id) !== Infinity) {
          e.oil.set(l3.id, Infinity);
          this.e.note('table', 'pim', dev, '', 'oif added', '', `${dev}: ${this.entryName(e)} goes out of ${l3.id} too (members there)`);
        }
      }
      return;
    }
    // no member left: the interface goes; an entry nobody wants is pruned upstream
    for (const e of Array.from(this.table(dev).values())) {
      if (e.g !== group || e.oil.get(l3.id) !== Infinity) continue;
      e.oil.delete(l3.id);
      this.e.note('table', 'pim', dev, '', 'oif removed', '', `${dev}: ${this.entryName(e)} no longer goes out of ${l3.id} (no members there)`);
      this.maybePrune(dev, e);
    }
  }

  private graft(dev: string, e: MRoute): void {
    const nbr = e.nbr ? this.neighbours(dev).find((s) => s.peer === e.nbr) : undefined;
    if (!nbr) return;
    const group = A(nbr.local.addr.version === 4 ? '224.0.0.13' : 'ff02::d');
    this.P.multicast(nbr, group, 'Graft', `graft (${e.s}, ${e.g}): a member joined downstream; upstream neighbour ${nbr.peer}`, { target: nbr.peer, s: e.s, g: e.g, graft: true });
  }

  /** An entry with no outgoing interface left is pruned upstream and removed. */
  private maybePrune(dev: string, e: MRoute): void {
    if (this.wanted(dev, e) || e.local) return;
    const t = this.table(dev);
    if (e.mode === 'dense') return;
    t.delete(e.s + '|' + e.g);
    const nbr = e.nbr ? this.neighbours(dev).find((s) => s.peer === e.nbr) : undefined;
    this.e.note('table', 'pim', dev, e.nbr || '', 'pruned', '', `${dev}: ${this.entryName(e)} has no outgoing interface left${nbr ? ': prune to ' + nbr.peer : ''}`);
    if (nbr) this.joinPrune(dev, nbr, e.s, e.g, true);
  }

  /** A PIM message of a session for this router: Join/Prune, Graft (Hellos and Bootstraps stay with the session). */
  pimMessage(s: Sess, msg: Msg, l3: L3Iface | null): boolean {
    const d = (msg.data || {}) as { target?: string; s?: string; g?: string; prune?: boolean; rpt?: boolean; graft?: boolean };
    if (msg.type !== 'Join/Prune' && msg.type !== 'Graft') return false;
    if (d.target !== s.dev || !d.g || !d.s || !l3) return true;
    const dev = s.dev;
    if (!this.mcRouter(dev)) return true;
    if (msg.type === 'Graft') {
      const e = this.table(dev).get(d.s + '|' + d.g);
      if (e && e.pruned.delete(l3.id)) this.e.note('table', 'pim', dev, s.peer, 'grafted', '', `${dev}: (${d.s}, ${d.g}) goes out of ${l3.id} again (Graft from ${s.peer})`);
      if (e && e.nbr) this.graft(dev, e);
      return true;
    }
    if (d.prune) {
      const t = this.table(dev);
      if (d.rpt) {
        // (S, G, rpt): the source off the shared tree towards that neighbour
        const e = t.get('*|' + d.g);
        if (e && !e.rptPruned.has(d.s + '|' + l3.id)) {
          e.rptPruned.add(d.s + '|' + l3.id);
          this.e.note('table', 'pim', dev, s.peer, 'RPT prune', '', `${dev}: ${d.s}'s traffic for ${d.g} no longer goes down the shared tree out of ${l3.id} (${s.peer} is on the source's tree)`);
        }
        return true;
      }
      const e = t.get(d.s + '|' + d.g);
      if (!e) return true;
      if (e.mode === 'dense') {
        e.pruned.set(l3.id, this.e.now + JOIN_HOLD);
        this.e.note('table', 'pim', dev, s.peer, 'pruned', '', `${dev}: (${d.s}, ${d.g}) is pruned off ${l3.id} for ${durationText(JOIN_HOLD)} (Prune from ${s.peer})`);
        return true;
      }
      if (e.oil.delete(l3.id)) {
        this.e.note('table', 'pim', dev, s.peer, 'oif removed', '', `${dev}: ${this.entryName(e)} no longer goes out of ${l3.id} (Prune from ${s.peer})`);
        this.maybePrune(dev, e);
      }
      return true;
    }
    const e = this.entry(dev, d.s, d.g, `Join from ${s.peer}`);
    if (!e.oil.has(l3.id) || e.oil.get(l3.id) !== Infinity) {
      const isNew = !e.oil.has(l3.id);
      e.oil.set(l3.id, this.e.now + JOIN_HOLD);
      if (isNew) this.e.note('table', 'pim', dev, s.peer, 'oif added', '', `${dev}: ${this.entryName(e)} goes out of ${l3.id} (Join from ${s.peer}, held ${durationText(JOIN_HOLD)})`);
    }
    if (d.s !== '*') e.rptPruned.forEach((x) => x.indexOf(d.s + '|') === 0 && e.rptPruned.delete(x));
    return true;
  }

  // ------------------------------------------------------------ PIM: data, registers, the trees

  /** The interfaces of a router where the source of a packet is directly connected. */
  private connectedTo(dev: string, l3: L3Iface, src: IpAddr): boolean {
    return l3.addrs.some((a) => a.addr.version === src.version && inNet(a, src));
  }

  /**
   * A multicast packet at a router (routed groups only): the RPF check, the
   * first-hop router's register, the switch to the source's tree, and the
   * copies out of the outgoing interfaces. True: handled here.
   */
  /** A router drops a multicast packet: its log line and its decision for the packet inspector. */
  private dropL3(key: string, dev: string, l3: L3Iface, pkt: Pkt, text: string): void {
    this.note(key, 'drop', dev, text);
    this.l3Decide(dev, l3, pkt, text, []);
  }

  /** A router's multicast routing decision for the packet being delivered now (Layer 3: by its multicast routes, not by snooping). */
  private l3Decide(dev: string, l3: L3Iface, pkt: Pkt, text: string, oifs: string[]): void {
    const f = this.e.currentFlight();
    if (f < 0) return;
    const ports: McPort[] = [{ port: l3.id, sent: false, why: 'incoming interface (never sent back)' }];
    for (const o of oifs) ports.push({ port: o, sent: true, why: 'outgoing interface of its multicast route' });
    this.e.recordMc(f, { dev, t: this.e.now, layer: 'l3', vlan: 0, group: formatAddr(pkt.dst), ingress: l3.id, mode: this.mcRouter(dev) ? 'Layer 3 multicast routing (PIM)' : 'Layer 3: it routes no multicast', ports, text });
  }

  mroute(dev: string, l3: L3Iface, pkt: Pkt): boolean {
    if (!isMulticastIp(pkt.dst) || isLinkLocalGroup(pkt.dst)) return false;
    if (pkt.msg.protocol === 'igmp' || pkt.msg.protocol === 'pim') return false;
    const sd = this.P.sd(dev);
    const g = formatAddr(pkt.dst);
    const s = formatAddr(pkt.src);
    if (!this.mcRouter(dev)) {
      // a group its own interface joined as a host (a PTP port): it takes it, and routes it nowhere (no note: nothing is lost)
      if (this.isMember(dev, l3.id, g)) return true;
      if (sd.caps.firewallPolicy && this.e.params.str('mc-passthrough', dev, ifaceRef(dev, l3.id)) !== 'on') this.dropL3(`fwmc|${dev}|${g}`, dev, l3, pkt, `${dev} drops multicast for ${g} from ${s}: multicast passthrough ${resolvedText(this.e.params.get('mc-passthrough', dev, null, ifaceRef(dev, l3.id)))}`);
      else this.dropL3(`nopim|${dev}|${g}`, dev, l3, pkt, `${dev} routes no multicast (it runs no PIM): ${pkt.msg.label} stays on ${l3.id}`);
      return true;
    }
    if (sd.caps.firewallPolicy && this.e.params.str('mc-passthrough', dev, ifaceRef(dev, l3.id)) !== 'on') {
      this.dropL3(`fwmc|${dev}|${g}`, dev, l3, pkt, `${dev} drops multicast for ${g} from ${s}: multicast passthrough ${resolvedText(this.e.params.get('mc-passthrough', dev, null, ifaceRef(dev, l3.id)))}`);
      return true;
    }
    if (pkt.ttl <= 1) {
      this.dropL3(`ttl1|${dev}|${s}|${g}`, dev, l3, pkt, `${dev} does not route ${pkt.msg.label} from ${s}: its TTL is 1`);
      return true;
    }
    const t = this.table(dev);
    const mode = this.mode(dev, pkt.dst);
    const first = this.connectedTo(dev, l3, pkt.src) && this.isDr(dev, l3, pkt.src.version).dr;
    let sg = t.get(s + '|' + g);
    const star = mode === 'sparse' ? t.get('*|' + g) : undefined;
    if (first) {
      if (!sg || !sg.local) {
        if (!sg) sg = this.entry(dev, s, g, 'a source on ' + l3.id, false);
        sg.iif = l3.id;
        sg.local = true;
        sg.registering = mode === 'sparse';
        this.e.note('table', 'pim', dev, '', 'source', '', `${dev}: ${s} sends to ${g} on ${l3.id}; ${mode === 'sparse' ? (this.isRp(dev, g) ? 'this router is the RP' : 'it registers the source with the RP') : mode === 'dense' ? 'dense mode: flooded to every PIM neighbour, then pruned' : 'SSM: only to (S, G) joins'}`);
        if (mode === 'dense') this.denseOil(dev, sg);
      }
      const rp = this.rp(dev, g);
      if (mode === 'sparse' && sg.registering) {
        if (rp && rp.dev === dev) sg.registering = false;
        else if (rp) this.register(dev, l3, pkt, rp);
      }
    } else if (mode === 'dense' && !sg) {
      const r = this.rpf(dev, pkt.src);
      if (r.iif === null) {
        this.dropL3(`dnoroute|${dev}|${s}|${g}`, dev, l3, pkt, `${dev} drops (${s}, ${g}): ${r.why} yet, so no RPF interface towards the source`);
        return true;
      }
      sg = this.entry(dev, s, g, 'dense mode data', false);
      sg.iif = r.iif;
      sg.nbr = r.nbr ? r.nbr.peer : null;
      this.denseOil(dev, sg);
    }
    // the RPF check: on the source's tree it arrives on the (S, G) entry's incoming interface, on the shared tree on the one towards the RP
    const rp = this.rp(dev, g);
    const isRp = !!rp && rp.dev === dev;
    const starIif = star ? (isRp ? null : rp ? this.rpf(dev, rp.addr).iif : null) : null;
    let via: 'sg' | 'star' | null = null;
    if (sg && sg.iif === l3.id) via = 'sg';
    else if (star && (starIif === l3.id)) via = 'star';
    if (!via) {
      const expect = sg && sg.iif ? sg.iif : starIif;
      // dense mode: a copy on another interface than the one towards the source: that neighbour is told to prune it
      if (mode === 'dense' && sg && sg.iif) {
        const nb = this.neighbours(dev, l3.id).find((x) => compareAddr(x.remote.addr, pkt.src) !== 0);
        const k = `dnrpf|${dev}|${s}|${g}|${l3.id}`;
        if (nb && (!this.noted.has(k) || this.e.now - (this.noted.get(k) as number) >= JOIN_HOLD)) {
          this.noted.set(k, this.e.now);
          this.joinPrune(dev, nb, s, g, true);
        }
      }
      if (!sg && !star) this.dropL3(`nostate|${dev}|${s}|${g}`, dev, l3, pkt, `${dev} has no state for (${s}, ${g}): nobody downstream joined it${mode === 'sparse' ? ' (and it is no first-hop router of the source)' : ''}; dropped`);
      else this.dropL3(`rpf|${dev}|${s}|${g}|${l3.id}`, dev, l3, pkt, `${dev}: RPF check failed for (${s}, ${g}): it arrived on ${l3.id}, the RPF interface ${sg && sg.iif ? 'towards the source' : 'towards the RP'} is ${expect || 'none'}; dropped`);
      return true;
    }
    // the RP receives it natively: the first-hop router may stop registering
    if (via === 'sg' && isRp && sg && !sg.local) this.registerStop(dev, s, g);
    // a last-hop router on the shared tree: to the source's tree at the first packet
    if (via === 'star' && mode === 'sparse' && !isRp && star && this.lastHop(dev, star) && !(sg && sg.spt) && this.e.params.str('spt-switchover', dev) === 'immediately') {
      sg = this.entry(dev, s, g, 'SPT switchover (immediately)');
      sg.spt = true;
      for (const [k, v] of star.oil) if (v === Infinity) sg.oil.set(k, Infinity);
      this.e.note('route', 'pim', dev, '', 'SPT switchover', '', `${dev} switches to the source's tree for (${s}, ${g}) at the first packet (SPT switchover ${resolvedText(this.e.params.get('spt-switchover', dev))}): join towards ${s}`);
    }
    // on the source's tree now: the source off the shared tree (once)
    if (via === 'sg' && sg && sg.spt && star && rp && starIif !== sg.iif) {
      const up = this.rpf(dev, rp.addr);
      const k = `rpt|${dev}|${s}|${g}`;
      if (up.nbr && !this.noted.has(k)) {
        this.noted.set(k, this.e.now);
        this.joinPrune(dev, up.nbr, s, g, true, true);
      }
    }
    if (via === 'sg' && sg) sg.lastData = this.e.now;
    if (via === 'star' && star) star.lastData = this.e.now;
    // the copies: not back where it came from; the shared tree without the interfaces the source is pruned off (and, once on the source's tree, without what that tree serves)
    const out = new Set<string>();
    const add = (e: MRoute | undefined, shared: boolean): void => {
      if (!e) return;
      for (const [oif, until] of e.oil) {
        if (until <= this.e.now || oif === l3.id) continue;
        if (e.pruned.has(oif) && (e.pruned.get(oif) as number) > this.e.now) continue;
        if (shared && e.rptPruned.has(s + '|' + oif)) continue;
        if (shared && via === 'star' && sg && sg.spt && sg.lastData >= 0 && sg.oil.has(oif) && sg.iif !== starIif) continue;
        out.add(oif);
      }
    };
    if (via === 'sg') add(sg, false);
    if (via === 'sg' && (isRp || (sg && sg.local))) add(star, true);
    if (via === 'star') add(star, true);
    const list = Array.from(out).sort(cmp);
    const sig = via + ':' + list.join(',');
    this.l3Decide(dev, l3, pkt, list.length ? `${dev} routes (${s}, ${g}) from ${l3.id} out of ${list.join(', ')} (${via === 'sg' ? 'the source’s tree' : 'the shared tree'})` : `${dev} routes (${s}, ${g}) nowhere: no outgoing interface`, list);
    const logE = (via === 'sg' ? sg : star) as MRoute;
    if (logE.logged !== sig) {
      logE.logged = sig;
      this.e.note('route', 'pim', dev, '', 'forwards', '', list.length ? `${dev} forwards (${s}, ${g}) from ${l3.id} out of ${list.join(', ')} (${via === 'sg' ? 'the source’s tree' : 'the shared tree'}, TTL ${pkt.ttl} → ${pkt.ttl - 1})` : `${dev} forwards (${s}, ${g}) nowhere: no outgoing interface`);
    }
    const sd2 = this.P.sd(dev);
    for (const oif of list) {
      const o = sd2.l3.get(oif);
      if (!o || !this.e.isL3Up(dev, oif)) continue;
      if (o.kind === 'tunnel' && !this.tunnelCarries(dev, o, g)) continue;
      this.e.send(dev, { ...pkt, ttl: pkt.ttl - 1 }, o);
    }
    // dense mode: a router with nothing to forward to prunes itself off upstream
    if (mode === 'dense' && sg && !sg.local && !list.length) {
      const nbr = sg.nbr ? this.neighbours(dev).find((x) => x.peer === sg!.nbr) : undefined;
      const k = `dprune|${dev}|${s}|${g}`;
      if (nbr && (!this.noted.has(k) || this.e.now - (this.noted.get(k) as number) >= JOIN_HOLD)) {
        this.noted.set(k, this.e.now);
        this.joinPrune(dev, nbr, s, g, true);
      }
    }
    return true;
  }

  /** Is a router the RP of a group in its own view? */
  private isRp(dev: string, group: string): boolean {
    const rp = this.rp(dev, group);
    return !!rp && rp.dev === dev;
  }

  /** A last-hop router: members of its own on an outgoing interface of the entry. */
  private lastHop(dev: string, e: MRoute): boolean {
    for (const v of e.oil.values()) if (v === Infinity) return true;
    return false;
  }

  /** Dense mode: every interface with a PIM neighbour or members, but the incoming one. */
  private denseOil(dev: string, e: MRoute): void {
    const sd = this.P.sd(dev);
    const v = A(e.g).version;
    for (const l of sd.l3.values()) {
      if (l.id === e.iif) {
        e.oil.delete(l.id);
        continue;
      }
      const ri = this.rifsAt(dev, l, v);
      if (ri && ri.groups.has(e.g)) e.oil.set(l.id, Infinity);
      else if (this.neighbours(dev, l.id).length) e.oil.set(l.id, FLOOD);
    }
  }

  /** May a tunnel carry multicast: GRE in its encapsulation, and its router's setting on? */
  private tunnelCarries(dev: string, tun: L3Iface, g: string): boolean {
    const rel = tunnelRelation(this.P.m, dev, tun.id);
    const r = this.e.params.get('mc-tunnel', dev, null, rel ? relRef(rel.id) : null);
    if (r.value !== 'on') {
      this.note(`mctun|${dev}|${tun.id}`, 'drop', dev, `${dev} sends no multicast (${g}) into ${tun.id}: multicast over tunnels ${resolvedText(r)}`);
      return false;
    }
    return true;
  }

  /** The first-hop router encapsulates the packet in a Register to the RP (unicast). */
  private register(dev: string, l3: L3Iface, pkt: Pkt, rp: { dev: string; addr: IpAddr }): void {
    const src = this.P.sd(dev).l3.get(l3.id);
    const a = src ? src.addrs.find((x) => x.addr.version === rp.addr.version) : undefined;
    if (!a) return;
    const msg: Msg = { protocol: 'pim', type: 'Register', label: `PIM Register (${formatAddr(pkt.src)}, ${formatAddr(pkt.dst)})`, detail: `PIM Register from ${dev} to the RP ${formatAddr(rp.addr)} (${rp.dev}): ${pkt.msg.label} from ${formatAddr(pkt.src)}, encapsulated (unicast)`, data: { from: dev, s: formatAddr(pkt.src), g: formatAddr(pkt.dst), inner: pkt } };
    const out = this.e.newPacket(a.addr, rp.addr, '', msg);
    out.l4 = { proto: 'other', num: 103 };
    out.len = 8 + (pkt.len || 100) + 20;
    this.e.note('message', 'pim', dev, rp.dev, 'Register', '', msg.detail, this.e.now, msg);
    // the Register waits for a route to the RP (the unicast routing may still be converging)
    const d = lookup(this.P.m, dev, '', rp.addr, this.e.ctx(dev));
    if (d.kind !== 'forward' && d.kind !== 'local') {
      this.e.waitFor(`route:${dev}||${formatAddr(rp.addr)}`, `a route to the RP ${formatAddr(rp.addr)}`, dev, msg, () => this.e.send(dev, out), `${dev}|pim|Register|${formatAddr(pkt.src)}|${formatAddr(pkt.dst)}`);
      return;
    }
    this.e.send(dev, out);
  }

  /** the first-hop routers that registered a source with an RP: by "rp|s|g", their device and the address they sent from */
  private registrants = new Map<string, Map<string, IpAddr>>();

  /** The RP tells the first-hop routers that registered (S, G) to stop: they sent their Registers from these addresses. */
  private registerStop(rpDev: string, s: string, g: string): void {
    const regs = this.registrants.get(`${rpDev}|${s}|${g}`);
    if (!regs) return;
    for (const [dev, to] of Array.from(regs).sort((a, b) => cmp(a[0], b[0]))) {
      const k = `rstop|${rpDev}|${dev}|${s}|${g}`;
      if (this.noted.has(k)) continue;
      this.noted.set(k, this.e.now);
      const rp = this.rp(rpDev, g);
      const from = rp && rp.dev === rpDev ? rp.addr : null;
      if (!from) continue;
      const msg: Msg = { protocol: 'pim', type: 'Register-Stop', label: `PIM Register-Stop (${s}, ${g})`, detail: `PIM Register-Stop from the RP ${rpDev} to ${dev}: (${s}, ${g}) arrives natively now`, data: { from: rpDev, s, g } };
      const out = this.e.newPacket(from, to, '', msg);
      out.l4 = { proto: 'other', num: 103 };
      out.len = 18;
      this.e.note('message', 'pim', rpDev, dev, 'Register-Stop', '', msg.detail, this.e.now, msg);
      this.e.send(rpDev, out);
    }
  }

  /** PIM messages that belong to no session: a Register at the RP, a Register-Stop at the first-hop router. */
  private pimUnrelated(dev: string, l3: L3Iface | null, msg: Msg, pkt: Pkt | null): void {
    const d = (msg.data || {}) as { s?: string; g?: string; inner?: Pkt };
    if (!d.s || !d.g) return;
    if (msg.type === 'Register-Stop') {
      const e = this.table(dev).get(d.s + '|' + d.g);
      if (e && e.registering) {
        e.registering = false;
        this.e.note('table', 'pim', dev, '', 'registered', '', `${dev} stops registering (${d.s}, ${d.g}): the RP receives it natively`);
      }
      return;
    }
    if (msg.type !== 'Register' || !d.inner) return;
    // a Register to a router that is no RP of the group in its own view: dropped (the first-hop router's RP is another one)
    if (!this.isRp(dev, d.g)) {
      this.note(`notrp|${dev}|${d.g}`, 'drop', dev, `${dev} gets a PIM Register for (${d.s}, ${d.g}) from ${(msg.data as { from?: string }).from || '?'}, but is not the RP of ${d.g} itself: dropped`);
      return;
    }
    const from = (msg.data as { from?: string }).from;
    if (from && pkt) {
      const k = `${dev}|${d.s}|${d.g}`;
      if (!this.registrants.has(k)) this.registrants.set(k, new Map());
      (this.registrants.get(k) as Map<string, IpAddr>).set(from, pkt.src);
    }
    const star = this.table(dev).get('*|' + d.g);
    const sg = this.entry(dev, d.s, d.g, 'Register from the first-hop router');
    if (!star || !this.wanted(dev, star)) {
      // no receivers: stop the registers at once
      this.registerStop(dev, d.s, d.g);
      return;
    }
    void l3;
    // decapsulated, down the shared tree
    const sd = this.P.sd(dev);
    for (const [oif, until] of Array.from(star.oil).sort((a, b) => cmp(a[0], b[0]))) {
      if (until <= this.e.now) continue;
      const o = sd.l3.get(oif);
      if (!o || !this.e.isL3Up(dev, oif)) continue;
      this.e.send(dev, { ...d.inner, ttl: Math.max(1, d.inner.ttl - 1) }, o);
    }
    void sg;
  }

  /** The unicast routes of a router changed: every entry's RPF interface is checked again (the tree moves). */
  private routesChanged(dev: string): void {
    const t = this.mroutes.get(dev);
    if (!t || !this.mcRouter(dev)) return;
    for (const e of Array.from(t.values()).sort((a, b) => cmp(a.s + a.g, b.s + b.g))) {
      if (e.local) continue;
      const target = e.s === '*' ? (this.rp(dev, e.g) || { addr: null }).addr : A(e.s);
      if (!target) continue;
      const r = this.rpf(dev, target);
      const nbr = r.nbr ? r.nbr.peer : null;
      if (r.iif === e.iif && nbr === e.nbr) continue;
      const old = e.nbr ? this.neighbours(dev).find((x) => x.peer === e.nbr) : undefined;
      this.e.note('route', 'pim', dev, nbr || '', 'RPF change', '', `${dev}: the RPF interface of ${this.entryName(e)} changes from ${e.iif || 'none'}${e.nbr ? ' (' + e.nbr + ')' : ''} to ${r.iif || 'none'}${nbr ? ' (' + nbr + ')' : ''}: ${nbr ? 'join there' : r.why}${old ? ', prune to ' + old.peer : ''}`);
      if (old) this.joinPrune(dev, old, e.s, e.g, true);
      e.iif = r.iif;
      e.nbr = nbr;
      e.logged = '';
      if (e.mode === 'dense') this.denseOil(dev, e);
      if (r.nbr && e.mode !== 'dense') this.joinPrune(dev, r.nbr, e.s, e.g, false);
    }
  }

  // ------------------------------------------------------------ streams and receivers

  /** A stream from a host's interface: a UDP datagram to the group every interval. */
  /** Why a host can't stream to a group from an interface now, or null (the checks of `addStream`). */
  streamProblem(dev: string, iface: string, group: string): string | null {
    const g = parseAddress(group.trim());
    if (!g || !isMulticastIp(g) || isLinkLocalGroup(g)) return `${group} is not a routable multicast group`;
    if (!this.hostAddr(dev, iface, g.version)) return `${dev}:${iface} has no IPv${g.version} address`;
    if (this.streams.some((x) => x.dev === dev && x.iface === iface && x.group === formatAddr(g) && x.running)) return `${dev}:${iface} already streams to ${formatAddr(g)}`;
    return null;
  }

  addStream(dev: string, iface: string, group: string, port: number, interval: number, size: number, origin: Stream['origin'], first = 0, label = '', tag?: number): Stream | string {
    const bad = origin === 'event' || origin === 'experiment' ? this.streamProblem(dev, iface, group) : null;
    if (bad) return bad;
    const g = parseAddress(group.trim());
    if (!g || !isMulticastIp(g) || isLinkLocalGroup(g)) return `${group} is not a routable multicast group`;
    if (!this.hostAddr(dev, iface, g.version)) return `${dev}:${iface} has no IPv${g.version} address`;
    const st: Stream = { id: ++this.seq, dev, iface, group: formatAddr(g), port, interval, size, origin, label, running: true, since: this.e.now, sent: 0, gen: 0, sport: 49152 + ((this.seq * 7919) % 16000), rx: new Map(), tag };
    this.streams.push(st);
    if (origin === 'event') this.events.push({ kind: 'stream', ref: `iface:${dev}:${iface}`, group: st.group, since: this.e.now, state: `streaming to ${st.group}:${port}` });
    this.runStream(st, first);
    return st;
  }

  /**
   * Every stream on the simulated clock (the scenario's time): one datagram
   * every interval of simulated time, the first at `first` (a stream of
   * Network events: at once). What exists never depends on the frame rate,
   * the pacing or a stalled page — only how fast it is shown does.
   */
  private runStream(st: Stream, first: number): void {
    const gen = ++st.gen;
    this.P.periodic(
      () => st.gen === gen && st.running,
      () => st.interval,
      () => this.sendStream(st),
      first,
    );
  }

  private sendStream(st: Stream): void {
    if (!this.e.deviceOn(st.dev)) {
      if (st.origin === 'event') st.offMissed = (st.offMissed || 0) + 1;
      return;
    }
    const g = A(st.group);
    const h = this.hostAddr(st.dev, st.iface, g.version);
    if (!h) return;
    st.sent++;
    if (st.lastAt !== undefined) st.gap = this.e.now - st.lastAt;
    st.lastAt = this.e.now;
    const demand = st.origin === 'demand';
    const msg: Msg = { protocol: demand ? 'demand' : 'mcast', type: 'Stream', label: `UDP → ${st.group}:${st.port}`, detail: `multicast ${demand ? 'demand ' + st.label + ', representative ' : ''}datagram ${st.sent} from ${st.dev} (${formatAddr(h.addr)}) to ${st.group}:${st.port}, ${st.size} bytes`, data: { from: st.dev, stream: st.id, n: st.sent, source: formatAddr(h.addr) } };
    const pkt = this.e.newPacket(h.addr, g, h.l3.vrf, msg, [], 0);
    pkt.l4 = { proto: 'udp', num: 17, sport: st.sport, dport: st.port };
    pkt.len = 8 + st.size;
    // (a stream of Network events: its datagrams carry its id, drawn whatever is ticked, with every copy and what stops them)
    this.e.withTest(st.tag, () => {
      if (st.sent === 1 || st.sent % 10 === 0) this.e.note('message', msg.protocol, st.dev, '', 'Stream', '', msg.detail, this.e.now, msg);
      this.e.send(st.dev, pkt, h.l3);
    });
  }

  /** Stop a stream (the end of a stream event, or Stop stream on one of the model). */
  /** What a host received of a group (its datagrams counted at its interfaces): the count, the first and the last (scenario time), or null. */
  received(dev: string, group: string): { count: number; first: number; last: number } | null {
    const g = parseAddress(group.trim());
    const r = g ? this.rx.get(dev + '|' + formatAddr(g)) : undefined;
    return r ? { count: r.count, first: r.first, last: r.last } : null;
  }

  stopStream(dev: string, iface: string, group: string): boolean {
    const st = this.streams.find((x) => x.dev === dev && x.iface === iface && x.group === group && x.running);
    if (!st) return false;
    st.running = false;
    st.stoppedAt = this.e.now;
    st.gen++;
    // its future sends are cancelled
    const i = this.events.findIndex((x) => x.kind === 'stream' && x.ref === `iface:${dev}:${iface}` && x.group === st.group);
    if (i >= 0) this.events.splice(i, 1);
    else this.events.push({ kind: 'stopped', ref: `iface:${dev}:${iface}`, group: st.group, since: this.e.now, state: `stream to ${st.group} stopped` });
    this.e.note('state', st.origin === 'demand' ? 'demand' : 'mcast', dev, '', 'Stream stopped', '', `${dev}:${iface} stops its stream to ${st.group}:${st.port} after ${st.sent} datagrams`);
    this.e.stateVersion++;
    return true;
  }

  /** Start a stopped stream of the model again. */
  restartStream(dev: string, iface: string, group: string): boolean {
    const st = this.streams.find((x) => x.dev === dev && x.iface === iface && x.group === group && !x.running);
    if (!st) return false;
    st.running = true;
    st.stoppedAt = undefined;
    const i = this.events.findIndex((x) => x.kind === 'stopped' && x.ref === `iface:${dev}:${iface}` && x.group === st.group);
    if (i >= 0) this.events.splice(i, 1);
    this.e.note('state', 'mcast', dev, '', 'Stream started', '', `${dev}:${iface} streams to ${st.group}:${st.port} again`);
    this.runStream(st, 0);
    this.e.stateVersion++;
    return true;
  }

  /** Multicast data at a host: a member takes it (counted, the first and after a gap logged); others filter it out. */
  dataIn(dev: string, l3: L3Iface, pkt: Pkt): boolean {
    if (!isMulticastIp(pkt.dst)) return false;
    if (!this.member(dev, l3.id, pkt.dst, pkt.src)) return false;
    const g = formatAddr(pkt.dst);
    const k = dev + '|' + g;
    let r = this.rx.get(k);
    if (!r) {
      r = { dev, group: g, count: 0, first: this.e.now, last: -1, sources: new Set(), gapNoted: false };
      this.rx.set(k, r);
    }
    const src = formatAddr(pkt.src);
    // (a stream's datagram: counted for that stream too)
    const sid = (pkt.msg.data as { stream?: number } | undefined || {}).stream;
    const st = sid ? this.streams.find((x) => x.id === sid) : undefined;
    if (st) st.rx.set(dev, (st.rx.get(dev) || 0) + 1);
    if (r.count === 0 || !r.sources.has(src)) this.e.note('message', pkt.msg.protocol, dev, this.e.ownerOf(pkt.src) || '', 'receives', 'receiving', `${dev} receives ${g} from ${src} (${pkt.msg.label}, TTL ${pkt.ttl})`);
    else if (r.gapNoted) this.e.note('message', pkt.msg.protocol, dev, '', 'receives again', 'receiving', `${dev} receives ${g} again after ${durationText(this.e.now - r.last)} without it`);
    r.gapNoted = false;
    r.count++;
    r.last = this.e.now;
    r.sources.add(src);
    const test = (pkt.msg.data || {}) as { test?: number };
    if (test.test !== undefined && this.onTestReceived) this.onTestReceived(test.test, dev, pkt.src);
    return true;
  }

  // ------------------------------------------------------------ timers, failures, power

  /**
   * A membership a leave shortened goes exactly when its last member queries
   * are over (not at the next second's sweep): the sweep then too, at that
   * moment. The next packet after it finds the entry gone.
   */
  private expireAt(t: number): void {
    if (this.expiring.has(t)) return;
    this.expiring.add(t);
    this.e.at(t, () => {
      this.expiring.delete(t);
      this.sweep();
    });
  }

  /** the moments an exact expiry is scheduled for (one sweep each) */
  private expiring = new Set<number>();

  /** Once a second: memberships, snooping entries and joins past their time. */
  private sweep(): void {
    const now = this.e.now;
    for (const ri of Array.from(this.rifs.values()).sort((a, b) => cmp(a.dev + a.l3.id, b.dev + b.l3.id))) {
      for (const [k, g] of Array.from(ri.groups)) {
        if (g.expires > now) continue;
        ri.groups.delete(k);
        this.e.note('table', 'igmp', ri.dev, '', 'membership expired', '', `${ri.dev}:${ri.l3.id}: ${k} has no member any more (${g.leaving ? 'nobody answered the group-specific queries' : 'no report within the membership interval'})`);
        this.membersChanged(ri.dev, ri.l3, k);
      }
    }
    for (const [key, st] of Array.from(this.snoops).sort((a, b) => cmp(a[0], b[0]))) {
      const dev = key.slice(0, key.indexOf('|'));
      for (const [p, until] of Array.from(st.routerPorts)) if (until <= now) st.routerPorts.delete(p);
      for (const [g, ports] of Array.from(st.groups)) {
        for (const [p, e] of Array.from(ports)) {
          if (e.until > now) continue;
          ports.delete(p);
          this.e.note('table', 'igmp', dev, '', 'member port expired', '', `${dev}: port ${p} is no member port of ${g} in ${vlanName(Number(key.slice(key.indexOf('|') + 1)))} any more (${e.leaving ? 'nobody answered the group-specific queries after the leave' : 'no report within the membership interval'})`);
        }
        if (!ports.size) st.groups.delete(g);
      }
    }
    for (const [dev, t] of Array.from(this.mroutes).sort((a, b) => cmp(a[0], b[0]))) {
      for (const e of Array.from(t.values())) {
        let changed = false;
        for (const [oif, until] of Array.from(e.oil)) {
          if (until > now) continue;
          e.oil.delete(oif);
          changed = true;
          this.e.note('table', 'pim', dev, '', 'oif expired', '', `${dev}: ${this.entryName(e)} out of ${oif} expired (no Join for ${durationText(JOIN_HOLD)})`);
        }
        for (const [oif, until] of Array.from(e.pruned)) if (until <= now) e.pruned.delete(oif);
        if (changed) this.maybePrune(dev, e);
        if (e.local && e.lastData >= 0 && now - e.lastData > SG_KEEPALIVE) {
          t.delete(e.s + '|' + e.g);
          this.e.note('table', 'pim', dev, '', 'source gone', '', `${dev}: no data from ${e.s} for ${e.g} for ${durationText(SG_KEEPALIVE)}: its entry goes`);
        }
      }
    }
    // a receiver that lost its stream
    for (const r of this.rx.values()) {
      const st = this.streams.find((x) => x.group === r.group && x.running);
      // (a real-time stream's datagrams come every interval of real time: as far apart in simulated time as they came lately)
      const every = st ? Math.max(st.interval, st.gap || 0) : 0;
      if (!st || r.gapNoted || r.last < 0 || now - r.last <= 3 * every + 2000) continue;
      if (!this.member(r.dev, this.joinedIface(r.dev, r.group) || '', A(r.group), A(Array.from(r.sources)[0] || '0.0.0.0'))) continue;
      r.gapNoted = true;
      this.e.note('drop', 'mcast', r.dev, '', 'stream lost', 'waiting', `${r.dev} has received nothing of ${r.group} for ${durationText(now - r.last)} (the stream comes every ${durationText(st.interval)}): its branch of the tree is broken`);
    }
  }

  /** An interface came up again: its querier candidacy starts afresh (startup queries; a lower querier silences it again). */
  private ifaceUp(dev: string, l3: L3Iface): void {
    for (const [k, ri] of Array.from(this.rifs).sort((a, b) => cmp(a[0], b[0]))) {
      if (k.indexOf(dev + '|' + l3.id + '|') !== 0 || ri.running || !this.e.deviceOn(dev)) continue;
      this.P.whenIfaceUp(dev, l3.id, () => {
        if (!ri.running) this.startElection(ri);
      });
    }
  }

  /** A router interface's LAN in words: its VLAN ("VLAN 10"), else the interface and its subnet. */
  private lanOf(l3: L3Iface, addr: IpAddr): string {
    if (l3.vlan) return `VLAN ${l3.vlan}`;
    const a = l3.addrs.find((x) => x.addr === addr);
    const prefix = a ? `${formatAddr(a.net)}/${a.net.prefix}` : '';
    const net = a ? this.P.m.networks.find((n) => n.vlan !== undefined && n.cidr === prefix) : undefined;
    return net ? `VLAN ${net.vlan}` : prefix || l3.id;
  }

  private joinedIface(dev: string, group: string): string | null {
    for (const [k, m] of this.hosts) if (k.slice(0, k.indexOf('|')) === dev && m.has(group)) return k.slice(k.indexOf('|') + 1);
    return null;
  }

  /** An interface went down: what was learned and forwarded there goes, its querier candidacy with it. */
  private ifaceDown(dev: string, l3: L3Iface): void {
    for (const [k, ri] of this.rifs) if (k.indexOf(dev + '|' + l3.id + '|') === 0) {
      ri.groups.clear();
      this.stopElection(ri);
    }
    const t = this.mroutes.get(dev);
    if (!t) return;
    for (const e of Array.from(t.values())) {
      if (e.oil.delete(l3.id)) {
        this.e.note('table', 'pim', dev, '', 'oif removed', '', `${dev}: ${this.entryName(e)} no longer goes out of ${l3.id} (the interface went down)`);
        this.maybePrune(dev, e);
      }
    }
  }

  private deviceDown(dev: string): void {
    this.mroutes.delete(dev);
    // its candidacies end with it (their schedules too); powered on, they start again
    for (const ri of this.rifs.values()) if (ri.dev === dev) {
      ri.groups.clear();
      this.stopElection(ri);
    }
    for (const c of this.sqs.values()) if (c.dev === dev) this.stopElection(c);
    for (const k of Array.from(this.snoops.keys())) if (k.indexOf(dev + '|') === 0) this.snoops.delete(k);
    for (const k of Array.from(this.heard.keys())) if (k.indexOf(dev + '|') === 0) this.heard.delete(k);
    for (const [k, m] of this.hosts) if (k.indexOf(dev + '|') === 0) for (const hg of m.values()) hg.gen++;
  }

  private deviceUp(dev: string): void {
    // its querier candidates start again: on their interface (a router's), or with its first port up (a switch's)
    for (const ri of Array.from(this.rifs.values())) if (ri.dev === dev) this.P.whenIfaceUp(dev, ri.l3.id, () => {
      if (!ri.running) this.startElection(ri);
    });
    for (const c of Array.from(this.sqs.values())) if (c.dev === dev) this.P.whenAnyPortUp(dev, () => {
      if (!c.running && this.e.deviceOn(dev)) this.startElection(c);
    });
    // a host reports its groups again
    for (const [k, m] of Array.from(this.hosts).sort((a, b) => cmp(a[0], b[0]))) {
      if (k.indexOf(dev + '|') !== 0) continue;
      const iface = k.slice(dev.length + 1);
      for (const hg of Array.from(m.values())) this.e.after(500, () => this.report(dev, iface, hg, 'reports again after booting'));
    }
  }

  // ------------------------------------------------------------ the log

  /** A log line written once per key and 10 s (repeating conditions: RPF failures, no RP, TTL 1 …). */
  private note(key: string, kind: 'drop' | 'note' | 'wait', dev: string, text: string): void {
    const last = this.noted.get(key);
    if (last !== undefined && this.e.now - last < 10000) return;
    this.noted.set(key, this.e.now);
    this.e.note(kind, key.indexOf('fwmc') === 0 || key.indexOf('nopim') === 0 || key.indexOf('ttl1') === 0 ? 'mcast' : 'pim', dev, '', kind === 'drop' ? 'dropped' : kind === 'wait' ? 'waiting' : 'note', '', text);
  }

  /** A snooping line at the moment the frame passes (its way is decided when it is sent). */
  private noteAt(t: number, kind: 'table', dev: string, text: string): void {
    this.e.at(t, () => this.e.note(kind, 'igmp', dev, '', 'snooping', '', text));
  }

  // ------------------------------------------------------------ events, status, tables

  netEvents(): NetEvent[] {
    return this.events.slice();
  }

  private status(): SessionStatus[] {
    const out: SessionStatus[] = [];
    for (const st of this.streams) {
      const bps = st.origin === 'demand' ? this.demandBps.get(st.dev + '|' + st.group) : undefined;
      const what = bps !== undefined ? `demand ${st.label}: ${st.sent} sent; ${representativeText(bps, st.interval, st.size + 28)}` : `${st.sent} datagrams of ${st.size} bytes, one every ${durationText(st.interval)}${st.origin === 'event' ? ' (Start stream)' : ''}`;
      out.push({ protocol: st.origin === 'demand' ? 'demand' : 'mcast', name: `${st.dev} → ${st.group}:${st.port}`, device: st.dev, peer: '', state: !st.running ? 'Stopped' : st.sent ? 'Sending' : 'Waiting', detail: what, up: st.running && st.sent > 0 });
    }
    for (const [k, m] of Array.from(this.hosts).sort((a, b) => cmp(a[0], b[0]))) {
      const dev = k.slice(0, k.indexOf('|'));
      for (const hg of Array.from(m.values()).sort((a, b) => cmp(a.group, b.group))) {
        const r = this.rx.get(dev + '|' + hg.group);
        const ok = !!r && r.last >= 0 && !r.gapNoted;
        out.push({ protocol: 'igmp', name: `${dev} member of ${hg.group}${hg.sources.length ? ' (' + hg.sources.join(', ') + ')' : ''}`, device: dev, peer: '', state: ok ? 'Receiving' : r && r.gapNoted ? 'Lost' : 'Joined', detail: r ? `${r.count} datagrams, the last at t = ${fmtSec(r.last)}, from ${Array.from(r.sources).join(', ')}` : `joined at t = ${fmtSec(hg.since)}; nothing received yet`, up: ok || !r });
      }
    }
    for (const ri of Array.from(this.rifs.values()).sort((a, b) => cmp(a.dev + a.l3.id, b.dev + b.l3.id))) {
      if (!ri.groups.size) continue;
      out.push({ protocol: 'igmp', name: `${ri.dev}:${ri.l3.id} ${this.name(ri.addr.version)}`, device: ri.dev, peer: '', state: ROLE_WORD[this.roleOf(ri)], detail: `${ri.groups.size} group${ri.groups.size === 1 ? '' : 's'} with members${ri.querier ? '' : '; the querier is ' + (ri.otherAddr || '?')}`, up: true });
    }
    return out;
  }

  private timer(key: string, dev: string): TableTimer {
    const r = this.e.params.get(key, dev);
    return { label: r.def.label, value: formatValue(r.def, r.value), source: r.source, origin: sourceText(r, true) };
  }

  /** A router's IGMP / MLD groups (Show IGMP groups). */
  igmpTable(dev: string): GridTable {
    const rows: string[][] = [];
    const notes: string[] = [];
    for (const ri of Array.from(this.rifs.values()).filter((x) => x.dev === dev).sort((a, b) => cmp(a.l3.id, b.l3.id))) {
      const role = this.roleOf(ri);
      notes.push(`${ri.l3.id} (${formatAddr(ri.addr)}, ${ri.lan}): ${role === 'querier' ? 'the querier' : role === 'starting' ? 'the querier for now (starting: its startup queries)' : role === 'non-querier' ? 'not the querier (' + (ri.otherAddr || '?') + ' queries)' : role === 'off' ? 'no querier candidate (its querier is off)' : 'down'}`);
      for (const g of Array.from(ri.groups.values()).sort((a, b) => cmp(a.group, b.group))) rows.push([ri.l3.id, g.group, g.reporter, g.version, g.sources.join(', ') || 'any', dur(g.expires - this.e.now)]);
    }
    return { caption: `IGMP / MLD groups of ${dev}`, cols: ['Interface', 'Group', 'Last reporter', 'Version', 'Sources', 'Expires in'], rows, empty: 'No group has members on its interfaces.', timers: ['igmp-query', 'igmp-max-resp', 'igmp-robustness', 'igmp-lmqi', 'igmp-version'].map((k) => this.timer(k, dev)), notes };
  }

  /**
   * A switch's IGMP / MLD snooping table (Show snooping table): per VLAN its
   * multicast router ports, then the member ports of each group (version,
   * sources, who reported), with their remaining time; the notes say what
   * each VLAN's setting is (and what that means), and whether the device
   * routes multicast besides (that is its multicast routes, not this table).
   */
  snoopTable(dev: string): GridTable {
    const rows: string[][] = [];
    const now = this.e.now;
    const md = this.P.m.index.devices.get(dev);
    const vlans = md ? switchedVlans(md) : [];
    const learned = new Set<number>();
    for (const [k, st] of Array.from(this.snoops).sort((a, b) => Number(a[0].slice(a[0].indexOf('|') + 1)) - Number(b[0].slice(b[0].indexOf('|') + 1)))) {
      if (k.slice(0, k.indexOf('|')) !== dev) continue;
      const vlan = Number(k.slice(k.indexOf('|') + 1));
      const vn = vlan ? String(vlan) : 'untagged';
      for (const [port, until] of Array.from(st.routerPorts).sort((a, b) => cmp(a[0], b[0]))) {
        if (until <= now) continue;
        const q = st.querier && st.querier.port === port && st.querier.until > now ? `; the querier ${st.querier.dev || st.querier.addr} (${st.querier.addr}) is behind it` : '';
        rows.push([vn, '—', port, `multicast router port: every group goes there, members or not (a query or PIM Hello arrived there${q}); not a membership`, dur(until - now)]);
        learned.add(vlan);
      }
      for (const [g, ports] of Array.from(st.groups).sort((a, b) => cmp(a[0], b[0]))) {
        const fam = (parseAddress(g) as IpAddr).version === 4 ? 'IGMP' : 'MLD';
        for (const [port, e] of Array.from(ports).sort((a, b) => cmp(a[0], b[0]))) {
          if (e.until <= now) continue;
          rows.push([vn, `${g} (${fam})`, port, `member port: ${e.version}, ${e.sources.length ? 'sources ' + e.sources.join(', ') : 'any source'}, reported by ${e.reporter}${e.leaving ? '; leave pending (it goes unless a member answers the group-specific queries)' : ''}`, dur(e.until - now)]);
          learned.add(vlan);
        }
      }
    }
    // each VLAN's setting, grouped by what it is
    const by = (c: SnoopingChoice): number[] => vlans.filter((v) => this.snoopMode(dev, v) === c);
    const notes: string[] = [];
    const en = by('enabled');
    const dis = by('disabled');
    const unset = by('unset');
    const fl = en.filter((v) => this.unregisteredPolicy(dev, v) === 'flood');
    const rp = en.filter((v) => this.unregisteredPolicy(dev, v) !== 'flood');
    if (rp.length) notes.push(`Snooping enabled in VLAN ${vlanRangesShown(rp, true)}: a group goes to its member ports and the router ports; a group without members (unregistered) to the router ports only — none there, nowhere (unregistered_multicast: router-ports, RFC 4541 §2.1.2).`);
    if (fl.length) notes.push(`Snooping enabled in VLAN ${vlanRangesShown(fl, true)}: a group goes to its member ports and the router ports; a group without members is flooded to every port (unregistered_multicast: flood).`);
    if (dis.length) notes.push(`Snooping disabled in VLAN ${vlanRangesShown(dis, true)}: multicast is flooded to every port of the VLAN.`);
    if (unset.length) notes.push(`Not configured in VLAN ${vlanRangesShown(unset, true)}: a configuration error (choose enabled or disabled); flooded meanwhile.`);
    notes.push('Reports and leaves go to the router ports only; link-local groups (224.0.0.0/24, ff02::/16: queries, routing protocols) are flooded.');
    const sd = this.P.sd(dev);
    // its role in each VLAN with snooping enabled, as its badges on the diagram say (Show querier election has the timers)
    for (const r of this.snoopRoles(dev)) notes.push(`${r.text}: ${r.detail.slice(dev.length + 2)}.`);
    for (const v of en) {
      if (!sd || this.e.params.str('snoop-querier', dev, vlanRef(v)) !== 'on' || this.sqs.has(dev + '|' + v)) continue;
      notes.push(`The snooping querier is on for VLAN ${v}, but ${dev} has no IPv4 address there to query from: no candidate.`);
    }
    if (sd && sd.routes) notes.push(this.mcRouter(dev) ? `${dev} also routes multicast (PIM) between its VLAN interfaces: see Show multicast routes; this table is its Layer 2 snooping only.` : `${dev} routes no multicast (it runs no PIM): nothing crosses its VLAN interfaces; this table is its Layer 2 snooping only.`);
    return {
      caption: `IGMP / MLD snooping of ${dev}`,
      cols: ['VLAN', 'Group', 'Port', 'Entry', 'Expires in'],
      rows,
      empty: en.length ? `No memberships and no router port learned in VLAN ${vlanRangesShown(en, true)}.` : 'Snooping is enabled in none of its VLANs: nothing is learned, multicast is flooded.',
      timers: ['fast-leave', 'mrouter-aging', 'snoop-querier'].map((k) => this.timer(k, dev)),
      notes,
    };
  }

  /** Does a device have a snooping table (a switch)? */
  snoopDevice(dev: string): boolean {
    const sd = this.P.sd(dev);
    return !!sd && sd.bridge && sd.caps.switchFeatures;
  }

  /**
   * A host's own memberships (Show group memberships): the groups it has
   * joined on each interface, how (the model, Join group), its filter (any
   * source, or its sources) and what it received of each.
   */
  memberTable(dev: string): GridTable {
    const rows: string[][] = [];
    for (const [k, m] of Array.from(this.hosts).sort((a, b) => cmp(a[0], b[0]))) {
      if (k.slice(0, k.indexOf('|')) !== dev) continue;
      const iface = k.slice(k.indexOf('|') + 1);
      for (const hg of Array.from(m.values()).sort((a, b) => cmp(a.group, b.group))) {
        const v = (parseAddress(hg.group) as IpAddr).version;
        const r = this.rx.get(dev + '|' + hg.group);
        rows.push([
          iface,
          hg.group,
          this.verName(v, this.ver(dev, iface)),
          hg.sources.length ? `only from ${hg.sources.join(', ')}` : 'any source',
          `t = ${fmtSec(hg.since)} (${hg.origin === 'event' ? 'Join group' : 'the model'})`,
          r && r.last >= 0 ? `${r.count} datagram${r.count === 1 ? '' : 's'}, the last at t = ${fmtSec(r.last)}${r.gapNoted ? ' (lost since)' : ''}` : 'nothing yet',
        ]);
      }
    }
    return {
      caption: `Group memberships of ${dev}`,
      cols: ['Interface', 'Group', 'Version', 'Filter', 'Joined', 'Received'],
      rows,
      empty: 'No memberships: it has joined no group.',
      timers: ['igmp-version', 'igmp-unsolicited'].map((k) => this.timer(k, dev)),
      notes: ['Its own memberships, as a host: they stay until it leaves (its intent); the switches learn them from its reports (their snooping tables), the multicast routers per interface (their IGMP / MLD groups), and both forget them if its reports stop arriving.'].concat(this.heardNotes(dev)),
    };
  }

  /** Who queries each of a host's LANs: the last query it heard, or none heard (no querier reaches it). */
  private heardNotes(dev: string): string[] {
    const sd = this.P.sd(dev);
    if (!sd) return [];
    const out: string[] = [];
    for (const l3 of Array.from(sd.l3.values()).sort((a, b) => cmp(a.id, b.id))) {
      if (l3.kind === 'loopback' || l3.kind === 'tunnel') continue;
      for (const v of [4, 6] as Array<4 | 6>) {
        if (!l3.addrs.some((a) => a.addr.version === v)) continue;
        const h = this.heard.get(`${dev}|${l3.id}|${v}`);
        const n = this.name(v);
        out.push(h ? `${l3.id}: the last ${n} query from ${h.from} at t = ${fmtSec(h.at)}.` : `${l3.id}: no ${n} query heard yet (no querier reaches it, or not yet): its memberships are only learned from its own reports.`);
      }
    }
    return out;
  }

  /**
   * A device's querier candidacies (Show querier election): per LAN its
   * address, its role from the election (starting, querier, non-querier),
   * the querier it yields to and how long until it would take over, its
   * queries; under it the timers.
   */
  querierTable(dev: string): GridTable {
    const rows = this.querierRoles(dev).map((q): string[] => [
      q.lan + (q.kind === 'router' && q.iface ? ` (${q.iface})` : ''),
      q.family,
      q.addr,
      ROLE_WORD[q.role],
      q.role === 'non-querier' ? q.other || '?' : q.role === 'querier' || q.role === 'starting' ? 'itself' : '—',
      // the timer it waits for: its next query (in its startup: which one), or its takeover
      q.nextAt >= 0 ? `query at t = ${fmtSec(q.nextAt)}${q.startup ? ` (startup ${q.startup})` : ''}` : q.takeoverAt >= 0 ? `takes over at t = ${fmtSec(q.takeoverAt)} unless it hears ${q.other || 'the querier'}` : q.role === 'down' ? 'none (down)' : q.role === 'off' ? 'none (not a candidate)' : '—',
      q.queries ? `${q.queries}, the last at t = ${fmtSec(q.lastQuery)}` : 'none yet',
    ]);
    return {
      caption: `Querier election of ${dev}`,
      cols: ['LAN', 'Family', 'Address', 'Role', 'Querier', 'Next', 'General queries'],
      rows,
      empty: 'No querier candidacy: it is configured as no querier on any of its LANs.',
      timers: ['igmp-query', 'igmp-max-resp', 'igmp-robustness'].map((k) => this.timer(k, dev)),
      notes: [
        'The lowest address on a LAN is its querier (IGMPv2 / v3, MLD). A candidate starts as the querier and sends its startup queries (robustness of them, a quarter of the query interval apart); it stops when it hears a query from a lower address, and takes over again when that one is silent for the other querier present interval (robustness × query interval + response interval ÷ 2).',
      ],
    };
  }

  /** Does a device take part in a querier election (a router's interface, a switch's VLAN)? */
  querierDevice(dev: string): boolean {
    for (const c of this.candidates()) if (c.dev === dev) return true;
    return false;
  }

  /** Does a device have memberships of its own to show (an addressed host, not a router)? */
  memberDevice(dev: string): boolean {
    const sd = this.P.sd(dev);
    return !!sd && !sd.routes && !sd.bridge && Array.from(sd.l3.values()).some((l) => l.addrs.length > 0);
  }

  /** A router's multicast routing table (Show multicast routes). */
  mrouteTable(dev: string): GridTable {
    const rows: string[][] = [];
    const now = this.e.now;
    const t = this.mroutes.get(dev);
    if (t) {
      for (const e of Array.from(t.values()).sort((a, b) => cmp(a.g, b.g) || (a.s === '*' ? -1 : b.s === '*' ? 1 : cmp(a.s, b.s)))) {
        const oil = Array.from(e.oil).filter(([, u]) => u > now).sort((a, b) => cmp(a[0], b[0])).map(([o, u]) => `${o} (${u === Infinity ? 'members' : u === FLOOD ? 'flooded' : dur(u - now)})`);
        const flags = [e.mode === 'dense' ? 'dense' : e.mode === 'ssm' ? 'SSM' : 'sparse', e.s === '*' && this.isRp(dev, e.g) ? 'RP' : '', e.spt ? 'SPT' : '', e.registering ? 'registering' : '', e.local ? 'source connected' : '', e.rptPruned.size ? 'RPT pruned: ' + Array.from(e.rptPruned).join(', ') : '', e.pruned.size ? 'pruned: ' + Array.from(e.pruned.keys()).join(', ') : ''].filter((x) => x);
        rows.push([this.entryName(e), e.iif ? `${e.iif}${e.nbr ? ' (' + e.nbr + ')' : ''}` : e.local ? 'source' : 'none', oil.join(', ') || 'none', flags.join(', '), dur(now - e.created)]);
      }
    }
    const groups = Array.from(new Set(Array.from(t ? t.values() : []).filter((e) => e.s === '*').map((e) => e.g))).sort(cmp);
    const rpNotes = (groups.length ? groups : ['239.0.0.0']).map((g) => {
      const rp = this.rp(dev, g);
      const what = groups.length ? `RP for ${g}` : 'RP (IPv4 any-source groups)';
      return rp ? `${what}: ${formatAddr(rp.addr)} (${rp.dev}), ${rp.how}` : `${what}: none known here — sparse-mode groups cannot be joined.`;
    });
    return { caption: `Multicast routes of ${dev}`, cols: ['Entry', 'Incoming (RPF)', 'Outgoing interfaces', 'Flags', 'Age'], rows, empty: 'No multicast route: nobody joined a group through it.', timers: ['pim-dr-priority', 'spt-switchover'].map((k) => this.timer(k, dev)), notes: [...rpNotes, `Join/Prune period 60 s, holdtime ${durationText(JOIN_HOLD)} (RFC 7761)`] };
  }

  /** Does a router run IGMP / MLD on an interface (Show IGMP groups)? */
  igmpDevice(dev: string): boolean {
    for (const ri of this.rifs.values()) if (ri.dev === dev) return true;
    return false;
  }

  /** A host's streams (running or stopped). */
  streamsOf(dev: string): Array<{ iface: string; group: string; port: number; running: boolean }> {
    return this.streams.filter((s) => s.dev === dev && s.origin !== 'demand').map((s) => ({ iface: s.iface, group: s.group, port: s.port, running: s.running }));
  }

  /** Every group joined in the model or by an event (multicast test traffic sends to these). */
  groups(): string[] {
    const out = new Set<string>();
    for (const m of this.hosts.values()) for (const g of m.keys()) out.add(g);
    for (const j of this.modelJoins()) out.add(formatAddr(A(j.group)));
    return Array.from(out).sort(cmp);
  }

}

function inNet(a: { net: IpAddr & { prefix: number } }, ip: IpAddr): boolean {
  if (a.net.version !== ip.version) return false;
  let bits = a.net.prefix;
  for (let i = 0; i < ip.bytes.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((a.net.bytes[i] & mask) !== (ip.bytes[i] & mask)) return false;
  }
  return true;
}

/** A querier role in words. */
const ROLE_WORD: { [k in QuerierRole]: string } = { starting: 'Querier (startup)', querier: 'Querier', 'non-querier': 'Standby (non-querier)', off: 'Not a candidate', down: 'Down' };

/** A remaining time as the tables write it. */

