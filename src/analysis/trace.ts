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
import { deviceRoutingRole, isLayer2Switch } from '../model/device-types';
import { IpAddr, IpPrefix, parseAddress, parsePrefix } from '../model/ip';
import { lookupProtocol } from '../model/protocols';
import { Interface, Link, LinkEnd, Model, Relation, deviceInterfaces, ifaceKey } from '../model/types';
import { endL2, interfaceVlanPorts, interfaceVlans, isBridgePort } from '../model/derive';
import { compareAddr, comparePrefix, formatAddr, inPrefix, networkOf, prefixText } from './ipmath';
import { virtualGateways } from './identity';
import { sharedDomain, virtEnd, virtRefText } from './trace-virtual';
import { cnetNetworkId, cnetRef, vethNetwork } from '../model/virtual';
import {
  Connected,
  Decision,
  DecisionHop,
  RibEntry,
  RoutingCtx,
  connectedOf,
  ifaceVrf,
  lookup,
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
const L2_TYPES = ['switch', 'ap', 'ids_ips', 'cloud', 'generic'];

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

export type StopReason = 'no-route' | 'unresolved' | 'no-adjacency' | 'blackhole' | 'loop' | 'not-forwarding' | 'down' | 'too-long';

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
}

export interface Path {
  hops: Hop[];
  end: PathEnd;
}

export interface TraceRequest {
  from: string;
  to: string;
  /** the VRF of the source's table ('' the default table); none: the source interface's VRF, else the default table */
  vrf?: string;
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
  // where it starts
  let srcDev: string;
  let srcIface: string | undefined;
  let srcAddr: IpAddr | undefined;
  if (src.kind === 'address') {
    const a = parseAddress(src.address) as IpAddr;
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
  const srcFamilies = familiesOf(model, srcDev, srcIface);
  if (dst.kind === 'address') {
    destAddr = parseAddress(dst.address);
    const owners = destAddr ? holders(model, destAddr, ctx, null) : [];
    if (owners.length) {
      destDev = owners[0].device;
      destIface = owners[0].iface;
    }
  } else {
    destDev = dst.device;
    destIface = dst.kind === 'iface' ? dst.iface : undefined;
    const c = pickAddress(model, dst.device, destIface, srcFamilies, undefined, ctx);
    if (!c) return { ...out, error: `Destination: ${traceEndText(dst)} has no address to trace to` };
    destAddr = c.addr;
    destIface = c.iface;
  }
  if (!destAddr) return { ...out, error: 'Destination: not an address' };
  const vrf = vrfGiven !== undefined ? vrfGiven : srcIface !== undefined ? ifaceVrf(model, srcDev, srcIface) : '';
  if (!srcAddr) {
    const c = srcIface !== undefined ? connectedOf(model, srcDev).find((x) => x.iface === srcIface && x.addr.version === (destAddr as IpAddr).version) : pickAddress(model, srcDev, undefined, [(destAddr as IpAddr).version], vrf, ctx);
    if (c) srcAddr = c.addr;
  }
  out.source = { device: srcDev, vrf };
  if (srcIface !== undefined) out.source.iface = srcIface;
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
  if (dnat) w.dnat = dnat;
  out.paths = walk(w, { device: srcDev, vrf }, [], new Set());
  out.truncated = w.truncated;
  return out;
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
    return [{ hops: before.concat(hop), end: { kind: 'stopped', device: at.device, reason, detail } }];
  };
  const key = at.device + '\0' + at.vrf;
  if (seen.has(key)) return stop('loop', `the path comes back to ${at.device} (${vrfName(at.vrf)}): a routing loop`);
  if (before.length >= MAX_HOPS) return stop('too-long', `more than ${MAX_HOPS} hops`);
  const d = model.index.devices.get(at.device);
  if (!d) return stop('unresolved', `${at.device} is not in the model`);
  const decision: Decision = lookup(model, at.device, at.vrf, w.dest, w.ctx);
  if (decision.kind === 'local' && w.dnat && w.dnat.host === at.device) return dnatHops(w, hop, before);
  if (decision.kind === 'local') {
    const own = connectedOf(model, at.device).find((c) => compareAddr(c.addr, w.dest) === 0);
    hop.via = { kind: 'local', text: `${w.destText} is an address of ${at.device}${own ? ' (' + own.iface + ')' : ''}` };
    return [{ hops: before.concat(hop), end: own ? { kind: 'reached', device: at.device, iface: own.iface } : { kind: 'reached', device: at.device } }];
  }
  // only routers pass traffic on (the first hop sends its own)
  // (a container host forwards the traffic of its bridge networks: it came in on the bridge's interface)
  if (before.length > 0 && deviceRoutingRole(d) !== 'router' && !fromBridge(model, at)) {
    const what = d.type === 'generic' ? 'device without a type' : isLayer2Switch(d) ? 'Layer 2 switch' : d.type;
    return stop('not-forwarding', `${at.device} is a ${what} and does not forward traffic for others`);
  }
  if (decision.kind === 'blackhole') {
    const e = decision.entries[0];
    hop.via = viaOf(model, e);
    hop.via.kind = 'blackhole';
    return [{ hops: before.concat(hop), end: { kind: 'stopped', device: at.device, reason: 'blackhole', detail: `${hop.via.text} drops the traffic (a black hole)` } }];
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
  const target = h.gateway || w.dest;
  if (h.gateway) hop.gateway = formatAddr(h.gateway);
  const conn = connectedOf(model, at.device).filter((c) => c.iface === h.iface);
  const outNet = conn.filter((c) => inPrefix(c.net, target)).sort((a, b) => b.net.prefix - a.net.prefix)[0] || conn[0];
  if (outNet) hop.outAddr = outNet.address.replace(/\/[0-9]+$/, '');
  if (outNet) for (const n of networksOf(model, outNet.net)) hop.networks.push(n);
  const iface = model.index.interfaces.get(ifaceKey(at.device, h.iface));
  // from a container bridge with NAT out of another interface: the host's address becomes the source
  const snat = natBridgeIn(model, at);
  if (snat && h.iface !== at.ingress && hop.outAddr) {
    hop.nat = 'snat';
    hop.notes.push(`SNAT: source ${w.srcText || 'address'} → ${hop.outAddr} (${devLabel(model, at.device)} masquerades the network ${snat})`);
  }
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
    if (t.stop) return [{ hops: before.concat(hop), end: { kind: 'stopped', device: at.device, reason: t.stop.reason, detail: t.stop.detail } }];
  } else {
    const vlan = outNet ? vlanOfNet(model, outNet.net) : undefined;
    const seg = l2Segment(model, w.ctx, { device: at.device, iface: h.iface }, { device: next.device, iface: next.iface }, vlan);
    if (seg.kind === 'none') return [{ hops: before.concat(hop), end: { kind: 'stopped', device: at.device, reason: 'no-adjacency', detail: seg.detail } }];
    if (seg.kind === 'uncabled') hop.notes.push(seg.detail);
    else {
      hop.links = seg.links;
      hop.l2 = seg.devices;
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
    return { kind: 'dynamic', text: `${p} route ${prefixText(e.net)} over ${e.relation} (cost ${e.metric}, distance ${e.distance})`, relation: e.relation };
  }
  const r = e.route;
  if (!r && e.implicit) return { kind: 'static', text: e.implicit };
  return r ? { kind: 'static', text: `static route ${routeText(r)}`, route: routeRef(r) } : { kind: 'static', text: `static route ${prefixText(e.net)}` };
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
    for (const c of connectedOf(model, d.id)) {
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
function familiesOf(model: Model, device: string, iface: string | undefined): Array<4 | 6> {
  const fams: Array<4 | 6> = [];
  for (const c of connectedOf(model, device)) if ((iface === undefined || c.iface === iface) && fams.indexOf(c.addr.version) < 0) fams.push(c.addr.version);
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
  const cands = connectedOf(model, device).filter((c) => (iface === undefined || c.iface === iface) && (vrf === undefined || c.vrf === vrf) && (iface !== undefined || !ctx || up(ctx, device, c.iface)));
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

type Segment = ({ kind: 'ok'; links: string[]; devices: string[] } | { kind: 'uncabled'; detail: string } | { kind: 'none'; detail: string }) & { virtual?: string[]; notes?: string[] };

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
function l2Segment(model: Model, ctx: RoutingCtx, a: { device: string; iface: string }, b: { device: string; iface: string }, vlan: number | undefined): Segment {
  const upf = (d: string, i: string): boolean => up(ctx, d, i);
  const va = virtEnd(model, a.device, a.iface, upf, 0, ctx.hostOf);
  const vb = virtEnd(model, b.device, b.iface, upf, 0, ctx.hostOf);
  const pa = va ? va.ports : portsOf(model, a.device, a.iface);
  const pb = vb ? vb.ports : portsOf(model, b.device, b.iface);
  if (!va && !vb) return cabled(model, ctx, a, b, vlan, a.device, pa, b.device, pb, true);
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
  const seg = cabled(model, ctx, a, b, vlan, va ? va.device : a.device, pa, vb ? vb.device : b.device, pb, false);
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
  while (queue.length) {
    const s = queue.shift() as L2State;
    const dev = model.index.devices.get(s.device);
    if (!dev || L2_TYPES.indexOf(dev.type) < 0) continue;
    const inEnd = s.via ? (s.via.a.device === s.device ? s.via.a : s.via.b) : null;
    for (const l of links) {
      if (l === s.via || !linkUp(l)) continue;
      const near = l.a.device === s.device ? l.a : l.b.device === s.device ? l.b : null;
      if (!near) continue;
      const far = near === l.a ? l.b : l.a;
      if (l.direction === 'unidirectional' && near !== l.a) continue;
      if (!carries(model, near, vlan) || !carries(model, far, vlan) || (inEnd && near.iface !== undefined && inEnd.iface === near.iface)) continue;
      const next: L2State = { device: far.device, via: l, prev: s };
      if (atB(far)) return finish(model, ctx, next);
      if (seenDev.has(far.device)) continue;
      seenDev.add(far.device);
      queue.push(next);
    }
  }
  return { kind: 'none', detail: `no cable path from ${a.device}:${a.iface} to ${b.device}:${b.iface}${vtext} in the model (missing layer-2 adjacency)` };
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
  lines.push(`Path trace: ${t.request.from} → ${t.request.to}${t.request.vrf !== undefined ? ' (' + vrfName(t.request.vrf) + ')' : ''}`);
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
  if (back) {
    lines.push('');
    lines.push(`Return path: ${back.request.from} → ${back.request.to}${isAsymmetric(t, back) ? ' (asymmetric: it takes another way back)' : ' (the same routers in reverse)'}`);
    if (back.error) lines.push(back.error);
    else desc(back);
  }
  lines.push('');
  lines.push('Model-based approximation: computed from the routes and adjacencies in the model, not a simulation of the protocols. ACLs and firewall policies are not considered; NAT only for container bridges (SNAT out of the host, DNAT to published ports).');
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
