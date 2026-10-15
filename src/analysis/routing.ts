/**
 * Routing tables built from the model, and the forwarding decision of one
 * device for one destination. A model-based approximation, not a protocol
 * simulation:
 *
 *   connected  every interface address with a prefix length gives its
 *              device a connected network in the interface's VRF (an
 *              address without one gives a host route). Distance 0.
 *   static     the device's `routes`, in their VRF. A missing distance is
 *              taken as 1 (the usual default for static routes); a missing
 *              metric as 0. A static route is used only while its next hop
 *              resolves (see resolveRoute): a route whose next hop can't be
 *              reached is not installed, so a floating route with a higher
 *              distance takes over.
 *   dynamic    learned over the routing adjacencies of the model (relations
 *              of OSPF, IS-IS, EIGRP, RIP and BGP): every router of a
 *              protocol's adjacencies advertises its connected networks to
 *              the others, and each learns them along the cheapest chain of
 *              adjacencies, with the relation's `cost` (per device:
 *              `cost.<device>`) per adjacency, else 1 (a hop count). The
 *              distance is the protocol's usual default (eBGP 20, EIGRP 90,
 *              OSPF 110, IS-IS 115, RIP 120, iBGP 200) unless the relation
 *              writes `distance`. Nothing is redistributed between
 *              protocols, static routes are not advertised, and no policy,
 *              area or AS-path rule is applied (see dynamicEntries).
 *
 * Selection (lookup): the longest matching prefix among the usable entries
 * of the table; for that prefix the lowest distance, then the lowest
 * metric; every entry left over is used (equal-cost multipath). A next hop
 * is resolved recursively, but never through a default route.
 *
 * Determinism: tables, candidates and next hops are sorted by values
 * (prefix, distance, metric, interface id, address), never by the order of
 * the YAML file.
 *
 * Failures (analysis/failure.ts) plug in through RoutingCtx.up: an interface
 * that is not up has no connected networks and can't be an exit.
 */
import { compareRoutes, routeLine } from '../model/addresses';
import { deviceRoutingRole } from '../model/device-types';
import { IpAddr, IpPrefix, parseAddress, parsePrefix } from '../model/ip';
import { normalizeProtocol, protocolBase } from '../model/protocols';
import { bgpAsn, hasService, routerIdFor } from '../model/services';
import { Model, Relation, Route, deviceInterfaces, relationDevices, routeKey } from '../model/types';
import { addrBig, compareAddr, comparePrefix, formatAddr, inPrefix, networkOf, prefixText } from './ipmath';

/** Distance a static route without `distance` gets in route selection. */
export const DEFAULT_STATIC_DISTANCE = 1;
/** How deep a next hop may resolve through other routes. */
const MAX_RECURSION = 8;

/** The routing table a VRF name selects: '' is the default (global) table. */
export function vrfKey(vrf: string | undefined): string {
  return vrf || '';
}

/** "VRF x", or "the default table". */
export function vrfName(vrf: string): string {
  return vrf ? `VRF ${vrf}` : 'the default table';
}

/**
 * What is up (everything without a failure; see analysis/failure.ts), and
 * which interfaces a lookup must not use (the tunnels a packet is already
 * inside, while their underlay is traced). A context is also the key of the
 * cached dynamic routes: reuse one object for one state.
 */
export interface RoutingCtx {
  up?: (device: string, iface: string) => boolean;
  /** is a relation up (a routing adjacency that is down teaches nothing) */
  relUp?: (id: string) => boolean;
  /** is one direction of a relation's adjacency up (the protocol simulation: OSPF neighbours on a segment form some pairs only) */
  adjUp?: (relation: string, from: string, to: string) => boolean;
  /** is a cable up */
  linkUp?: (id: string) => boolean;
  /** networks a device is connected to besides its configured addresses (the protocol simulation: a DHCP lease) */
  leases?: (device: string) => Connected[];
  /** routes besides the model's (the protocol simulation: a DHCP lease's default route) */
  extraRoutes?: (device: string, vrf: string) => RibEntry[];
}

/** A device's connected networks in a state: its configured ones, and what the state adds (a DHCP lease). */
export function connectedIn(model: Model, device: string, ctx?: RoutingCtx): Connected[] {
  const own = connectedOf(model, device);
  const more = ctx && ctx.leases ? ctx.leases(device) : [];
  return more.length ? own.concat(more) : own;
}

function isUp(ctx: RoutingCtx | undefined, device: string, iface: string): boolean {
  return !ctx || !ctx.up || ctx.up(device, iface);
}

/** A network an interface is directly connected to. */
export interface Connected {
  device: string;
  iface: string;
  vrf: string;
  /** the network (host bits cleared) */
  net: IpPrefix;
  /** the interface's own address in it */
  addr: IpAddr;
  /** the address as written */
  address: string;
}

const connCache = new WeakMap<Model, Map<string, Connected[]>>();

/** The connected networks of a device, sorted by VRF, prefix, interface. */
export function connectedOf(model: Model, device: string): Connected[] {
  let byDev = connCache.get(model);
  if (!byDev) connCache.set(model, (byDev = new Map()));
  const known = byDev.get(device);
  if (known) return known;
  const d = model.index.devices.get(device);
  const out: Connected[] = [];
  if (d) {
    for (const i of deviceInterfaces(d)) {
      for (const address of i.addresses) {
        const p = parsePrefix(address, false);
        if (!p) continue;
        out.push({ device, iface: i.id, vrf: vrfKey(i.vrf), net: networkOf(p), addr: { version: p.version, bytes: p.bytes }, address });
      }
    }
  }
  out.sort((a, b) => cmpStr(a.vrf, b.vrf) || comparePrefix(a.net, b.net) || cmpStr(a.iface, b.iface) || compareAddr(a.addr, b.addr));
  byDev.set(device, out);
  return out;
}

/** The VRF of an interface ('' for the default table). */
export function ifaceVrf(model: Model, device: string, iface: string): string {
  const i = model.index.interfaces.get(device + ':' + iface);
  return i ? vrfKey(i.vrf) : '';
}

/** Is `a` one of the device's own addresses (in any VRF, or in `vrf` when given)? */
export function isOwnAddress(model: Model, device: string, a: IpAddr, vrf?: string): boolean {
  return connectedOf(model, device).some((c) => (vrf === undefined || c.vrf === vrf) && compareAddr(c.addr, a) === 0);
}

/** One entry of a routing table. */
export interface RibEntry {
  kind: 'connected' | 'static' | 'dynamic';
  device: string;
  vrf: string;
  /** the destination network (host bits cleared) */
  net: IpPrefix;
  distance: number;
  metric: number;
  /** connected: the interface; static: the exit interface, when one is written */
  iface?: string;
  /** static: the next-hop address */
  via?: IpAddr;
  blackhole: boolean;
  /** static: the route */
  route?: Route;
  /** dynamic: the base protocol ("ospf", "bgp" …), the adjacency (relation id) it was learned over, and the neighbour */
  protocol?: string;
  relation?: string;
  peer?: string;
}

/** A static route as a table entry (null when its prefix or next hop can't be read). */
export function staticEntry(r: Route): RibEntry | null {
  const p = parsePrefix(r.prefix);
  if (!p) return null;
  const via = r.via !== undefined ? parseAddress(r.via) : null;
  if (r.via !== undefined && !via) return null;
  return {
    kind: 'static',
    device: r.device,
    vrf: vrfKey(r.vrf),
    net: networkOf(p),
    distance: r.distance !== undefined ? r.distance : DEFAULT_STATIC_DISTANCE,
    metric: r.metric !== undefined ? r.metric : 0,
    iface: r.iface,
    via: via || undefined,
    blackhole: r.blackhole,
    route: r,
  };
}

/** Deterministic order of table entries: prefix, distance, metric, kind, then next hop. */
export function compareEntries(a: RibEntry, b: RibEntry): number {
  return (
    comparePrefix(a.net, b.net) ||
    a.distance - b.distance ||
    a.metric - b.metric ||
    cmpStr(a.kind, b.kind) ||
    cmpStr(a.iface || '', b.iface || '') ||
    (a.via && b.via ? compareAddr(a.via, b.via) : a.via ? 1 : b.via ? -1 : 0) ||
    Number(a.blackhole) - Number(b.blackhole) ||
    cmpStr(a.route ? routeText(a.route) : '', b.route ? routeText(b.route) : '') ||
    (a.route && b.route ? a.route.index - b.route.index : 0) ||
    cmpStr(a.relation || '', b.relation || '')
  );
}

/** All entries of a device's table for one VRF (connected, static and dynamic), sorted. */
export function ribOf(model: Model, device: string, vrf: string, ctx?: RoutingCtx): RibEntry[] {
  const out: RibEntry[] = [];
  for (const c of connectedIn(model, device, ctx)) {
    if (c.vrf === vrf) out.push({ kind: 'connected', device, vrf, net: c.net, distance: 0, metric: 0, iface: c.iface, blackhole: false });
  }
  const d = model.index.devices.get(device);
  if (d) {
    for (const r of d.routes) {
      if (vrfKey(r.vrf) !== vrf) continue;
      const e = staticEntry(r);
      if (e) out.push(e);
    }
  }
  for (const e of dynamicEntries(model, device, vrf, ctx)) out.push(e);
  if (ctx && ctx.extraRoutes) for (const e of ctx.extraRoutes(device, vrf)) out.push(e);
  return dedupeConnected(out.sort(compareEntries));
}

/** Two addresses of one interface in the same network give one connected entry. */
function dedupeConnected(es: RibEntry[]): RibEntry[] {
  const out: RibEntry[] = [];
  for (const e of es) {
    const prev = out[out.length - 1];
    if (prev && e.kind === 'connected' && prev.kind === 'connected' && prev.iface === e.iface && comparePrefix(prev.net, e.net) === 0) continue;
    out.push(e);
  }
  return out;
}

/** The VRFs a device has: of its interfaces and of its routes, sorted ('' first). */
export function deviceVrfs(model: Model, device: string): string[] {
  const d = model.index.devices.get(device);
  if (!d) return [];
  const s = new Set<string>();
  for (const i of deviceInterfaces(d)) s.add(vrfKey(i.vrf));
  for (const r of d.routes) s.add(vrfKey(r.vrf));
  return Array.from(s).sort(cmpStr);
}

// ------------------------------------------------------------ next hops

/** Where an entry sends traffic: out of an interface, to a gateway on it (none: to the destination itself). */
export interface NextHop {
  iface: string;
  gateway?: IpAddr;
}

export type Resolution =
  | { ok: true; hops: NextHop[]; recursive: boolean }
  | { ok: false; reason: 'unresolved' | 'loop' | 'blackhole' | 'self' | 'down' | 'too-deep'; detail: string };

/**
 * Resolve the next hop of a table entry:
 *   connected       out of its interface, to the destination itself;
 *   blackhole       nowhere (an error result with reason "blackhole");
 *   exit interface  out of it (to `via` when written, which must then be in
 *                   one of its networks unless it has no address of its own,
 *                   as an unnumbered point-to-point or tunnel interface);
 *   via only        directly connected: out of the interface whose network
 *                   holds it; else recursively, through the route that the
 *                   table would use for `via` (not through the route itself,
 *                   and never through a default route: a next hop that only
 *                   a default route would reach counts as unreachable, so a
 *                   floating route can take over).
 */
export function resolveEntry(model: Model, e: RibEntry, ctx?: RoutingCtx, stack: RibEntry[] = []): Resolution {
  if (e.kind === 'connected') {
    const iface = e.iface as string;
    return isUp(ctx, e.device, iface) ? { ok: true, hops: [{ iface }], recursive: false } : { ok: false, reason: 'down', detail: `${iface} is down` };
  }
  if (e.blackhole) return { ok: false, reason: 'blackhole', detail: 'a blackhole route drops the traffic' };
  if (stack.length >= MAX_RECURSION) return { ok: false, reason: 'too-deep', detail: `the next hop does not resolve within ${MAX_RECURSION} steps` };
  if (stack.indexOf(e) >= 0) return { ok: false, reason: 'loop', detail: 'the next hop resolves through itself' };
  const conn = connectedIn(model, e.device, ctx).filter((c) => c.vrf === e.vrf);
  if (e.via && conn.some((c) => compareAddr(c.addr, e.via as IpAddr) === 0)) {
    return { ok: false, reason: 'self', detail: `${formatAddr(e.via)} is an address of ${e.device} itself` };
  }
  if (e.iface !== undefined) {
    const iface = e.iface;
    if (!isUp(ctx, e.device, iface)) return { ok: false, reason: 'down', detail: `exit interface ${iface} is down` };
    if (!e.via) return { ok: true, hops: [{ iface }], recursive: false };
    const own = connectedIn(model, e.device, ctx).filter((c) => c.iface === iface);
    if (own.length && !own.some((c) => inPrefix(c.net, e.via as IpAddr))) {
      return { ok: false, reason: 'unresolved', detail: `${formatAddr(e.via)} is not in a network of ${iface} (${own.map((c) => prefixText(c.net)).join(', ')})` };
    }
    return { ok: true, hops: [{ iface, gateway: e.via }], recursive: false };
  }
  const via = e.via as IpAddr;
  // directly connected: the longest connected network holding the next hop (an interface that is down gives none)
  const direct = conn.filter((c) => inPrefix(c.net, via) && isUp(ctx, e.device, c.iface));
  if (direct.length) {
    const best = Math.max(...direct.map((c) => c.net.prefix));
    const ifaces = Array.from(new Set(direct.filter((c) => c.net.prefix === best).map((c) => c.iface))).sort(cmpStr);
    return { ok: true, hops: ifaces.map((iface) => ({ iface, gateway: via })), recursive: false };
  }
  // recursively: through the route the table would use for the next hop, never this route itself
  const d = lookupWith(model, e.device, e.vrf, via, ctx, stack.concat(e));
  if (d.kind === 'forward') return { ok: true, hops: d.hops.map((h) => ({ iface: h.iface, gateway: h.gateway || via })), recursive: true };
  if (d.kind === 'local') return { ok: false, reason: 'self', detail: `${formatAddr(via)} is an address of ${e.device} itself` };
  if (d.kind === 'blackhole') return { ok: false, reason: 'blackhole', detail: `the next hop ${formatAddr(via)} resolves to a blackhole route` };
  return { ok: false, reason: 'unresolved', detail: `no route to the next hop ${formatAddr(via)} in ${vrfName(e.vrf)}` };
}

/** Resolve a route of the model (its next hop; see resolveEntry). */
export function resolveRoute(model: Model, r: Route, ctx?: RoutingCtx): Resolution {
  const e = staticEntry(r);
  if (!e) return { ok: false, reason: 'unresolved', detail: 'the route cannot be read' };
  return resolveEntry(model, e, ctx);
}

// ------------------------------------------------------------- decisions

export interface DecisionHop extends NextHop {
  /** the table entry that gives this hop */
  entry: RibEntry;
}

/** What a device does with traffic to one destination. */
export interface Decision {
  /**
   * forward: out of `hops` (several: equal-cost multipath);
   * local: the destination is an address of the device itself;
   * blackhole: the selected route drops it;
   * none: no usable route.
   */
  kind: 'forward' | 'local' | 'blackhole' | 'none';
  /** the selected entries (empty for local and none) */
  entries: RibEntry[];
  hops: DecisionHop[];
  /** entries that would match but are not usable, with the reason (for explanations) */
  unusable: Array<{ entry: RibEntry; detail: string }>;
}

/** The forwarding decision of `device` in `vrf` for `dest`. */
export function lookup(model: Model, device: string, vrf: string, dest: IpAddr, ctx?: RoutingCtx): Decision {
  return lookupWith(model, device, vrf, dest, ctx, []);
}

function lookupWith(model: Model, device: string, vrf: string, dest: IpAddr, ctx: RoutingCtx | undefined, stack: RibEntry[]): Decision {
  const none: Decision = { kind: 'none', entries: [], hops: [], unusable: [] };
  if (connectedIn(model, device, ctx).some((c) => c.vrf === vrf && compareAddr(c.addr, dest) === 0 && isUp(ctx, device, c.iface))) {
    return { kind: 'local', entries: [], hops: [], unusable: [] };
  }
  // resolving a next hop (stack not empty): default routes don't count
  const matching = ribOf(model, device, vrf, ctx).filter((e) => inPrefix(e.net, dest) && (!stack.length || e.net.prefix > 0));
  // longest prefix first; within one prefix by distance and metric (the table's order)
  const byLen = matching.slice().sort((a, b) => b.net.prefix - a.net.prefix || compareEntries(a, b));
  const unusable: Array<{ entry: RibEntry; detail: string }> = [];
  let i = 0;
  while (i < byLen.length) {
    const len = byLen[i].net.prefix;
    const group: RibEntry[] = [];
    while (i < byLen.length && byLen[i].net.prefix === len) group.push(byLen[i++]);
    // usable entries of this prefix: blackholes always, others while their next hop resolves
    const usable: Array<{ e: RibEntry; res: Resolution | null }> = [];
    for (const e of group) {
      if (e.blackhole) {
        usable.push({ e, res: null });
        continue;
      }
      const res = resolveEntry(model, e, ctx, stack);
      if (res.ok) usable.push({ e, res });
      else unusable.push({ entry: e, detail: res.detail });
    }
    if (!usable.length) continue;
    const bestD = Math.min(...usable.map((u) => u.e.distance));
    const atD = usable.filter((u) => u.e.distance === bestD);
    const bestM = Math.min(...atD.map((u) => u.e.metric));
    const chosen = atD.filter((u) => u.e.metric === bestM);
    // a blackhole among the best drops the traffic (a black hole can't share a destination)
    if (chosen.some((u) => u.e.blackhole)) return { kind: 'blackhole', entries: chosen.filter((u) => u.e.blackhole).map((u) => u.e), hops: [], unusable };
    const hops: DecisionHop[] = [];
    for (const u of chosen) {
      for (const h of (u.res as { ok: true; hops: NextHop[] }).hops) {
        if (!hops.some((x) => x.iface === h.iface && sameAddr(x.gateway, h.gateway))) hops.push({ ...h, entry: u.e });
      }
    }
    hops.sort((a, b) => cmpStr(a.iface, b.iface) || (a.gateway && b.gateway ? compareAddr(a.gateway, b.gateway) : a.gateway ? 1 : b.gateway ? -1 : 0));
    return { kind: 'forward', entries: chosen.map((u) => u.e), hops, unusable };
  }
  return { ...none, unusable };
}

function sameAddr(a: IpAddr | undefined, b: IpAddr | undefined): boolean {
  return a === b || (!!a && !!b && compareAddr(a, b) === 0);
}

// --------------------------------------------------------- dynamic routes

function lookupProtocolLabel(model: Model, id: string): string {
  const s = model.services.get(id);
  return s ? s.label : id;
}

/** The protocols whose relations are routing adjacencies (base protocol ids). */
export const ROUTING_PROTOCOLS: readonly string[] = ['bgp', 'eigrp', 'isis', 'ospf', 'rip'];

const IGP_DISTANCE: { [p: string]: number } = { eigrp: 90, ospf: 110, isis: 115, rip: 120 };
const EBGP_DISTANCE = 20;
const IBGP_DISTANCE = 200;

/** The value of a protocol parameter for one endpoint device: `key.<device>`, else the single `key` (undefined when neither). */
export function relParam(r: Relation, key: string, device: string): string | undefined {
  const own = r.attrs.find(([k]) => k === key + '.' + device);
  if (own) return own[1];
  const one = r.attrs.find(([k]) => k === key);
  return one ? one[1] : undefined;
}

/** The routing protocol of a relation ("ospf", "bgp" …), or null when it is not one. */
export function routingProtocol(model: Model, r: Relation): string | null {
  const base = protocolBase(model.protocols, r.protocol);
  return ROUTING_PROTOCOLS.indexOf(base) >= 0 ? base : null;
}

/** One direction of a routing adjacency: what `from` learns from `to` and how it reaches it. */
export interface Adjacency {
  relation: string;
  protocol: string;
  from: string;
  to: string;
  /** the VRF of each side ('' the default table) */
  fromVrf: string;
  toVrf: string;
  /** the interface of `from` towards the neighbour (none: a BGP session to an address that is not on a shared network, resolved through the table) */
  iface?: string;
  /** the neighbour's address the routes point to, and its interface */
  via: IpAddr;
  peerIface: string;
  cost: number;
  distance: number;
}

/** An adjacency of the model that can't form: the two have no network in common (or an interface is down). */
export interface MissingAdjacency {
  relation: string;
  protocol: string;
  from: string;
  to: string;
  detail: string;
}

interface DynState {
  adjacencies: Adjacency[];
  missing: MissingAdjacency[];
  /** "device\0vrf" -> entries */
  entries: Map<string, RibEntry[]>;
}

const NO_CTX: RoutingCtx = {};
const dynCache = new WeakMap<Model, WeakMap<RoutingCtx, DynState>>();

function dynState(model: Model, ctx: RoutingCtx | undefined): DynState {
  let byCtx = dynCache.get(model);
  if (!byCtx) dynCache.set(model, (byCtx = new WeakMap()));
  const key = ctx || NO_CTX;
  let st = byCtx.get(key);
  if (!st) byCtx.set(key, (st = computeDynamic(model, ctx)));
  return st;
}

/** The routing adjacencies of the model (one per direction) and those that can't form, sorted. */
export function routingAdjacencies(model: Model, ctx?: RoutingCtx): { adjacencies: Adjacency[]; missing: MissingAdjacency[] } {
  const st = dynState(model, ctx);
  return { adjacencies: st.adjacencies, missing: st.missing };
}

/** The routes a device learns over its adjacencies in one VRF (see the module comment), sorted. */
export function dynamicEntries(model: Model, device: string, vrf: string, ctx?: RoutingCtx): RibEntry[] {
  return dynState(model, ctx).entries.get(device + '\0' + vrf) || [];
}

/** How `from` reaches its neighbour `to` over a relation; a string says why it can't. */
function adjacencyHop(model: Model, r: Relation, protocol: string, from: string, to: string, ctx: RoutingCtx | undefined): Adjacency | string {
  const ifacesOf = (dev: string): string[] | null => {
    const eps = r.endpoints.filter((e) => e.device === dev);
    if (eps.some((e) => e.iface === undefined)) return null;
    return eps.map((e) => e.iface as string).sort(cmpStr);
  };
  const aIfs = ifacesOf(from);
  const bIfs = ifacesOf(to);
  const overNets: IpPrefix[] = [];
  for (const o of r.over) {
    const n = model.index.networks.get(o);
    const p = n && n.cidr ? parsePrefix(n.cidr) : null;
    if (p) overNets.push(networkOf(p));
  }
  const cost = positiveInt(relParam(r, 'cost', from), 1, 16777215);
  const fa = model.index.devices.get(from);
  const fb = model.index.devices.get(to);
  const ownDistance = positiveInt(relParam(r, 'distance', from), 0, 255);
  // iBGP or eBGP: from the two devices' local AS numbers (an ibgp / ebgp relation says so itself)
  const asA = bgpAsn(fa);
  const asB = bgpAsn(fb);
  const ibgp = normalizeProtocol(r.protocol) === 'ibgp' || (normalizeProtocol(r.protocol) !== 'ebgp' && asA !== undefined && asA === asB);
  const distance = ownDistance || (protocol === 'bgp' ? (ibgp ? IBGP_DISTANCE : EBGP_DISTANCE) : IGP_DISTANCE[protocol]);
  // a network both are connected to (in the relation's `over` first, then the longest prefix)
  type Cand = { a: Connected; b: Connected; over: boolean };
  const cands: Cand[] = [];
  let down = false;
  for (const a of connectedOf(model, from)) {
    if (aIfs && aIfs.indexOf(a.iface) < 0) continue;
    for (const b of connectedOf(model, to)) {
      if (bIfs && bIfs.indexOf(b.iface) < 0) continue;
      if (!inPrefix(a.net, b.addr) || !inPrefix(b.net, a.addr)) continue;
      if (!isUp(ctx, from, a.iface) || !isUp(ctx, to, b.iface)) {
        down = true;
        continue;
      }
      cands.push({ a, b, over: overNets.some((p) => comparePrefix(p, a.net) === 0) });
    }
  }
  cands.sort((x, y) => Number(y.over) - Number(x.over) || y.a.net.prefix - x.a.net.prefix || cmpStr(x.a.iface, y.a.iface) || cmpStr(x.b.iface, y.b.iface) || compareAddr(x.b.addr, y.b.addr));
  if (cands.length) {
    const c = cands[0];
    return { relation: r.id, protocol, from, to, fromVrf: c.a.vrf, toVrf: c.b.vrf, iface: c.a.iface, via: c.b.addr, peerIface: c.b.iface, cost, distance };
  }
  // BGP may peer between addresses that are not on a shared network (loopbacks): the session's next hop resolves through the table
  if (protocol === 'bgp') {
    const peer = bgpPeerAddress(model, to, bIfs, ctx);
    if (peer) {
      const fromVrf = aIfs && aIfs.length ? ifaceVrf(model, from, aIfs[0]) : '';
      return { relation: r.id, protocol, from, to, fromVrf, toVrf: peer.vrf, via: peer.addr, peerIface: peer.iface, cost, distance };
    }
  }
  if (down) return `an interface between ${from} and ${to} is down`;
  const where = (dev: string, ifs: string[] | null): string => (ifs ? ifs.map((i) => dev + ':' + i).join(', ') : dev);
  return `${where(from, aIfs)} and ${where(to, bIfs)} have no network in common`;
}

/** The address a BGP session to `device` is made to: its endpoint interface's address, else its BGP router ID or first loopback address. */
function bgpPeerAddress(model: Model, device: string, ifaces: string[] | null, ctx: RoutingCtx | undefined): Connected | null {
  const conn = connectedOf(model, device).filter((c) => isUp(ctx, device, c.iface));
  if (ifaces) return conn.find((c) => ifaces.indexOf(c.iface) >= 0) || null;
  const d = model.index.devices.get(device);
  const own = routerIdFor(d, 'bgp');
  const rid = own && own.address ? parseAddress(own.address) : null;
  const byRid = rid ? conn.find((c) => compareAddr(c.addr, rid) === 0) : undefined;
  if (byRid) return byRid;
  const loop = conn.find((c) => {
    const i = model.index.interfaces.get(device + ':' + c.iface);
    return !!i && i.type === 'loopback';
  });
  return loop || null;
}

function positiveInt(v: string | undefined, dflt: number, max: number): number {
  if (v === undefined || !/^\s*[0-9]+\s*$/.test(v)) return dflt;
  const n = Number(v);
  return n >= 1 && n <= max ? n : dflt;
}

function computeDynamic(model: Model, ctx: RoutingCtx | undefined): DynState {
  const adjacencies: Adjacency[] = [];
  const missing: MissingAdjacency[] = [];
  const rels = model.relations.slice().sort((a, b) => cmpStr(a.id, b.id));
  for (const r of rels) {
    const protocol = routingProtocol(model, r);
    if (!protocol) continue;
    if (ctx && ctx.relUp && !ctx.relUp(r.id)) continue;
    const devs = relationDevices(r).slice().sort(cmpStr);
    for (const from of devs) {
      for (const to of devs) {
        if (from === to) continue;
        if (ctx && ctx.adjUp && !ctx.adjUp(r.id, from, to)) continue;
        // only devices that enable the protocol (their protocols:) take part in its adjacencies
        const off = [from, to].filter((d) => !hasService(model, d, protocol));
        if (off.length) {
          missing.push({ relation: r.id, protocol, from, to, detail: `${lookupProtocolLabel(model, protocol)} is not enabled on ${off.join(' and ')}` });
          continue;
        }
        const a = adjacencyHop(model, r, protocol, from, to, ctx);
        if (typeof a === 'string') missing.push({ relation: r.id, protocol, from, to, detail: a });
        else adjacencies.push(a);
      }
    }
  }
  // per protocol: the cheapest chains of adjacencies between (device, VRF) nodes
  const entries = new Map<string, RibEntry[]>();
  const node = (dev: string, vrf: string): string => dev + '\0' + vrf;
  for (const protocol of ROUTING_PROTOCOLS) {
    const adj = adjacencies.filter((a) => a.protocol === protocol);
    if (!adj.length) continue;
    const out = new Map<string, Adjacency[]>();
    for (const a of adj) {
      const k = node(a.from, a.fromVrf);
      if (!out.has(k)) out.set(k, []);
      (out.get(k) as Adjacency[]).push(a);
    }
    const nodes = Array.from(new Set(adj.map((a) => node(a.from, a.fromVrf)).concat(adj.map((a) => node(a.to, a.toVrf))))).sort(cmpStr);
    for (const src of nodes) {
      // Dijkstra with the set of first adjacencies of every cheapest chain
      const dist = new Map<string, number>([[src, 0]]);
      const first = new Map<string, Adjacency[]>([[src, []]]);
      const done = new Set<string>();
      for (;;) {
        let cur: string | null = null;
        for (const n of nodes) if (!done.has(n) && dist.has(n) && (cur === null || (dist.get(n) as number) < (dist.get(cur) as number))) cur = n;
        if (cur === null) break;
        done.add(cur);
        const dc = dist.get(cur) as number;
        for (const a of out.get(cur) || []) {
          const t = node(a.to, a.toVrf);
          const nd = dc + a.cost;
          const fh = cur === src ? [a] : (first.get(cur) as Adjacency[]);
          const known = dist.get(t);
          if (known === undefined || nd < known) {
            dist.set(t, nd);
            first.set(t, fh.slice());
          } else if (nd === known && !done.has(t)) {
            const list = first.get(t) as Adjacency[];
            for (const x of fh) if (list.indexOf(x) < 0) list.push(x);
          }
        }
      }
      const [srcDev, srcVrf] = src.split('\0');
      const ownNets = connectedOf(model, srcDev).filter((c) => c.vrf === srcVrf);
      // every network a reached router is connected to: the lowest cost, and the first adjacencies of all chains at that cost
      const best = new Map<string, { net: IpPrefix; metric: number; via: Adjacency[] }>();
      for (const t of nodes) {
        if (t === src || !dist.has(t)) continue;
        const [dev, vrf] = t.split('\0');
        const m = dist.get(t) as number;
        for (const c of connectedOf(model, dev)) {
          if (c.vrf !== vrf || !isUp(ctx, dev, c.iface)) continue;
          if (ownNets.some((o) => comparePrefix(o.net, c.net) === 0)) continue;
          const k = prefixText(c.net);
          const b = best.get(k);
          if (!b || m < b.metric) best.set(k, { net: c.net, metric: m, via: (first.get(t) as Adjacency[]).slice() });
          else if (m === b.metric) for (const x of first.get(t) as Adjacency[]) if (b.via.indexOf(x) < 0) b.via.push(x);
        }
      }
      const list = entries.get(src) || [];
      for (const b of Array.from(best.values())) {
        for (const a of b.via) {
          list.push({ kind: 'dynamic', device: srcDev, vrf: srcVrf, net: b.net, distance: a.distance, metric: b.metric, iface: a.iface, via: a.via, blackhole: false, protocol, relation: a.relation, peer: a.to });
        }
      }
      entries.set(src, list.sort(compareEntries));
    }
  }
  return { adjacencies, missing, entries };
}

// ------------------------------------------------------------ route text

/** A route as the diagram and the lists write it (model/addresses.ts routeLine). */
export const routeText = routeLine;

/** The ref of a route ("route:<device>:<index>"). */
export function routeRef(r: Route): string {
  return 'route:' + routeKey(r.device, r.index);
}

/** May a device of this type carry routes, and does it forward traffic for others? */
export function canRoute(model: Model, device: string): boolean {
  const d = model.index.devices.get(device);
  return !!d && deviceRoutingRole(d) !== null;
}

export function forwards(model: Model, device: string): boolean {
  const d = model.index.devices.get(device);
  return !!d && deviceRoutingRole(d) === 'router';
}

/** Routes of a device in display order (model/addresses.ts compareRoutes): never file order. */
export function sortedRoutes(model: Model, device: string): Route[] {
  const d = model.index.devices.get(device);
  return d ? d.routes.slice().sort(compareRoutes) : [];
}

/** Integer key of an address, for sets and maps. */
export function addrId(a: IpAddr): string {
  return a.version + ':' + addrBig(a).toString(16);
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Where the diagram's next-hop line of a route leads: an interface (or a device as a whole) of another device. */
export interface NextHopTarget {
  device: string;
  iface?: string;
}

/**
 * The resolved next hop of a route, as the diagram points at it: the
 * interfaces of other devices that have the next-hop address; when no
 * interface has it, the owners of the gateway it resolves to; for a route
 * with only an exit interface, the far end of that interface: the peer
 * port of its cable, or a tunnel's destination. A blackhole route and a
 * next hop outside the model point nowhere. Sorted by device and interface.
 */
export function nextHopTargets(model: Model, r: Route): NextHopTarget[] {
  if (r.blackhole) return [];
  const out: NextHopTarget[] = [];
  const add = (device: string, iface?: string): void => {
    if (device === r.device || out.some((t) => t.device === device && t.iface === iface)) return;
    out.push(iface === undefined ? { device } : { device, iface });
  };
  const owners = (a: IpAddr): void => {
    for (const c of model.devices) {
      if (c.id === r.device) continue;
      for (const k of connectedOf(model, c.id)) if (compareAddr(k.addr, a) === 0) add(c.id, k.iface);
    }
  };
  if (r.via !== undefined) {
    const via = parseAddress(r.via);
    if (via) owners(via);
    if (!out.length) {
      const res = resolveRoute(model, r);
      if (res.ok) for (const h of res.hops) if (h.gateway) owners(h.gateway);
    }
  } else if (r.iface !== undefined) {
    const i = model.index.interfaces.get(r.device + ':' + r.iface);
    const lid = model.index.ifaceLink.get(r.device + ':' + r.iface);
    const l = lid ? model.index.links.get(lid) : undefined;
    if (l) {
      const far = l.a.device === r.device && l.a.iface === r.iface ? l.b : l.a;
      add(far.device, far.iface);
    } else if (i && i.destination && i.destination.device) add(i.destination.device, i.destination.iface);
  }
  return out.sort((a, b) => cmpStr(a.device, b.device) || cmpStr(a.iface || '', b.iface || ''));
}

/** An address a route of a device could use as its next hop: another device's address in a network the device is connected to. */
export interface NextHopCandidate {
  address: string;
  device: string;
  iface: string;
  /** the interface of the route's device that is connected to it */
  via: string;
}

/**
 * Next hops a device can reach directly in one VRF: the addresses of other
 * devices' interfaces inside a network one of its own interfaces in that
 * VRF is connected to. Sorted by address. (Suggestions for the editor.)
 */
export function nextHopCandidates(model: Model, device: string, vrf: string): NextHopCandidate[] {
  const own = connectedOf(model, device).filter((c) => c.vrf === vrf);
  const out: Array<NextHopCandidate & { a: IpAddr }> = [];
  for (const d of model.devices) {
    if (d.id === device) continue;
    for (const c of connectedOf(model, d.id)) {
      const mine = own.find((o) => inPrefix(o.net, c.addr));
      if (!mine || out.some((x) => compareAddr(x.a, c.addr) === 0)) continue;
      out.push({ address: formatAddr(c.addr), device: d.id, iface: c.iface, via: mine.iface, a: c.addr });
    }
  }
  return out.sort((p, q) => compareAddr(p.a, q.a)).map(({ address, device: dv, iface, via }) => ({ address, device: dv, iface, via }));
}
