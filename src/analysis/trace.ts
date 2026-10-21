/**
 * The path tracer: the way traffic from a source to a destination takes
 * through the model, hop by hop, as the routing tables of analysis/routing.ts
 * decide it. A model-based approximation, not a simulation of the
 * protocols:
 *
 *   * every router decides by its own table (connected networks, static
 *     routes, routes learned over routing adjacencies), in the VRF of the
 *     interface the traffic came in on; nothing leaks between VRFs;
 *   * a next hop is the device that has the next-hop address (or, for a
 *     virtual address of a redundancy group such as VRRP, its active
 *     member); between the two, the cables are found through layer-2
 *     devices (switches, access points, clouds), following the VLAN of the
 *     network where the link ends say which VLANs they carry, one shortest
 *     way (as a spanning tree would leave it), with all members of a LAG;
 *   * a tunnel interface encapsulates: the encapsulation stack is the
 *     tunnel relation at the interface and the tunnel relations it is
 *     carried `over`; the underlay is traced as a packet from the tunnel's
 *     source to its destination when the tables lead there, else it is the
 *     `over:` chain of the relation, down to its cables;
 *   * equal-cost next hops branch: every branch is followed (up to
 *     MAX_PATHS), the first one (in the tables' order) is the main path.
 *
 *   * virtual networking (analysis/trace-virtual.ts): a guest's vNIC leaves
 *     its host through its port group's virtual switch and the teaming's
 *     uplink (or its passthrough port); ends on one virtual switch or one
 *     container network meet inside the host, without a cable;
 *   * NAT, only for container bridges (a limited model): a container host
 *     forwards its bridge networks' traffic, and with NAT its source address
 *     becomes the host's (SNAT); a container behind NAT is reached from
 *     outside its host only at its host's address, on a published port
 *     (DNAT), the port numbers named, not checked.
 *
 * ACLs, firewall policies, other NAT, policy routing and protocol timers are
 * not modelled. Results are sorted by values, never by the order of the
 * file.
 */
import { deviceRoutingRole, isLayer2Switch, capabilities } from '../model/capabilities';
import { IpAddr, IpPrefix, parseAddress, parsePrefix } from '../model/ip';
import { lookupProtocol } from '../model/protocols';
import { Interface, Link, LinkEnd, Model, Relation, deviceInterfaces, ifaceKey, Device } from '../model/types';
import { endL2, interfaceVlanPorts, interfaceVlans, isBridgePort, associationOf } from '../model/derive';
import { compareAddr, comparePrefix, formatAddr, inPrefix, networkOf, prefixText } from './ipmath';
import { virtualGateways } from './identity';
import { sharedDomain, virtEnd, virtRefText } from './trace-virtual';
import { cnetNetworkId, cnetRef, vethNetwork } from '../model/virtual';
import { PolicyFlow, configuredIds, ctxIds, policyDecision, policyKind, undecided } from './policy';
import type { Verdict } from './result';
import { decide, decideBreak, profileAt, rulesBetween, ruleServiceText, ruleText, domainOf } from './separation';
import { deviceTypeInText, deviceTypeLine, NO_DEVICE_TYPE } from '../model/device-types';
import {
  Connected,
  Decision,
  DecisionHop,
  RibEntry,
  RoutingCtx,
  compareEntries,
  connectedIn,
  connectedOf,
  ifaceVrf,
  lookup,
  ribOf,
  routeRef,
  routeText,
  routingAdjacencies,
  vrfKey,
  vrfName,
} from './routing';

/** At most this many hops on one path (a loop stops earlier). */
export const MAX_HOPS = 32;
/** At most this many equal-cost paths are followed. */
export const MAX_PATHS = 16;
/** Tunnels inside tunnels: at most this deep. */
const MAX_DEPTH = 4;

/** Device types a frame may cross at layer 2 between two hops (without a type: generic). */

// ------------------------------------------------------------ endpoints

/** A source or destination as the user gives it. */
export type TraceEnd = { kind: 'device'; device: string } | { kind: 'iface'; device: string; iface: string } | { kind: 'address'; address: string };

/** Read a source or destination: "device", "device:interface" or an IP address (an error message when none fits). */
export function parseTraceEnd(model: Model, text: string): TraceEnd | string {
  const t = text.trim();
  if (!t) return 'Enter a device, an interface (device:interface) or an IP address';
  if (model.index.interfaces.has(t)) {
    const i = model.index.interfaces.get(t) as Interface;
    return { kind: 'iface', device: i.device, iface: i.id };
  }
  if (model.index.devices.has(t)) return { kind: 'device', device: t };
  const a = parseAddress(t.replace(/\/[0-9]+$/, ''));
  if (a) return { kind: 'address', address: formatAddr(a) };
  return `“${t}” is no device, interface (device:interface) or IP address of the model`;
}

export function traceEndText(e: TraceEnd): string {
  return e.kind === 'device' ? e.device : e.kind === 'iface' ? e.device + ':' + e.iface : e.address;
}

// ------------------------------------------------------------ results

export type StopReason = 'no-route' | 'unresolved' | 'no-adjacency' | 'blackhole' | 'loop' | 'not-forwarding' | 'down' | 'too-long' | 'denied';

/** How a path ends. */
export type PathEnd =
  | { kind: 'reached'; device: string; iface?: string }
  /** handed to a network the destination is in, where no device of the model has it */
  | { kind: 'delivered'; device: string; network?: string }
  /** sent to a next hop outside the model, towards a destination outside it */
  | { kind: 'exits'; device: string; gateway: string }
  | { kind: 'stopped'; device: string; reason: StopReason; detail: string };

/** One layer of an encapsulation: a tunnel relation (or a tunnel interface without one). */
export interface EncapLayer {
  label: string;
  relation?: string;
}

/** What a hop used to forward. */
export interface HopVia {
  kind: 'local' | 'connected' | 'static' | 'dynamic' | 'blackhole' | 'none';
  /** e.g. "static route 0.0.0.0/0 via 10.0.0.1", "OSPF over ospf-muc, cost 100" */
  text: string;
  route?: string;
  relation?: string;
}

export interface Hop {
  device: string;
  vrf: string;
  /** where the traffic came in (none on the first hop) */
  ingress?: string;
  inAddr?: string;
  /** where it goes out */
  egress?: string;
  outAddr?: string;
  /** the next-hop address, when the route has one */
  gateway?: string;
  via: HopVia;
  /** the encapsulation the packet is in when it leaves (outermost last), and the layers this hop adds */
  encap: EncapLayer[];
  /** to the next hop: cables, layer-2 devices crossed, networks, relations used */
  links: string[];
  l2: string[];
  /** inside a host on the way to the next hop: port groups, virtual switches, container networks, the uplinks used (refs) */
  virtual: string[];
  /** a container host translating the addresses: SNAT (the source becomes its address), DNAT (to a published port) */
  nat?: 'snat' | 'dnat';
  networks: string[];
  relations: string[];
  /** a tunnel's underlay, traced (the tunnel's outer packet) */
  underlay?: Path;
  /** how many equal-cost next hops this hop had (> 1: the path branches here) */
  ecmp: number;
  /** which of them this path takes (0: the first) */
  branch: number;
  notes: string[];
  /** why this hop forwards as it does: the decision data the tracer used ("Why this hop?") */
  why?: HopWhy;
}

/** A table entry as the evidence names it. */
export interface RouteChoice {
  /** "static route 0.0.0.0/0 via 10.0.0.1", "OSPF route 10.9.0.0/24 over ospf-a (cost 20, distance 110)" */
  text: string;
  prefix: string;
  distance: number;
  metric: number;
  /** the route's or relation's ref, for navigation */
  ref?: string;
}

/** A matching entry that was not used, and why. */
export interface RouteAlternative extends RouteChoice {
  lost: 'longer-prefix' | 'distance' | 'metric' | 'unusable';
  detail: string;
}

/**
 * The evidence of one hop, collected while the tracer decides (never
 * reconstructed afterwards): the lookup, the entries selected and why they
 * won, the matching entries that lost, the layer-2 way, the policy
 * decisions, the translation, the tunnel, and where it stops the first
 * unmet prerequisite.
 */
export interface HopWhy {
  /** "10.9.0.10 in the default table of r1" */
  lookup: string;
  selected: RouteChoice[];
  /** "longest matching prefix /24, then the lowest distance (1) and metric (0)" */
  rule: string;
  alternatives: RouteAlternative[];
  /** the layer-2 way to the next hop, in words */
  l2?: string;
  /** what a filtering device decided (permitted, or the denial) */
  policy: string[];
  nat?: string;
  tunnel?: string;
  /** the first unmet prerequisite, where the path stops at this hop */
  stop?: string;
}

/** At most this many alternatives are listed per hop. */
const MAX_ALTERNATIVES = 6;

export interface Path {
  hops: Hop[];
  end: PathEnd;
}

export interface TraceRequest {
  from: string;
  to: string;
  /** what is sent ("tcp/443", "udp/53", "icmp"): a Security gateway's policy decides by it; none: what its rules would permit */
  service?: string;
  /** the VRF of the source's table ('' the default table); none: the source interface's VRF, else the default table */
  vrf?: string;
  /** the address family asked for: both ends in it only, never the other one instead; none: the ends' (the source's families, IPv4 first) */
  family?: 4 | 6;
}

export interface Trace {
  /** set when the request can't be traced: then there are no paths */
  error?: string;
  request: TraceRequest;
  source?: { device: string; iface?: string; address?: string; vrf: string };
  dest?: { address: string; device?: string; iface?: string };
  /** the main path first, then the equal-cost alternatives */
  paths: Path[];
  /** more equal-cost paths existed than were followed */
  truncated: boolean;
  /** a protocol break: the transfer ended at the gateway, which starts a new one of its own (the second leg, traced on its own) */
  legs?: Array<{ note: string; trace: Trace }>;
}

/** A trace's service ("tcp/443", "udp/53", "icmp"; "" none), or the reason it can't be read. */
export interface TraceService {
  proto: 'tcp' | 'udp' | 'icmp';
  port?: number;
}
export function parseService(text: string | undefined): TraceService | null | string {
  const t = (text || '').trim().toLowerCase();
  if (!t) return null;
  if (t === 'icmp' || t === 'ping') return { proto: 'icmp' };
  const m = /^(tcp|udp)[\s/:]+(\d{1,5})$/.exec(t);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) return `"${text}" is not a service: write tcp/443, udp/53 or icmp`;
  return { proto: m[1] as 'tcp' | 'udp', port: Number(m[2]) };
}

// ------------------------------------------------------------ the tracer

interface Walk {
  model: Model;
  ctx: RoutingCtx;
  dest: IpAddr;
  destText: string;
  /** a device of the model has the destination address */
  destInModel: boolean;
  /** the encapsulation the packet is in */
  encap: EncapLayer[];
  depth: number;
  /** tunnels already in the stack (device:iface): never used again for the outer packet */
  inside: string[];
  truncated: boolean;
  /** the source address (for the SNAT note) */
  srcText?: string;
  /** the destination is a container behind its host's NAT: the walk goes to the host's address, then on to the container */
  dnat?: Dnat;
  /** the source address, and what is sent (a Security gateway's policy decides by them) */
  src?: IpAddr;
  /** the traced ends' devices: the owners a policy's device spec is checked against (an address two VRFs have is theirs here) */
  srcDev?: string;
  destDev?: string;
  svc?: TraceService | null;
}

interface Dnat {
  host: string;
  hostAddr: string;
  device: string;
  iface: string;
  address: string;
  /** the container network (its owner and name) */
  owner: string;
  net: string;
  bridge?: string;
  gateway?: string;
  ports: string;
}

/**
 * Trace the way from `req.from` to `req.to` (see the module comment). The
 * context gives what is up (a failure simulation); without one, all is.
 */
export function tracePath(model: Model, req: TraceRequest, ctx: RoutingCtx = {}): Trace {
  const out: Trace = { request: req, paths: [], truncated: false };
  const src = parseTraceEnd(model, req.from);
  if (typeof src === 'string') return { ...out, error: 'Source: ' + src };
  const dst = parseTraceEnd(model, req.to);
  if (typeof dst === 'string') return { ...out, error: 'Destination: ' + dst };
  const vrfGiven = req.vrf !== undefined ? req.vrf.trim() : undefined;
  const svc = parseService(req.service);
  if (typeof svc === 'string') return { ...out, error: 'Service: ' + svc };
  // where it starts
  let srcDev: string;
  let srcIface: string | undefined;
  let srcAddr: IpAddr | undefined;
  const fam = req.family;
  const famText = fam ? `IPv${fam} ` : '';
  if (src.kind === 'address') {
    const a = parseAddress(src.address) as IpAddr;
    if (fam && a.version !== fam) return { ...out, error: `Source: ${src.address} is an IPv${a.version} address, not IPv${fam}` };
    const owners = holders(model, a, ctx, null).filter((h) => vrfGiven === undefined || h.vrf === vrfGiven);
    if (!owners.length) return { ...out, error: `Source: ${src.address} is not an address of a device in the model${vrfGiven !== undefined ? ' in ' + vrfName(vrfGiven) : ''}` };
    srcDev = owners[0].device;
    srcIface = owners[0].iface;
    srcAddr = a;
  } else {
    srcDev = src.device;
    srcIface = src.kind === 'iface' ? src.iface : undefined;
  }
  // where it goes
  let destAddr: IpAddr | null = null;
  let destDev: string | undefined;
  let destIface: string | undefined;
  const srcFamilies = fam ? familiesOf(model, srcDev, srcIface, ctx).filter((v) => v === fam) : familiesOf(model, srcDev, srcIface, ctx);
  if (fam && !srcFamilies.length) return { ...out, error: `Source: ${srcIface !== undefined ? `${srcDev}:${srcIface}` : srcDev} has no IPv${fam} address` };
  if (dst.kind === 'address') {
    destAddr = parseAddress(dst.address);
    if (fam && destAddr && destAddr.version !== fam) return { ...out, error: `Destination: ${dst.address} is an IPv${destAddr.version} address, not IPv${fam}` };
    const owners = destAddr ? holders(model, destAddr, ctx, null) : [];
    if (owners.length) {
      destDev = owners[0].device;
      destIface = owners[0].iface;
    }
  } else {
    destDev = dst.device;
    destIface = dst.kind === 'iface' ? dst.iface : undefined;
    const c = pickAddress(model, dst.device, destIface, srcFamilies, undefined, ctx);
    // (a family asked for is that family's address or none: pickAddress prefers, it does not restrict)
    if (!c || (fam && c.addr.version !== fam)) return { ...out, error: `Destination: ${traceEndText(dst)} has no ${famText}address to trace to` };
    destAddr = c.addr;
    destIface = c.iface;
  }
  if (!destAddr) return { ...out, error: 'Destination: not an address' };
  const vrf = vrfGiven !== undefined ? vrfGiven : srcIface !== undefined ? ifaceVrf(model, srcDev, srcIface) : '';
  let pickedIface: string | undefined;
  if (!srcAddr) {
    const c = srcIface !== undefined ? connectedIn(model, srcDev, ctx).find((x) => x.iface === srcIface && x.addr.version === (destAddr as IpAddr).version) : pickAddress(model, srcDev, undefined, [(destAddr as IpAddr).version], vrf, ctx);
    if (c) {
      srcAddr = c.addr;
      pickedIface = c.iface;
    }
  }
  out.source = { device: srcDev, vrf };
  // (the interface whose address the trace starts from, also when only the device was given: shown, it changes nothing)
  if (srcIface !== undefined) out.source.iface = srcIface;
  else if (pickedIface !== undefined) out.source.iface = pickedIface;
  if (srcAddr) out.source.address = formatAddr(srcAddr);
  out.dest = { address: formatAddr(destAddr) };
  if (destDev !== undefined) out.dest.device = destDev;
  if (destIface !== undefined) out.dest.iface = destIface;
  if (destDev === srcDev) return { ...out, error: `Source and destination are the same device (${srcDev})` };
  // a container behind its host's NAT: from outside the host only at the host's address, on a published port
  let dnat: Dnat | undefined;
  if (destDev !== undefined && destIface !== undefined) {
    const r = natDestination(model, srcDev, destDev, destIface, formatAddr(destAddr), srcFamilies.length ? srcFamilies : [destAddr.version]);
    if (typeof r === 'string') return { ...out, error: 'Destination: ' + r };
    if (r) dnat = r;
  }
  const walkDest = dnat ? (parseAddress(dnat.hostAddr) as IpAddr) : destAddr;
  const w: Walk = { model, ctx, dest: walkDest, destText: formatAddr(walkDest), destInModel: destDev !== undefined, encap: [], depth: 0, inside: [], truncated: false };
  if (srcAddr) w.srcText = formatAddr(srcAddr);
  if (srcAddr) w.src = srcAddr;
  w.srcDev = srcDev;
  if (destDev !== undefined) w.destDev = destDev;
  w.svc = svc;
  if (dnat) w.dnat = dnat;
  out.paths = walk(w, { device: srcDev, vrf }, [], new Set());
  out.truncated = w.truncated;
  // a protocol break: a transfer to one of its listening ports ends there, and the gateway starts the second leg itself
  const main = out.paths[0];
  if (main && main.end.kind === 'reached' && main.end.iface !== undefined && svc && svc.proto !== 'icmp' && srcAddr) {
    const g = model.index.devices.get(main.end.device);
    const at = g ? profileAt(g, main.end.iface, svc.proto, svc.port as number) : undefined;
    if (g && at) {
      const d = decideBreak(g, main.end.iface, srcAddr, at.profile);
      const last = main.hops[main.hops.length - 1];
      if (!d.ok || !d.forward) {
        last.notes.push(`${d.text}: the first leg ends at ${g.id} and no second leg is started`);
        main.end = { kind: 'stopped', device: g.id, reason: 'denied', detail: d.text };
      } else {
        const note = `Protocol break at ${g.id}: the ${at.kind.label.toLowerCase()} from ${formatAddr(srcAddr)} ends at ${g.id}:${main.end.iface} port ${at.profile.listenPort} (leg 1); ${g.id} starts a new ${at.kind.transport.toUpperCase()} transfer of its own to ${formatAddr(d.forward.address)}:${d.forward.port} (leg 2, profile ${at.profile.id}, ${ruleText(d.rule)}). No packet of leg 1 crosses.${at.kind.reply ? ' The answer comes back on leg 2 and the gateway answers on leg 1.' : ' Nothing comes back.'}`;
        last.notes.push(note);
        if (depthOf(req) < 2) {
          const leg2 = tracePath(model, { from: g.id, to: formatAddr(d.forward.address), service: `${at.kind.transport}/${d.forward.port}`, _depth: depthOf(req) + 1 } as TraceRequest, ctx);
          out.legs = [{ note, trace: leg2 }];
        }
      }
    }
  }
  return out;
}

/** (a protocol break's second leg is traced once, never a third) */
function depthOf(req: TraceRequest): number {
  return (req as TraceRequest & { _depth?: number })._depth || 0;
}

/** The return trace of a trace: from its destination back to its source address. */
export function returnRequest(t: Trace): TraceRequest | null {
  if (!t.source || !t.dest || !t.dest.device || !t.source.address) return null;
  return { from: t.dest.iface !== undefined ? t.dest.device + ':' + t.dest.iface : t.dest.device, to: t.source.address };
}

interface At {
  device: string;
  vrf: string;
  ingress?: string;
  inAddr?: string;
}

function walk(w: Walk, at: At, before: Hop[], seen: Set<string>): Path[] {
  const { model } = w;
  const hop: Hop = { device: at.device, vrf: at.vrf, via: { kind: 'none', text: '' }, encap: w.encap.slice(), links: [], l2: [], virtual: [], networks: [], relations: [], ecmp: 1, branch: 0, notes: [] };
  if (at.ingress !== undefined) hop.ingress = at.ingress;
  if (at.inAddr !== undefined) hop.inAddr = at.inAddr;
  const stop = (reason: StopReason, detail: string): Path[] => {
    hop.via = { kind: reason === 'blackhole' ? 'blackhole' : 'none', text: detail };
    if (!hop.why) hop.why = { lookup: `${w.destText} at ${at.device}`, selected: [], rule: '', alternatives: [], policy: [] };
    hop.why.stop = detail;
    return [{ hops: before.concat(hop), end: { kind: 'stopped', device: at.device, reason, detail } }];
  };
  const key = at.device + '\0' + at.vrf;
  if (seen.has(key)) return stop('loop', `the path comes back to ${at.device} (${vrfName(at.vrf)}): a routing loop`);
  if (before.length >= MAX_HOPS) return stop('too-long', `more than ${MAX_HOPS} hops`);
  const d = model.index.devices.get(at.device);
  if (!d) return stop('unresolved', `${at.device} is not in the model`);
  const decision: Decision = lookup(model, at.device, at.vrf, w.dest, w.ctx);
  hop.why = explainDecision(model, at, w.dest, w.destText, decision, w.ctx);
  if (decision.kind === 'local' && w.dnat && w.dnat.host === at.device) return dnatHops(w, hop, before);
  if (decision.kind === 'local') {
    const own = connectedIn(model, at.device, w.ctx).find((c) => compareAddr(c.addr, w.dest) === 0);
    hop.via = { kind: 'local', text: `${w.destText} is an address of ${at.device}${own ? ' (' + own.iface + ')' : ''}` };
    return [{ hops: before.concat(hop), end: own ? { kind: 'reached', device: at.device, iface: own.iface } : { kind: 'reached', device: at.device } }];
  }
  // only routers pass traffic on (the first hop sends its own)
  // (a container host forwards the traffic of its bridge networks: it came in on the bridge's interface)
  if (before.length > 0 && deviceRoutingRole(d) !== 'router' && !fromBridge(model, at)) {
    const caps = capabilities(d);
    if (caps.sessionBreak && caps.securityGateway) {
      const listens = (d.separation ? d.separation.profiles : []).filter((p) => p.listenInterface !== undefined).map((p) => `${p.id} at ${p.listenInterface} port ${p.listenPort}`);
      return stop('denied', `${at.device} is a protocol break: nothing passes through it. A transfer is addressed to one of its listening ports (${listens.join('; ') || 'it has no transfer profiles'}), and it starts a new one of its own on the other side`);
    }
    if (caps.securityGateway) return stop('denied', `${at.device} transfers nothing: its Domain separation has no implementation chosen`);
    const what = d.type === 'generic' ? 'device without a type' : isLayer2Switch(d) ? 'Layer 2 switch' : deviceTypeLine(d);
    return stop('not-forwarding', `${at.device} is a ${what} and does not forward traffic for others`);
  }
  if (decision.kind === 'blackhole') {
    const e = decision.entries[0];
    hop.via = viaOf(model, e);
    hop.via.kind = 'blackhole';
    const detail = `${hop.via.text} drops the traffic (a black hole)`;
    if (hop.why) hop.why.stop = detail;
    return [{ hops: before.concat(hop), end: { kind: 'stopped', device: at.device, reason: 'blackhole', detail } }];
  }
  if (decision.kind === 'none') return noRoute(w, at, hop, before, decision);
  const nextSeen = new Set(seen);
  nextSeen.add(key);
  const paths: Path[] = [];
  decision.hops.forEach((h, i) => {
    if (paths.length >= MAX_PATHS) {
      w.truncated = true;
      return;
    }
    const hp: Hop = { ...hop, encap: hop.encap.slice(), links: [], l2: [], virtual: [], networks: [], relations: [], notes: [], ecmp: decision.hops.length, branch: i };
    if (hop.why) hp.why = { ...hop.why, selected: hop.why.selected.slice(), alternatives: hop.why.alternatives.slice(), policy: [] };
    for (const p of step(w, at, hp, h, before, nextSeen)) {
      if (paths.length >= MAX_PATHS) {
        w.truncated = true;
        break;
      }
      paths.push(p);
    }
  });
  return paths;
}

/** No usable route: say why (the routes that would match but can't be used, or a routing adjacency that can't form). */
function noRoute(w: Walk, at: At, hop: Hop, before: Hop[], decision: Decision): Path[] {
  const { model } = w;
  const end = (reason: StopReason, detail: string): Path[] => {
    hop.via = { kind: 'none', text: detail };
    if (hop.why) hop.why.stop = detail;
    return [{ hops: before.concat(hop), end: { kind: 'stopped', device: at.device, reason, detail } }];
  };
  if (decision.unusable.length) {
    const u = decision.unusable[0];
    const what = u.entry.route ? `the route ${routeText(u.entry.route)}` : u.entry.implicit ? `the ${u.entry.implicit}` : u.entry.kind === 'dynamic' ? `the ${protoLabel(model, u.entry.protocol || '')} route to ${prefixText(u.entry.net)}` : `the connected network ${prefixText(u.entry.net)}`;
    if (u.entry.route) hop.relations = [];
    const r = end(/down/.test(u.detail) ? 'down' : 'unresolved', `no usable route to ${w.destText}: ${what} can't be used (${u.detail})`);
    if (u.entry.route) r[0].hops[r[0].hops.length - 1].via.route = routeRef(u.entry.route);
    return r;
  }
  // a routing adjacency of this device that can't form, in a protocol that would know the destination
  // (only one whose neighbour knows the way: it has a route to the destination)
  const miss = routingAdjacencies(model, w.ctx).missing.filter((m) => m.from === at.device && lookup(model, m.to, routingVrf(model, m), w.dest, w.ctx).kind !== 'none');
  if (miss.length) {
    const m = miss[0];
    const r = end('no-adjacency', `no route to ${w.destText} in ${vrfName(at.vrf)}; the ${protoLabel(model, m.protocol)} adjacency ${m.relation} to ${m.to} can't form: ${m.detail}`);
    r[0].hops[r[0].hops.length - 1].relations = [m.relation];
    return r;
  }
  return end('no-route', `no route to ${w.destText} in ${vrfName(at.vrf)} of ${at.device}`);
}

/** The VRF of the neighbour's end of a routing adjacency (its endpoint interface's, else the default table). */
function routingVrf(model: Model, m: { relation: string; to: string }): string {
  const r = model.index.relations.get(m.relation);
  const e = r ? r.endpoints.find((x) => x.device === m.to && x.iface !== undefined) : undefined;
  return e && e.iface !== undefined ? ifaceVrf(model, m.to, e.iface) : '';
}

/** Follow one next hop of a decision. */
function step(w: Walk, at: At, hop: Hop, h: DecisionHop, before: Hop[], seen: Set<string>): Path[] {
  const { model } = w;
  hop.via = viaOf(model, h.entry);
  if (h.entry.relation) hop.relations.push(h.entry.relation);
  hop.egress = h.iface;
  const why = hop.why as HopWhy;
  // what may pass this hop: a filtering router's policy, a VPN gateway's tunnels (traffic it forwards, not its own)
  if (before.length > 0 && at.ingress !== undefined) {
    const dev = model.index.devices.get(at.device) as Device;
    const n0 = hop.notes.length;
    const denied = forwardDenied(w, dev, at.ingress, h.iface, hop.notes);
    for (const n of hop.notes.slice(n0)) why.policy.push(n);
    if (denied) {
      hop.via = { kind: 'none', text: denied };
      why.policy.push(denied);
      why.stop = denied;
      return [{ hops: before.concat(hop), end: { kind: 'stopped', device: at.device, reason: 'denied', detail: denied } }];
    }
  }
  const target = h.gateway || w.dest;
  if (h.gateway) hop.gateway = formatAddr(h.gateway);
  const conn = connectedIn(model, at.device, w.ctx).filter((c) => c.iface === h.iface);
  const outNet = conn.filter((c) => inPrefix(c.net, target)).sort((a, b) => b.net.prefix - a.net.prefix)[0] || conn[0];
  if (outNet) hop.outAddr = outNet.address.replace(/\/[0-9]+$/, '');
  // a NAT service on the way out: the translation in the hop
  const n1 = hop.notes.length;
  if (before.length > 0 && at.ingress !== undefined) natNote(w, model.index.devices.get(at.device) as Device, at.ingress, h.iface, hop);
  if (outNet) for (const n of networksOf(model, outNet.net)) hop.networks.push(n);
  const iface = model.index.interfaces.get(ifaceKey(at.device, h.iface));
  // from a container bridge with NAT out of another interface: the host's address becomes the source
  const snat = natBridgeIn(model, at);
  if (snat && h.iface !== at.ingress && hop.outAddr) {
    hop.nat = 'snat';
    hop.notes.push(`SNAT: source ${w.srcText || 'address'} → ${hop.outAddr} (${devLabel(model, at.device)} masquerades the network ${snat})`);
  }
  if (hop.nat) why.nat = hop.notes.slice(n1).join('; ');
  // the next device: the one with the next-hop address (or the destination, when it is connected)
  const owners = holders(model, target, w.ctx, at.device);
  let next: { device: string; iface: string; vrf: string; address: string } | null = owners.length ? owners[0] : null;
  if (owners.length > 1) hop.notes.push(`${formatAddr(target)} is an address of ${owners.map((o) => o.device + ':' + o.iface).join(' and ')}; the trace follows ${owners[0].device}`);
  if (!next) {
    const vip = vipHolder(model, target, w.ctx, at.device);
    if (vip) {
      next = vip.holder;
      if (vip.relation) hop.relations.push(vip.relation);
      hop.notes.push(vip.note);
    }
  }
  if (!next) {
    if (!h.gateway) {
      const net = hop.networks[0];
      return [{ hops: before.concat(hop), end: { kind: 'delivered', device: at.device, network: net } }];
    }
    if (!w.destInModel) return [{ hops: before.concat(hop), end: { kind: 'exits', device: at.device, gateway: formatAddr(h.gateway) } }];
    const detail = `the next hop ${formatAddr(h.gateway)} is not an address of a device in the model`;
    why.stop = detail;
    return [{ hops: before.concat(hop), end: { kind: 'stopped', device: at.device, reason: 'unresolved', detail } }];
  }
  // between the two: a tunnel's underlay, or the cables
  if (iface && iface.type === 'tunnel') {
    const t = tunnelStep(w, at.device, iface, next.device);
    for (const l of t.layers) hop.encap.push(l);
    for (const r of t.layers) if (r.relation && hop.relations.indexOf(r.relation) < 0) hop.relations.push(r.relation);
    hop.links = t.links;
    hop.l2 = t.devices;
    for (const n of t.networks) if (hop.networks.indexOf(n) < 0) hop.networks.push(n);
    for (const r of t.relations) if (hop.relations.indexOf(r) < 0) hop.relations.push(r);
    if (t.underlay) hop.underlay = t.underlay;
    if (t.note) hop.notes.push(t.note);
    why.tunnel = `${h.iface} encapsulates it (${encapText(t.layers)}) to ${next.device}: ${t.underlay ? `the outer packet is traced from ${at.device} to ${next.device}` : t.stop ? t.stop.detail : t.note || 'the underlay is not in the model'}`;
    if (t.stop) {
      why.stop = t.stop.detail;
      return [{ hops: before.concat(hop), end: { kind: 'stopped', device: at.device, reason: t.stop.reason, detail: t.stop.detail } }];
    }
  } else {
    const vlan = outNet ? vlanOfNet(model, outNet.net) : undefined;
    const seg = l2Segment(model, w.ctx, { device: at.device, iface: h.iface }, { device: next.device, iface: next.iface }, vlan, (dev, inPort, outPort, notes) => crossDenied(w, dev, inPort, outPort, notes));
    if (seg.kind === 'none') {
      why.l2 = (vlan !== undefined ? `VLAN ${vlan}: ` : '') + seg.detail;
      if (seg.denied) why.policy.push(seg.detail);
      why.stop = seg.detail;
      return [{ hops: before.concat(hop), end: { kind: 'stopped', device: seg.at || at.device, reason: seg.denied ? 'denied' : 'no-adjacency', detail: seg.detail } }];
    }
    if (seg.kind === 'uncabled') {
      hop.notes.push(seg.detail);
      why.l2 = seg.detail;
    } else {
      hop.links = seg.links;
      hop.l2 = seg.devices;
      const inside = (seg.notes || []).find((n) => n.indexOf('inside ') === 0);
      why.l2 =
        (vlan !== undefined ? `VLAN ${vlan}: ` : '') +
        (inside && !seg.links.length ? inside : `${seg.devices.length ? 'through ' + seg.devices.join(', ') : 'a direct cable'}${seg.links.length ? ` (cable${seg.links.length > 1 ? 's' : ''} ${seg.links.join(', ')})` : ''}`) +
        ` to ${next.device}:${next.iface}`;
    }
    for (const r of seg.virtual || []) if (hop.virtual.indexOf(r) < 0) hop.virtual.push(r);
    for (const n of seg.notes || []) hop.notes.push(n);
  }
  return walk(w, { device: next.device, vrf: next.vrf, ingress: next.iface, inAddr: next.address }, before.concat(hop), seen);
}

/** What a table entry is, in words. */
function viaOf(model: Model, e: RibEntry): HopVia {
  if (e.kind === 'connected') return { kind: 'connected', text: `connected network ${prefixText(e.net)}` };
  if (e.kind === 'dynamic') {
    const p = protoLabel(model, e.protocol || '');
    // where it was originated and how, its BGP attributes, the policy decisions on its way
    const o = e.origin;
    // (a plain connected network of the router it was learned from needs no word; anything else is said)
    const origin = o && (o.how !== 'connected' || o.history.length) ? `; originated by ${o.device} (${o.how === 'redistributed' ? `redistributed out of ${o.from}` : o.how === 'default' ? 'its default route' : o.how === 'advertised' ? 'advertised' : 'connected'}${o.history.length ? ', through ' + o.history.join(' → ') : ''})` : '';
    const bgp = e.asPath ? `; AS path ${e.asPath.length ? e.asPath.join(' ') : '(empty: own AS)'}, local preference ${e.localPref}` : '';
    const pol = e.policy && e.policy.length ? `; ${e.policy.join('; ')}` : '';
    return { kind: 'dynamic', text: `${p} route ${prefixText(e.net)} over ${e.relation} (cost ${e.metric}, distance ${e.distance}${origin}${bgp}${pol})`, relation: e.relation };
  }
  const r = e.route;
  if (!r && e.implicit) return { kind: 'static', text: e.implicit };
  return r ? { kind: 'static', text: `static route ${routeText(r)}`, route: routeRef(r) } : { kind: 'static', text: `static route ${prefixText(e.net)}` };
}

/**
 * The evidence of a forwarding decision, from the decision itself and the
 * table it was made from: the selected entries and the rule that chose them,
 * and the matching entries that lost (to a longer prefix, a lower distance
 * or metric) or could not be used (with the resolver's reason).
 */
function explainDecision(model: Model, at: At, dest: IpAddr, destText: string, d: Decision, ctx: RoutingCtx): HopWhy {
  const why: HopWhy = { lookup: `${destText} in ${vrfName(at.vrf)} of ${at.device}`, selected: [], rule: '', alternatives: [], policy: [] };
  if (d.kind === 'local') {
    why.rule = `${destText} is an address of ${at.device}`;
    return why;
  }
  const choice = (e: RibEntry): RouteChoice => {
    const v = viaOf(model, e);
    const c: RouteChoice = { text: v.text, prefix: prefixText(e.net), distance: e.distance, metric: e.metric };
    if (v.route) c.ref = v.route;
    else if (v.relation) c.ref = 'relation:' + v.relation;
    return c;
  };
  const same = (a: RibEntry, b: RibEntry): boolean => a.kind === b.kind && compareEntries(a, b) === 0;
  why.selected = d.entries.map(choice);
  const best = d.entries[0];
  if (best) {
    why.rule =
      d.kind === 'blackhole'
        ? `the selected entry for ${prefixText(best.net)} is a blackhole route`
        : `the longest matching prefix ${prefixText(best.net)}, then the lowest distance (${best.distance}) and metric (${best.metric})${d.hops.length > 1 ? `: ${d.hops.length} equal-cost next hops` : ''}`;
  } else why.rule = 'no matching entry can be used';
  const matching = ribOf(model, at.device, at.vrf, ctx)
    .filter((e) => inPrefix(e.net, dest) && !d.entries.some((x) => same(x, e)))
    .sort((a, b) => b.net.prefix - a.net.prefix || compareEntries(a, b));
  for (const e of matching) {
    if (why.alternatives.length >= MAX_ALTERNATIVES) break;
    const c = choice(e);
    const u = d.unusable.find((x) => same(x.entry, e));
    if (u) why.alternatives.push({ ...c, lost: 'unusable', detail: `can't be used: ${u.detail}` });
    else if (!best) continue;
    else if (e.net.prefix < best.net.prefix) why.alternatives.push({ ...c, lost: 'longer-prefix', detail: `${prefixText(best.net)} is a longer match` });
    else if (e.distance > best.distance) why.alternatives.push({ ...c, lost: 'distance', detail: `distance ${e.distance} is higher than ${best.distance}` });
    else why.alternatives.push({ ...c, lost: 'metric', detail: `metric ${e.metric} is higher than ${best.metric}` });
  }
  return why;
}

function protoLabel(model: Model, p: string): string {
  return p ? lookupProtocol(model.protocols, p).label : 'routing';
}

// ------------------------------------------------------------ container NAT

function devLabel(model: Model, id: string): string {
  const d = model.index.devices.get(id);
  return d ? d.label : id;
}

/** Did the traffic come in on a container network's bridge interface (docker0) of this device? */
function fromBridge(model: Model, at: At): boolean {
  if (at.ingress === undefined) return false;
  const i = model.index.interfaces.get(ifaceKey(at.device, at.ingress));
  return !!i && i.type === 'bridge' && i.derived !== undefined;
}

/** The NAT bridge network the traffic came in on (its name), if any. */
function natBridgeIn(model: Model, at: At): string | undefined {
  if (!fromBridge(model, at)) return undefined;
  const i = model.index.interfaces.get(ifaceKey(at.device, at.ingress as string)) as Interface;
  const d = model.index.devices.get(at.device);
  const net = d && d.containerEngine ? d.containerEngine.networks.find((n) => n.name === i.derived) : undefined;
  return net && net.nat ? net.name : undefined;
}

/**
 * A destination behind its host's NAT: a container's veth on a bridge with
 * NAT, traced from a device that is not on that bridge. Then it is reached
 * at its host's address on a published port (the DNAT), or not at all (a
 * message). Null when there is no NAT in between.
 */
function natDestination(model: Model, srcDev: string, destDev: string, destIface: string, destAddr: string, families: Array<4 | 6>): Dnat | string | null {
  const di = model.index.interfaces.get(ifaceKey(destDev, destIface));
  const x = di && di.type === 'veth' ? vethNetwork(model, di) : undefined;
  if (!di || !x || x.net.driver !== 'bridge' || !x.net.nat) return null;
  const { owner, net } = x;
  // the host itself and the containers on the same bridge reach it directly
  if (srcDev === owner.id) return null;
  const src = model.index.devices.get(srcDev);
  if (src && src.logical.some((i) => i.type === 'veth' && (() => { const y = vethNetwork(model, i); return !!y && y.owner === owner && y.net === net; })())) return null;
  const pubs = di.publish || [];
  if (!pubs.length) return `${destDev} (${destAddr}) is behind the NAT of ${owner.label} (network ${net.name}) and publishes no ports: it can't be reached from outside its host`;
  const outside = connectedOf(model, owner.id).filter((c) => {
    const i = model.index.interfaces.get(ifaceKey(owner.id, c.iface));
    return !!i && i.type !== 'bridge' && families.indexOf(c.addr.version) >= 0 && c.addr.version === 4;
  });
  if (!outside.length) return `${destDev} (${destAddr}) is behind the NAT of ${owner.label}, which has no address to publish its ports on`;
  const ports = pubs.map((p) => `${p.hostPort}→${p.port}/${p.protocol}`).join(', ');
  const out: Dnat = { host: owner.id, hostAddr: formatAddr(outside[0].addr), device: destDev, iface: destIface, address: destAddr, owner: owner.id, net: net.name, ports };
  if (net.iface !== undefined) out.bridge = net.iface;
  if (net.gateway !== undefined) out.gateway = net.gateway;
  return out;
}

/** The host's DNAT to a published port, then the container behind it. */
function dnatHops(w: Walk, hop: Hop, before: Hop[]): Path[] {
  const n = w.dnat as Dnat;
  hop.nat = 'dnat';
  hop.via = { kind: 'connected', text: `DNAT: ${n.hostAddr} (published ${n.ports}) → ${n.address}` };
  if (n.bridge !== undefined) hop.egress = n.bridge;
  if (n.gateway !== undefined) hop.outAddr = n.gateway;
  hop.virtual = [cnetRef(n.owner, n.net)];
  hop.networks = [cnetNetworkId(n.owner, n.net)];
  hop.notes.push(`${devLabel(w.model, n.host)} forwards its published port${n.ports.indexOf(',') >= 0 ? 's' : ''} to ${n.device} on the bridge ${n.bridge || n.net} (the port numbers are named, not checked)`);
  const last: Hop = { device: n.device, vrf: '', ingress: n.iface, inAddr: n.address, via: { kind: 'local', text: `${n.address} is an address of ${n.device} (${n.iface})` }, encap: w.encap.slice(), links: [], l2: [], virtual: [], networks: [], relations: [], ecmp: 1, branch: 0, notes: [] };
  return [{ hops: before.concat(hop, last), end: { kind: 'reached', device: n.device, iface: n.iface } }];
}

// ------------------------------------------------------------ address owners

interface Holder {
  device: string;
  iface: string;
  vrf: string;
  address: string;
}

/** The interfaces that have an address (and are up), other than on `except`; sorted by device and interface. */
function holders(model: Model, a: IpAddr, ctx: RoutingCtx, except: string | null): Holder[] {
  const out: Holder[] = [];
  for (const d of model.devices) {
    if (d.id === except) continue;
    for (const c of connectedIn(model, d.id, ctx)) {
      if (compareAddr(c.addr, a) !== 0 || !up(ctx, d.id, c.iface)) continue;
      out.push({ device: d.id, iface: c.iface, vrf: c.vrf, address: formatAddr(c.addr) });
    }
  }
  return out.sort((x, y) => cmpStr(x.device, y.device) || cmpStr(x.iface, y.iface));
}

function up(ctx: RoutingCtx, device: string, iface: string): boolean {
  return !ctx.up || ctx.up(device, iface);
}

/**
 * A virtual address of a redundancy group (VRRP, HSRP …: the `virtual_ip`
 * of an interface's group) and its active member: the highest `priority`
 * (a member without one counts as 0), then the first by device id; a member
 * that is down hands over to the next. The group's relation (the
 * redundancy relation one of the member interfaces is an endpoint of) is
 * marked with it.
 */
export function vipHolder(model: Model, a: IpAddr, ctx: RoutingCtx, except: string | null): { holder: Holder; relation?: string; note: string } | null {
  const members = virtualGateways(model)
    .filter((g) => compareAddr(g.address, a) === 0)
    .sort((x, y) => (y.priority || 0) - (x.priority || 0) || cmpStr(x.device, y.device) || cmpStr(x.iface, y.iface));
  if (!members.length) return null;
  const svc = (model.services.get(members[0].service) || { label: members[0].service }).label;
  const what = `${svc}${members[0].group !== undefined ? ' group ' + members[0].group : ''}`;
  const live = members.filter((g) => g.device !== except && up(ctx, g.device, g.iface));
  if (!live.length) return null;
  const h = live[0];
  const c = connectedOf(model, h.device).find((x) => x.iface === h.iface);
  const rel = model.relations
    .filter((r) => r.category === 'redundancy' && r.endpoints.some((e) => members.some((g) => g.device === e.device && (e.iface === undefined || e.iface === g.iface))))
    .sort((x, y) => cmpStr(x.id, y.id))[0];
  const first = members[0];
  const note =
    h === first
      ? `${formatAddr(a)} is the virtual address of ${what}; the active member is ${h.device}`
      : `${formatAddr(a)} is the virtual address of ${what}; ${first.device} is down, ${h.device} has taken over`;
  const out: { holder: Holder; relation?: string; note: string } = { holder: { device: h.device, iface: h.iface, vrf: c ? c.vrf : '', address: formatAddr(a) }, note };
  if (rel) out.relation = rel.id;
  return out;
}

/** The families (4, 6) a device (or one interface) has addresses of. */
function familiesOf(model: Model, device: string, iface: string | undefined, ctx?: RoutingCtx): Array<4 | 6> {
  const fams: Array<4 | 6> = [];
  for (const c of connectedIn(model, device, ctx)) if ((iface === undefined || c.iface === iface) && fams.indexOf(c.addr.version) < 0) fams.push(c.addr.version);
  return fams.sort();
}

/**
 * The address to trace to (or from) for a device or interface: of a family
 * the other end has (IPv4 first), a loopback before other interfaces, then
 * by interface id and address.
 */
function pickAddress(model: Model, device: string, iface: string | undefined, families: Array<4 | 6>, vrf?: string, ctx?: RoutingCtx): Connected | null {
  const d = model.index.devices.get(device);
  if (!d) return null;
  const kind = (c: Connected): number => {
    const i = model.index.interfaces.get(ifaceKey(device, c.iface));
    // (a guest's vNIC as a port; a container bridge's interface last: it is no address of the host's own)
    const order = ['loopback', 'physical', 'vnic', 'virtual', 'veth', 'tunnel', 'bridge'];
    return i && order.indexOf(i.type) >= 0 ? order.indexOf(i.type) : order.length;
  };
  // an interface that is down (a failure simulation) is not picked for a device as a whole
  const cands = connectedIn(model, device, ctx).filter((c) => (iface === undefined || c.iface === iface) && (vrf === undefined || c.vrf === vrf) && (iface !== undefined || !ctx || up(ctx, device, c.iface)));
  const fam = (c: Connected): number => (families.length === 0 || families.indexOf(c.addr.version) >= 0 ? 0 : 1);
  cands.sort((a, b) => fam(a) - fam(b) || a.addr.version - b.addr.version || kind(a) - kind(b) || cmpStr(a.iface, b.iface) || compareAddr(a.addr, b.addr));
  return cands[0] || null;
}

/** The networks of the model with exactly this prefix. */
function networksOf(model: Model, net: IpPrefix): string[] {
  const out: string[] = [];
  for (const n of model.networks) {
    const p = n.cidr ? parsePrefix(n.cidr) : null;
    if (p && comparePrefix(networkOf(p), net) === 0) out.push(n.id);
  }
  return out.sort(cmpStr);
}

function vlanOfNet(model: Model, net: IpPrefix): number | undefined {
  for (const id of networksOf(model, net)) {
    const n = model.index.networks.get(id);
    if (n && n.vlan !== undefined) return n.vlan;
  }
  return undefined;
}

// ------------------------------------------------------------ layer 2

interface L2State {
  device: string;
  via: Link | null;
  prev: L2State | null;
}

type Segment = ({ kind: 'ok'; links: string[]; devices: string[] } | { kind: 'uncabled'; detail: string } | { kind: 'none'; detail: string; denied?: boolean; at?: string }) & { virtual?: string[]; notes?: string[] };

/**
 * May a frame cross a Layer 2 device from one of its ports to another? Its
 * reason when not (null: it crosses; notes say on what condition). By
 * capability: a bridge between any ports, an inline or pass-through device
 * only between paired ports (the way the pair permits), a filtering bridge
 * only into its other domain and as far as its policy permits.
 */
type Cross = (dev: Device, inPort: string | undefined, outPort: string | undefined, notes: string[]) => string | null;

/** The physical ports an interface sends out of: itself, an aggregate's members, a VLAN interface's bridge ports, a subinterface's port (aggregates as their members). */
export function portsOf(model: Model, device: string, iface: string): string[] {
  const i = model.index.interfaces.get(ifaceKey(device, iface));
  if (!i) return [];
  if (i.type === 'physical') return [i.id];
  if (i.type !== 'virtual') return [];
  if (i.members.length) return i.members.slice().sort(cmpStr);
  const out: string[] = [];
  for (const p of interfaceVlanPorts(model, i)) {
    const pi = model.index.interfaces.get(ifaceKey(device, p.iface));
    for (const x of pi && pi.members.length ? pi.members : [p.iface]) if (out.indexOf(x) < 0) out.push(x);
  }
  return out.sort(cmpStr);
}

/** Does the port at a link end carry a VLAN? A port that says nothing about VLANs (a host's, a plain routed port) carries what comes. */
function carries(model: Model, e: LinkEnd, vlan: number | undefined): boolean {
  const l = endL2(model, e);
  if (vlan === undefined || !l || !(isBridgePort(l) || (l.kind === 'routed' && l.tagged.length > 0))) return true;
  return l.vlans.indexOf(vlan) >= 0;
}

function endUp(ctx: RoutingCtx, e: LinkEnd): boolean {
  return e.iface === undefined || up(ctx, e.device, e.iface);
}

/**
 * The cables between an interface and the next hop's interface: the
 * shortest way over cables through layer-2 devices (in the VLAN, where the
 * ports say which they carry); ties go to the lower link ids. A cable
 * end without an interface could be any port of its device. When one of
 * the two interfaces has no cable in the model, nothing is known (uncabled);
 * when both have cables but no way joins them, the hop can't be made.
 */
function l2Segment(model: Model, ctx: RoutingCtx, a: { device: string; iface: string }, b: { device: string; iface: string }, vlan: number | undefined, cross?: Cross): Segment {
  const upf = (d: string, i: string): boolean => up(ctx, d, i);
  const va = virtEnd(model, a.device, a.iface, upf, 0, ctx.hostOf);
  const vb = virtEnd(model, b.device, b.iface, upf, 0, ctx.hostOf);
  const pa = va ? va.ports : portsOf(model, a.device, a.iface);
  const pb = vb ? vb.ports : portsOf(model, b.device, b.iface);
  if (!va && !vb) return cabled(model, ctx, a, b, vlan, a.device, pa, b.device, pb, true, cross);
  const refs: string[] = [];
  const notes: string[] = [];
  for (const v of [va, vb]) {
    if (!v) continue;
    for (const r of v.refs) if (refs.indexOf(r) < 0) refs.push(r);
    for (const n of v.notes) if (notes.indexOf(n) < 0) notes.push(n);
  }
  // a macvlan / ipvlan container and its own host can't reach each other
  for (const [v, o, ov] of [
    [va, b, vb],
    [vb, a, va],
  ] as Array<[typeof va, { device: string }, typeof va]>) {
    if (v && v.childOf !== undefined && v.childOf === o.device && !(ov && ov.childOf === v.childOf)) {
      return { kind: 'none', detail: `${devLabel(model, v.childOf)} can't reach its own macvlan / ipvlan containers: its parent interface does not pass traffic between them` };
    }
  }
  const shared = sharedDomain(va, vb);
  if (shared && va && vb && va.vlan !== undefined && vb.vlan !== undefined && va.vlan !== vb.vlan) {
    return { kind: 'none', detail: `${a.device}:${a.iface} (VLAN ${va.vlan}) and ${b.device}:${b.iface} (VLAN ${vb.vlan}) are on ${virtRefText(shared)} in different VLANs (missing layer-2 adjacency)` };
  }
  if (shared) {
    const host = (va as NonNullable<typeof va>).device;
    return { kind: 'ok', links: [], devices: [], virtual: refs, notes: [`inside ${devLabel(model, host)}: on ${virtRefText(shared)}, no cable`].concat(notes) };
  }
  for (const v of [va, vb]) if (v && v.closed) return { kind: 'none', detail: v.closed };
  // out of the host(s) by the ports found, then over the cables
  for (const v of [va, vb]) if (v) for (const p of v.ports) if (refs.indexOf(`iface:${v.device}:${p}`) < 0) refs.push(`iface:${v.device}:${p}`);
  const seg = cabled(model, ctx, a, b, vlan, va ? va.device : a.device, pa, vb ? vb.device : b.device, pb, false, cross);
  return { ...seg, virtual: refs, notes };
}

/** The cabled part of a segment: from ports of one device to ports of another (`a` and `b` name the two ends in messages). */
function cabled(
  model: Model,
  ctx: RoutingCtx,
  a: { device: string; iface: string },
  b: { device: string; iface: string },
  vlan: number | undefined,
  devA: string,
  pa: string[],
  devB: string,
  pb: string[],
  plain: boolean,
  cross?: Cross,
): Segment {
  const links = model.links.slice().sort((x, y) => cmpStr(x.id, y.id));
  const atA = (e: LinkEnd): boolean => e.device === devA && (e.iface === undefined || pa.indexOf(e.iface) >= 0);
  const atB = (e: LinkEnd): boolean => e.device === devB && (e.iface === undefined || pb.indexOf(e.iface) >= 0);
  const startLinks = links.filter((l) => atA(l.a) || atA(l.b));
  const anyAtB = links.some((l) => atB(l.a) || atB(l.b));
  const vtext = vlan !== undefined ? ` in VLAN ${vlan}` : '';
  // a VLAN interface whose VLAN none of its device's tagged cables carries is not connected at all
  for (const [s, ports] of (plain ? [
    [a, pa],
    [b, pb],
  ] : []) as Array<[{ device: string; iface: string }, string[]]>) {
    const i = model.index.interfaces.get(ifaceKey(s.device, s.iface));
    const vl = i ? interfaceVlans(model, i) : [];
    if (!ports.length && vl.length && i && !i.members.length) {
      return { kind: 'none', detail: `VLAN ${vl.join(', ')} of ${s.device}:${s.iface} is on none of ${s.device}’s ports (missing layer-2 adjacency)` };
    }
  }
  if (!startLinks.length || !anyAtB) {
    const side = !startLinks.length ? `${a.device}:${a.iface}` : `${b.device}:${b.iface}`;
    return { kind: 'uncabled', detail: `${side} has no cable in the model: the way between ${a.device} and ${b.device} is not drawn` };
  }
  const linkUp = (l: Link): boolean => (!ctx.linkUp || ctx.linkUp(l.id)) && endUp(ctx, l.a) && endUp(ctx, l.b);
  // breadth-first over devices; a step leaves a device through a cable end and enters the next through the far end
  const queue: L2State[] = [];
  const seenDev = new Set<string>([devA]);
  for (const l of startLinks) {
    if (!linkUp(l)) continue;
    const near = atA(l.a) ? l.a : l.b;
    const far = near === l.a ? l.b : l.a;
    // a unidirectional cable carries traffic from its end a to its end b only
    if (l.direction === 'unidirectional' && near !== l.a) continue;
    if (!carries(model, near, vlan) || !carries(model, far, vlan)) continue;
    if (atB(far)) return finish(model, ctx, { device: far.device, via: l, prev: null });
    if (seenDev.has(far.device)) continue;
    queue.push({ device: far.device, via: l, prev: null });
  }
  for (const s of queue) seenDev.add(s.device);
  let denial: string | null = null;
  let denialAt = '';
  const crossNotes = new Map<L2State, string[]>();
  while (queue.length) {
    const s = queue.shift() as L2State;
    const dev = model.index.devices.get(s.device);
    if (!dev || !l2Transit(dev)) continue;
    const inEnd = s.via ? (s.via.a.device === s.device ? s.via.a : s.via.b) : null;
    for (const l of links) {
      if (l === s.via || !linkUp(l)) continue;
      const near = l.a.device === s.device ? l.a : l.b.device === s.device ? l.b : null;
      if (!near) continue;
      const far = near === l.a ? l.b : l.a;
      if (l.direction === 'unidirectional' && near !== l.a) continue;
      if (!carries(model, near, vlan) || !carries(model, far, vlan) || (inEnd && near.iface !== undefined && inEnd.iface === near.iface)) continue;
      const notes: string[] = (crossNotes.get(s) || []).slice();
      // a Wi-Fi network tunneled to a controller is not traced: a limitation, said so
      const tunneled = [inEnd, near].map((e) => (e ? associationOf(model, e) : undefined)).find((x) => !!x && x.network.forwarding === 'tunneled');
      const why = tunneled ? `${dev.id} tunnels the Wi-Fi network ${tunneled.network.id} to its controller: the tunnel is not traced (a limitation)` : crossing(dev, inEnd ? inEnd.iface : undefined, near.iface, notes, cross);
      const assoc = [inEnd, near].map((e) => (e ? associationOf(model, e) : undefined)).find((x) => !!x);
      if (!why && assoc) notes.push(`${dev.id} bridges the Wi-Fi network ${assoc.network.id} (SSID “${assoc.network.ssid || ''}”) ${assoc.network.vlan !== undefined ? 'to VLAN ' + assoc.network.vlan : 'to its untagged VLAN'}`);
      if (why === false) continue;
      if (why) {
        if (!denial) {
          denial = why;
          denialAt = dev.id;
        }
        continue;
      }
      const next: L2State = { device: far.device, via: l, prev: s };
      crossNotes.set(next, notes);
      if (atB(far)) {
        const seg = finish(model, ctx, next);
        return notes.length ? { ...seg, notes } : seg;
      }
      if (seenDev.has(far.device)) continue;
      seenDev.add(far.device);
      queue.push(next);
    }
  }
  if (denial) return { kind: 'none', detail: denial, denied: true, at: denialAt };
  return { kind: 'none', detail: `no cable path from ${a.device}:${a.iface} to ${b.device}:${b.iface}${vtext} in the model (missing layer-2 adjacency)` };
}

/** Does a device carry frames between its ports at all (a bridge, an inline or pass-through device, an external network; a device without a type is taken as one)? */
function l2Transit(dev: Device): boolean {
  const c = capabilities(dev);
  return dev.type === NO_DEVICE_TYPE || c.l2Transit || c.externalTransit;
}

/**
 * May a frame cross a device from one port to another: the pairing of an
 * inline or pass-through device, then the caller's policy (null: it may; a
 * reason: it is denied; false: that port is no way at all, a management
 * interface or a Security gateway's port in neither domain).
 */
function crossing(dev: Device, inPort: string | undefined, outPort: string | undefined, notes: string[], cross?: Cross): string | null | false {
  const c = capabilities(dev);
  if (dev.management.length && ((inPort !== undefined && dev.management.indexOf(inPort) >= 0) || (outPort !== undefined && dev.management.indexOf(outPort) >= 0))) return false;
  if (c.securityGateway && dev.separation && outPort !== undefined && !domainOf(dev.separation, outPort)) return false;
  if ((c.inline || c.passThrough) && inPort !== undefined && outPort !== undefined) {
    const pair = dev.portPairs.find((p) => (p.a === inPort && p.b === outPort) || (p.b === inPort && p.a === outPort));
    if (!pair) return `${dev.id} passes traffic between its paired ports only: ${inPort} is not paired with ${outPort}`;
    if (pair.direction === 'a_to_b' && pair.a !== inPort) return `${dev.id} passes traffic one way only, from ${pair.a} to ${pair.b}`;
    if (pair.copy.length) notes.push(`${dev.id} gives a copy of what passes ${pair.a} ${pair.direction === 'a_to_b' ? '→' : '↔'} ${pair.b} to ${pair.copy.join(', ')} (${pair.copy.length === 1 ? 'a monitor port' : 'monitor ports'}); the original passes on`);
  }
  return cross ? cross(dev, inPort, outPort, notes) : null;
}

/** A Layer 2 crossing the walk's traffic is not permitted: a filtering bridge's policy, a transparent firewall's (the same engine as a routed hop's). */
function crossDenied(w: Walk, dev: Device, inPort: string | undefined, outPort: string | undefined, notes: string[]): string | null {
  const c = capabilities(dev);
  if (inPort === undefined || outPort === undefined) return null;
  if (c.securityGateway) return policyDenied(w, dev, inPort, outPort, notes);
  // (a router's or Layer 3 switch's policy applies to what it routes, not to what it bridges within a VLAN)
  return c.firewallPolicy ? networkPolicyDenied(w, dev, inPort, outPort, notes) : null;
}

/**
 * A device's network policy on the walk's traffic (analysis/policy.ts, the
 * engine the simulation uses): an explicit `policy:` or a firewall's
 * implicit one. Without a service, a decision that depends on one is said,
 * not guessed.
 */
function networkPolicyDenied(w: Walk, dev: Device, inIface: string, outIface: string, notes: string[]): string | null {
  if (!policyKind(w.model, dev)) return null;
  // (the owner of an address: the traced end's device when it holds it, else its first holder)
  const owner = (a: IpAddr | undefined, end: string | undefined): string | null => {
    if (!a) return null;
    const h = holders(w.model, a, w.ctx, null);
    return end !== undefined && h.some((x) => x.device === end) ? end : h.length ? h[0].device : null;
  };
  // (a device spec's addresses: what the routing context has acquired — a snapshot's, the simulation's leases — else the configured model's, its runtime ones unknown)
  const ids = w.ctx.leases ? ctxIds(w.model, w.ctx) : configuredIds(w.model);
  const flow: PolicyFlow = { src: w.src, dst: w.dest, proto: w.svc ? (w.svc.proto as PolicyFlow['proto']) : 'other', srcDev: owner(w.src, w.srcDev), dstDev: owner(w.dest, w.dnat ? undefined : w.destDev), inIface, outIface, ids };
  if (w.svc && w.svc.proto !== 'icmp') flow.dport = w.svc.port;
  const d = policyDecision(w.model, dev, flow, !!w.svc);
  if (!d) return null;
  if (undecided(d) || d.permit) {
    notes.push(d.text);
    return null;
  }
  return d.text;
}

/** A routed hop the walk's traffic may not take: a filtering router's policy, a VPN gateway's tunnels. */
function forwardDenied(w: Walk, dev: Device, inIface: string, outIface: string, notes: string[]): string | null {
  const c = capabilities(dev);
  if (c.securityGateway) return policyDenied(w, dev, inIface, outIface, notes);
  // a network policy: a router's or Layer 3 switch's `policy:`, a firewall's (explicit, or its relations and allow list), as the simulation applies it
  const np = networkPolicyDenied(w, dev, inIface, outIface, notes);
  if (np) return np;
  if (c.vpnOnlyTransit && dev.vpn) {
    const v = dev.vpn;
    const tunnel = v.tunnels.indexOf(inIface) >= 0 || v.tunnels.indexOf(outIface) >= 0;
    const pool = v.pool !== undefined ? parsePrefix(v.pool) : null;
    const client = !!pool && ((w.src !== undefined && inPrefix(pool, w.src)) || inPrefix(pool, w.dest));
    if (!tunnel && !client) return `${dev.id} is a ${deviceTypeInText('vpn_gateway')}: it forwards only to and from its VPN (${v.tunnels.length ? 'tunnels ' + v.tunnels.join(', ') : 'remote-access clients in ' + (v.pool || 'its pool')}), not from ${inIface} to ${outIface}`;
    notes.push(tunnel ? `${dev.id} forwards it through its VPN (${v.tunnels.filter((t) => t === inIface || t === outIface).join(', ')})` : `${dev.id} forwards it for a remote-access client (${v.pool})`);
  }
  return null;
}

/** A Security gateway's decision on the walk's traffic, between two of its interfaces (see analysis/separation.ts). */
function policyDenied(w: Walk, dev: Device, inIface: string, outIface: string, notes: string[]): string | null {
  if (!w.src) return `${dev.id} decides by the source address: the trace has none`;
  if (w.svc) {
    const d = decide(dev, { inIface, outIface, src: w.src, dst: w.dest, proto: w.svc.proto, dport: w.svc.port });
    if (!d.ok) return d.text;
    notes.push(d.text);
    return null;
  }
  // no service given: it passes if a rule permits something between the two, and says what
  const rules = rulesBetween(dev, inIface, outIface, w.src, w.dest);
  if (!rules.length) {
    const d = decide(dev, { inIface, outIface, src: w.src, dst: w.dest, proto: 'other' });
    return d.text;
  }
  notes.push(`${dev.id} permits only ${rules.map((r) => `${ruleServiceText(r)} (rule ${r.id})`).join(', ')} between these addresses; give a service to trace it exactly`);
  return null;
}

/** The links and layer-2 devices of a found way, with the other up members of each LAG it crosses. */
function finish(model: Model, ctx: RoutingCtx, last: L2State): Segment {
  const links: string[] = [];
  const devices: string[] = [];
  let s: L2State | null = last;
  const chain: Link[] = [];
  while (s) {
    if (s.via) chain.unshift(s.via);
    if (s.prev) devices.unshift(s.prev.device);
    s = s.prev;
  }
  for (const l of chain) {
    links.push(l.id);
    for (const sib of lagSiblings(model, ctx, l)) if (links.indexOf(sib) < 0) links.push(sib);
  }
  return { kind: 'ok', links, devices };
}

/** The other member cables of the aggregate a cable's port belongs to, between the same two devices (and up). */
function lagSiblings(model: Model, ctx: RoutingCtx, l: Link): string[] {
  const out: string[] = [];
  for (const end of [l.a, l.b]) {
    if (end.iface === undefined) continue;
    const d = model.index.devices.get(end.device);
    if (!d) continue;
    const far = end === l.a ? l.b : l.a;
    for (const agg of d.logical) {
      if (agg.members.indexOf(end.iface) < 0) continue;
      for (const m of agg.members) {
        if (m === end.iface) continue;
        const lid = model.index.ifaceLink.get(ifaceKey(end.device, m));
        const o = lid ? model.index.links.get(lid) : undefined;
        if (!o || (ctx.linkUp && !ctx.linkUp(o.id)) || !up(ctx, end.device, m)) continue;
        const ofar = o.a.device === end.device && o.a.iface === m ? o.b : o.a;
        // a unidirectional member joins only a cable that runs one way in the same orientation
        if (o.direction === 'unidirectional' && (l.direction !== 'unidirectional' || o.a.device !== l.a.device)) continue;
        if (ofar.device === far.device && out.indexOf(o.id) < 0) out.push(o.id);
      }
    }
  }
  return out.sort(cmpStr);
}

// ------------------------------------------------------------ tunnels

interface TunnelStep {
  layers: EncapLayer[];
  links: string[];
  devices: string[];
  networks: string[];
  relations: string[];
  underlay?: Path;
  note?: string;
  stop?: { reason: StopReason; detail: string };
}

/** The tunnel relation at an interface (category tunnel or overlay), the first by id. */
export function tunnelRelation(model: Model, device: string, iface: string): Relation | undefined {
  return model.relations
    .filter((r) => (r.category === 'tunnel' || r.category === 'overlay') && r.endpoints.some((e) => e.device === device && e.iface === iface))
    .sort((a, b) => cmpStr(a.id, b.id))[0];
}

/** The encapsulation stack of a tunnel relation: itself, then the tunnel relations it is carried over (first by id at each level). */
export function encapStack(model: Model, r: Relation): EncapLayer[] {
  const out: EncapLayer[] = [];
  let cur: Relation | undefined = r;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push({ label: lookupProtocol(model.protocols, cur.protocol, cur.category).label, relation: cur.id });
    cur = cur.over
      .map((o) => model.index.relations.get(o))
      .filter((x): x is Relation => !!x && (x.category === 'tunnel' || x.category === 'overlay'))
      .sort((a, b) => cmpStr(a.id, b.id))[0];
  }
  return out;
}

/** The cables, networks and relations a relation is carried over, down to the cables. */
export function declaredUnderlay(model: Model, r: Relation): { links: string[]; networks: string[]; relations: string[] } {
  const links: string[] = [];
  const networks: string[] = [];
  const relations: string[] = [];
  const visit = (x: Relation): void => {
    for (const o of x.over) {
      if (model.index.links.has(o)) {
        if (links.indexOf(o) < 0) links.push(o);
      } else if (model.index.networks.has(o)) {
        if (networks.indexOf(o) < 0) networks.push(o);
      } else {
        const c = model.index.relations.get(o);
        if (c && relations.indexOf(o) < 0) {
          relations.push(o);
          visit(c);
        }
      }
    }
  };
  visit(r);
  return { links: links.sort(cmpStr), networks: networks.sort(cmpStr), relations: relations.sort(cmpStr) };
}

/**
 * A packet leaving through a tunnel interface: its encapsulation, and the
 * way of the outer packet (traced from the tunnel's source to its
 * destination; else the relation's `over:` chain).
 */
function tunnelStep(w: Walk, device: string, t: Interface, farDevice: string): TunnelStep {
  const { model } = w;
  const rel = tunnelRelation(model, device, t.id);
  const layers = rel ? encapStack(model, rel) : [{ label: `tunnel ${t.id}` }];
  const res: TunnelStep = { layers, links: [], devices: [], networks: [], relations: [] };
  if (w.ctx.relUp && rel) {
    const down = layers.find((l) => l.relation && !(w.ctx.relUp as (id: string) => boolean)(l.relation));
    if (down) {
      res.stop = { reason: 'down', detail: `the tunnel ${down.relation} is down` };
      return res;
    }
  }
  // the outer packet, traced
  const outer = w.depth < MAX_DEPTH ? outerAddresses(model, device, t) : null;
  if (outer) {
    const inner: Walk = {
      model,
      ctx: withoutTunnels(w.ctx, w.inside.concat(device + ':' + t.id)),
      dest: outer.dest,
      destText: formatAddr(outer.dest),
      destInModel: true,
      encap: w.encap.concat(layers),
      depth: w.depth + 1,
      inside: w.inside.concat(device + ':' + t.id),
      truncated: false,
    };
    const paths = walk(inner, { device, vrf: outer.vrf }, [], new Set());
    const p = paths[0];
    if (p && p.end.kind === 'reached' && p.end.device === farDevice) {
      res.underlay = p;
      for (const h of p.hops) {
        for (const l of h.links) if (res.links.indexOf(l) < 0) res.links.push(l);
        for (const d of h.l2.concat(h.device === device ? [] : [h.device])) if (d !== farDevice && res.devices.indexOf(d) < 0) res.devices.push(d);
        for (const n of h.networks) if (res.networks.indexOf(n) < 0) res.networks.push(n);
        for (const r of h.relations) if (res.relations.indexOf(r) < 0) res.relations.push(r);
      }
      return res;
    }
  }
  // else what the relation is written to run over
  if (rel) {
    const u = declaredUnderlay(model, rel);
    if (u.links.length || u.networks.length) {
      res.links = u.links;
      res.networks = u.networks;
      res.relations = u.relations;
      for (const id of u.links) {
        const l = model.index.links.get(id) as Link;
        for (const d of [l.a.device, l.b.device]) if (d !== device && d !== farDevice && res.devices.indexOf(d) < 0) res.devices.push(d);
      }
      res.devices.sort(cmpStr);
      const downLink = w.ctx.linkUp ? u.links.find((id) => !(w.ctx.linkUp as (x: string) => boolean)(id)) : undefined;
      if (downLink) res.stop = { reason: 'down', detail: `the cable ${downLink} under ${rel.id} is down` };
      else res.note = `the outer packet is not routed in the model; the underlay is the over: chain of ${rel.id}`;
      return res;
    }
  }
  res.note = `the underlay of ${t.id} is not in the model`;
  return res;
}

/** The tunnel's outer source VRF and destination address (none when the destination has no address). */
function outerAddresses(model: Model, device: string, t: Interface): { vrf: string; dest: IpAddr } | null {
  const vrf = t.source && t.source.iface !== undefined ? ifaceVrf(model, device, t.source.iface) : '';
  const d = t.destination;
  if (!d) return null;
  if (d.address !== undefined) {
    const a = parseAddress(d.address);
    return a ? { vrf, dest: a } : null;
  }
  if (d.device !== undefined) {
    const c = pickAddress(model, d.device, d.iface, []);
    return c ? { vrf, dest: c.addr } : null;
  }
  return null;
}

const ctxCache = new WeakMap<RoutingCtx, Map<string, RoutingCtx>>();

/** The context with some tunnel interfaces taken out (the outer packet can't go back into its own tunnel); one object per set, so the routes stay cached. */
function withoutTunnels(ctx: RoutingCtx, ifaces: string[]): RoutingCtx {
  let m = ctxCache.get(ctx);
  if (!m) ctxCache.set(ctx, (m = new Map()));
  const key = ifaces.slice().sort(cmpStr).join('\n');
  let c = m.get(key);
  if (!c) {
    const base = ctx;
    c = { ...ctx, up: (d, i) => ifaces.indexOf(d + ':' + i) < 0 && (!base.up || base.up(d, i)) };
    m.set(key, c);
  }
  return c;
}

// ------------------------------------------------------------ reading a trace

/** The stop reasons in a few words. */
export const STOP_LABEL: { [r in StopReason]: string } = {
  'no-route': 'no route',
  unresolved: 'next hop can’t be resolved',
  'no-adjacency': 'missing adjacency',
  blackhole: 'black hole',
  loop: 'routing loop',
  'not-forwarding': 'does not forward',
  down: 'down',
  'too-long': 'too many hops',
  denied: 'denied by policy',
};

/** One kind of end of the evaluated paths, with how many paths end so. */
export interface OutcomeGroup {
  kind: PathEnd['kind'];
  count: number;
  device: string;
  /** a stop's reason */
  reason?: StopReason;
  /** "reach web-1:eth0", "stop at fw2: denied by policy" */
  text: string;
  detail?: string;
  /** the indices of the paths (0: the main path) */
  paths: number[];
}

/** The outcome of a trace over every evaluated path (never the first path alone). */
export interface TraceOutcome {
  verdict: Verdict;
  groups: OutcomeGroup[];
  total: number;
  /** more equal-cost paths existed than were evaluated: their outcome is not known */
  truncated: boolean;
  /** every path stopped by a policy decision (a firewall, a Security gateway, a VPN gateway's rule), not by routing */
  policyOnly: boolean;
}

/**
 * The outcome of a trace: all evaluated paths reach the destination
 * (satisfied), none does and all stop (violated), they differ (partial), or
 * they leave the modeled architecture or end in a network where no modeled
 * device has the address (beyond). An error is indeterminate. Paths are
 * grouped by how and where they end, in the order of the first path of each.
 */
export function traceOutcome(t: Trace): TraceOutcome {
  const groups: OutcomeGroup[] = [];
  t.paths.forEach((p, i) => {
    const e = p.end;
    const key = (g: OutcomeGroup): boolean => g.kind === e.kind && g.device === e.device && (e.kind !== 'stopped' || (g.reason === e.reason && g.detail === e.detail));
    const cur = groups.find(key);
    if (cur) {
      cur.count++;
      cur.paths.push(i);
      return;
    }
    const g: OutcomeGroup = { kind: e.kind, count: 1, device: e.device, text: '', paths: [i] };
    if (e.kind === 'reached') g.text = `reach ${e.device}${e.iface ? ':' + e.iface : ''}`;
    else if (e.kind === 'delivered') g.text = `are handed into ${e.network ? 'network ' + e.network : 'the connected network'} by ${e.device}; no modeled device has ${t.dest ? t.dest.address : 'the address'}, so receipt is not established`;
    else if (e.kind === 'exits') g.text = `leave the modeled architecture at ${e.device} towards ${e.gateway}`;
    else {
      g.reason = e.reason;
      g.detail = e.detail;
      g.text = `stop at ${e.device} (${STOP_LABEL[e.reason]})`;
    }
    groups.push(g);
  });
  const n = (k: PathEnd['kind']): number => groups.filter((g) => g.kind === k).reduce((s, g) => s + g.count, 0);
  const total = t.paths.length;
  const reached = n('reached');
  const stopped = n('stopped');
  let verdict: Verdict;
  if (t.error || !total) verdict = 'indeterminate';
  else if (reached === total) verdict = 'satisfied';
  else if (stopped === total) verdict = 'violated';
  else if (reached === 0 && stopped === 0) verdict = 'beyond';
  else verdict = 'partial';
  const policyOnly = stopped === total && total > 0 && groups.every((g) => g.reason === 'denied');
  return { verdict, groups, total, truncated: t.truncated, policyOnly };
}

/** The outcome as lines: "3 evaluated paths reach web-1:eth0", "1 evaluated path stops at fw2 (denied by policy)". */
export function outcomeLines(o: TraceOutcome): string[] {
  const lines = o.groups.map((g) => {
    const verb = g.text.replace(/^(\S+)/, (w) => (g.count === 1 ? singular(w) : w));
    return `${g.count} evaluated path${g.count === 1 ? '' : 's'} ${verb}`;
  });
  if (o.truncated) lines.push(`More equal-cost paths exist than the ${o.total} evaluated (limit ${MAX_PATHS}): their outcome is not known.`);
  return lines;
}

function singular(verb: string): string {
  return verb === 'reach' ? 'reaches' : verb === 'stop' ? 'stops' : verb === 'leave' ? 'leaves' : verb === 'are' ? 'is' : verb;
}

/** An address a device or interface could be traced from or to. */
export interface EndpointChoice {
  device: string;
  iface: string;
  vrf: string;
  /** without the prefix length */
  address: string;
  version: 4 | 6;
}

/**
 * The addresses an end could stand for (configured, and in a snapshot the
 * acquired ones), sorted as the tracer prefers them: loopback before ports,
 * then by interface and address. One choice means nothing needs choosing.
 */
export function endpointChoices(model: Model, end: TraceEnd, ctx: RoutingCtx = {}): EndpointChoice[] {
  if (end.kind === 'address') {
    const a = parseAddress(end.address);
    return a ? holders(model, a, ctx, null).map((h) => ({ device: h.device, iface: h.iface, vrf: h.vrf, address: h.address, version: a.version })) : [];
  }
  const out: EndpointChoice[] = [];
  const order = ['loopback', 'physical', 'vnic', 'virtual', 'veth', 'tunnel', 'bridge'];
  const kind = (i: string): number => {
    const x = model.index.interfaces.get(ifaceKey(end.device, i));
    return x && order.indexOf(x.type) >= 0 ? order.indexOf(x.type) : order.length;
  };
  const cs = connectedIn(model, end.device, ctx).filter((c) => (end.kind !== 'iface' || c.iface === end.iface) && up(ctx, end.device, c.iface));
  cs.sort((a, b) => a.addr.version - b.addr.version || kind(a.iface) - kind(b.iface) || cmpStr(a.iface, b.iface) || compareAddr(a.addr, b.addr));
  for (const c of cs) {
    const text = formatAddr(c.addr);
    if (!out.some((x) => x.iface === c.iface && x.address === text)) out.push({ device: c.device, iface: c.iface, vrf: c.vrf, address: text, version: c.addr.version });
  }
  return out;
}

/** The effective ends of a trace in words: "pc1:eth0 · 10.0.0.5", and the VRF. */
export function resolvedEnds(t: Trace): { from: string; to: string; vrf: string } | null {
  if (!t.source || !t.dest) return null;
  const s = t.source;
  const d = t.dest;
  return {
    from: `${s.device}${s.iface ? ':' + s.iface : ''}${s.address ? ' · ' + s.address : ' · no address'}`,
    to: d.device ? `${d.device}${d.iface ? ':' + d.iface : ''} · ${d.address}` : `${d.address} (no modeled device has it)`,
    vrf: s.vrf ? 'VRF ' + s.vrf : 'Default table',
  };
}

/** What a path's end says, in words. */
export function endText(e: PathEnd, destText: string): string {
  if (e.kind === 'reached') return `reached ${e.device}${e.iface ? ':' + e.iface : ''}`;
  if (e.kind === 'delivered') return `delivered by ${e.device} into ${e.network ? 'network ' + e.network : 'its connected network'} (no device of the model has ${destText})`;
  if (e.kind === 'exits') return `leaves the model at ${e.device} towards ${e.gateway}`;
  return `stops at ${e.device}: ${e.detail}`;
}

/** Short status of a path end: Reached, Delivered, Leaves the model, Stopped. */
export function endStatus(e: PathEnd): string {
  return e.kind === 'reached' ? 'Reached' : e.kind === 'delivered' ? 'Delivered' : e.kind === 'exits' ? 'Leaves the model' : 'Stopped';
}

/** The refs (as the diagrams mark them) of a path: devices, interfaces, cables, networks, relations, routes. */
export function pathRefs(p: Path): Set<string> {
  const out = new Set<string>();
  const add = (hs: Hop[]): void => {
    for (const h of hs) {
      out.add('device:' + h.device);
      if (h.ingress) out.add(`iface:${h.device}:${h.ingress}`);
      if (h.egress) out.add(`iface:${h.device}:${h.egress}`);
      for (const l of h.links) out.add('link:' + l);
      for (const d of h.l2) out.add('device:' + d);
      for (const r of h.virtual) out.add(r);
      for (const n of h.networks) out.add('network:' + n);
      for (const r of h.relations) out.add('relation:' + r);
      if (h.via.route) out.add(h.via.route);
      if (h.underlay) add(h.underlay.hops);
    }
  };
  add(p.hops);
  return out;
}

/** The refs of a trace: the main path, the equal-cost alternatives (what only they use), and the device where it stops. */
export function traceRefs(t: Trace): { main: Set<string>; alt: Set<string>; stop: string | null } {
  const main = t.paths.length ? pathRefs(t.paths[0]) : new Set<string>();
  // a protocol break's second leg is part of the transfer
  for (const l of t.legs || []) if (l.trace.paths.length) pathRefs(l.trace.paths[0]).forEach((r) => main.add(r));
  const alt = new Set<string>();
  for (const p of t.paths.slice(1)) for (const r of Array.from(pathRefs(p))) if (!main.has(r)) alt.add(r);
  const e = t.paths.length ? t.paths[0].end : null;
  return { main, alt, stop: e && e.kind === 'stopped' ? 'device:' + e.device : null };
}

/** The devices of a path in order: each hop, then the layer-2 devices between it and the next (underlays not included). */
export function pathDevices(p: Path): string[] {
  const out: string[] = [];
  for (const h of p.hops) {
    if (out[out.length - 1] !== h.device) out.push(h.device);
    for (const d of h.l2) if (out[out.length - 1] !== d) out.push(d);
  }
  return out;
}

/** Does the return path cross other routers than the way there (asymmetric routing)? Compares the routers of the main paths. */
export function isAsymmetric(there: Trace, back: Trace): boolean {
  if (!there.paths.length || !back.paths.length || there.paths[0].end.kind !== 'reached' || back.paths[0].end.kind !== 'reached') return false;
  const a = there.paths[0].hops.map((h) => h.device);
  const b = back.paths[0].hops.map((h) => h.device).reverse();
  return a.join('\n') !== b.join('\n');
}

/** One hop as a line of text. */
export function hopLine(h: Hop, n: string): string {
  const parts: string[] = [];
  parts.push(`${n} ${h.device}${h.vrf ? ' [VRF ' + h.vrf + ']' : ''}`);
  if (h.ingress) parts.push(`in ${h.ingress}${h.inAddr ? ' (' + h.inAddr + ')' : ''}`);
  if (h.egress) parts.push(`out ${h.egress}${h.outAddr ? ' (' + h.outAddr + ')' : ''}`);
  if (h.gateway) parts.push(`next hop ${h.gateway}`);
  if (h.via.text) parts.push(h.via.text);
  if (h.encap.length) parts.push('encapsulation: ' + encapText(h.encap));
  if (h.virtual.length) parts.push('inside: ' + h.virtual.filter((r) => r.indexOf('iface:') !== 0).map(virtRefText).join(', '));
  if (h.nat) parts.push(h.nat.toUpperCase());
  if (h.l2.length) parts.push('through ' + h.l2.join(', '));
  if (h.links.length) parts.push('cables ' + h.links.join(', '));
  if (h.ecmp > 1) parts.push(`equal-cost ${h.branch + 1} of ${h.ecmp}`);
  return parts.join(' · ');
}

/** "GRE over IPsec" (the innermost first). */
export function encapText(layers: EncapLayer[]): string {
  return layers.map((l) => l.label).join(' over ');
}

/** The whole trace as plain text (Copy as text). */
export function traceText(t: Trace, back?: Trace | null): string {
  const lines: string[] = [];
  lines.push(`Path trace: ${t.request.from} → ${t.request.to}${t.request.vrf !== undefined ? ' (' + vrfName(t.request.vrf) + ')' : ''}${t.request.service ? ', ' + t.request.service : ''}`);
  if (t.error) {
    lines.push(t.error);
    return lines.join('\n');
  }
  const desc = (tr: Trace): void => {
    if (tr.source && tr.dest) lines.push(`from ${tr.source.device}${tr.source.address ? ' (' + tr.source.address + ')' : ''} in ${vrfName(tr.source.vrf)} to ${tr.dest.address}${tr.dest.device ? ' (' + tr.dest.device + (tr.dest.iface ? ':' + tr.dest.iface : '') + ')' : ''}`);
    tr.paths.forEach((p, i) => {
      lines.push('');
      lines.push(i === 0 ? (tr.paths.length > 1 ? `Main path (1 of ${tr.paths.length} equal-cost paths):` : 'Path:') : `Equal-cost alternative ${i}:`);
      const put = (hs: Hop[], prefix: string, indent: string): void => {
        hs.forEach((h, k) => {
          lines.push(indent + hopLine(h, `${prefix}${k + 1}.`));
          for (const note of h.notes) lines.push(indent + '   note: ' + note);
          if (h.underlay) {
            lines.push(indent + `   underlay (${encapText(h.encap)}):`);
            put(h.underlay.hops, `${prefix}${k + 1}.`, indent + '   ');
          }
        });
      };
      put(p.hops, '', '');
      lines.push(`→ ${endText(p.end, tr.dest ? tr.dest.address : '')}`);
    });
    if (tr.truncated) lines.push(`(only the first ${MAX_PATHS} equal-cost paths are listed)`);
  };
  desc(t);
  for (const l of t.legs || []) {
    lines.push('');
    lines.push(`Leg 2 (protocol break): ${l.trace.request.from} → ${l.trace.request.to}, ${l.trace.request.service || ''}`);
    if (l.trace.error) lines.push(l.trace.error);
    else desc(l.trace);
  }
  if (back) {
    lines.push('');
    lines.push(`Return path: ${back.request.from} → ${back.request.to}${isAsymmetric(t, back) ? ' (asymmetric: it takes another way back)' : ' (the same routers in reverse)'}`);
    if (back.error) lines.push(back.error);
    else desc(back);
  }
  lines.push('');
  lines.push('Model-based approximation: computed from the routes and adjacencies in the model, not a simulation of the protocols. A Security gateway’s policy, a firewall’s policy (the relations through it and its allow list, by the service you give), a VPN gateway’s tunnels and paired ports are considered; router ACLs are not; NAT for container bridges (SNAT out of the host, DNAT to published ports) and the NAT service.');
  return lines.join('\n');
}

/** The VRF choices for a source: its interfaces' and routes' VRFs. */
export function sourceVrfs(model: Model, end: TraceEnd): string[] {
  const dev = end.kind === 'address' ? null : end.device;
  if (!dev) return [];
  const d = model.index.devices.get(dev);
  if (!d) return [];
  const s = new Set<string>();
  for (const i of deviceInterfaces(d)) s.add(vrfKey(i.vrf));
  for (const r of d.routes) s.add(vrfKey(r.vrf));
  return Array.from(s).sort(cmpStr);
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A NAT service translating the walk's source on its way from an inside to an outside interface: said in the hop. */
function natNote(w: Walk, dev: Device, inIface: string, outIface: string, hop: Hop): void {
  const n = dev.appServices ? dev.appServices.get('nat') : undefined;
  if (!n || !w.src) return;
  const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
  if (list(n.values.inside).indexOf(inIface) < 0 || list(n.values.outside).indexOf(outIface) < 0) return;
  const src = w.src;
  const rule = (n.lists.rules || []).find((r) => (r.type === 'pat' || r.type === 'snat') && (r.source === 'any' || (typeof r.source === 'string' && ((p) => !!p && p.version === src.version && inPrefix(p, src))(parsePrefix(r.source, false)))));
  if (!rule) return;
  const to = typeof rule.to === 'string' ? rule.to : hop.outAddr || 'its outside address';
  hop.nat = 'snat';
  hop.notes.push(`${rule.type === 'pat' ? 'PAT' : 'SNAT'}: source ${formatAddr(src)} → ${to} (${dev.id}'s NAT, ${inIface} → ${outIface})`);
}
