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
 *              protocol's adjacencies originates its connected networks
 *              (or, with a policy, what it advertises, a default route and
 *              what it redistributes: model/routing-policy.ts), and the
 *              routes propagate from neighbour to neighbour through the
 *              filters (export, then import), each router keeping the best: the
 *              cheapest chain of adjacencies, with the relation's `cost`
 *              (per device: `cost.<device>`) per adjacency, else 1 (a hop
 *              count); for BGP first the highest local preference and the
 *              shortest AS path (a route with the receiver's AS in its path
 *              is refused). The distance is the protocol's usual default
 *              (eBGP 20, EIGRP 90, OSPF 110, IS-IS 115, RIP 120, iBGP 200)
 *              unless the relation writes `distance`. Without a policy,
 *              static routes are not advertised and nothing is
 *              redistributed; areas, route maps beyond the policy subset,
 *              communities and route reflection are not applied (see
 *              dynamicEntries). The simulation installs the same routes
 *              over the adjacencies that are up (RoutingCtx.adjUp).
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
import { deviceRoutingRole } from '../model/capabilities';
import { IpAddr, IpPrefix, parseAddress, parsePrefix } from '../model/ip';
import { normalizeProtocol, protocolBase } from '../model/protocols';
import { bgpAsn, hasService, routerIdFor } from '../model/services';
import { Device, Interface, Model, Relation, Route, deviceInterfaces, relationDevices, routeKey } from '../model/types';
import { addrBig, compareAddr, comparePrefix, formatAddr, inPrefix, networkOf, prefixText } from './ipmath';
import { vethNetwork, isContainer } from '../model/virtual';
import { DEFAULT_LOCAL_PREF, LINK_STATE, RoutingPolicy, filterRoute } from '../model/routing-policy';

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
  /** the host a VM runs on now, when it is not its own (restarted elsewhere by its HA cluster) */
  hostOf?: (guest: string) => string | undefined;
  /**
   * a device's own state where it differs (the protocol simulation: each
   * router's installed routes, from what it has learned): a lookup at that
   * device uses it
   */
  at?: (device: string) => RoutingCtx | undefined;
  /**
   * a distance-vector protocol's tables as its routers hold them (the
   * protocol simulation's RIP: what each router's neighbours' Responses
   * brought it): the computation takes them instead of propagating that
   * protocol over the model's adjacencies
   */
  dv?: (protocol: string) => DvTables | null;
}

/** A route a distance-vector router holds: the prefix, its metric, the relation and neighbour it came from, where it was originated. */
export interface DvRoute {
  net: IpPrefix;
  metric: number;
  relation: string;
  peer: string;
  origin: RouteOrigin;
}

/** The tables of a distance-vector protocol's routers, by device and VRF. */
export interface DvTables {
  routes(device: string, vrf: string): DvRoute[];
}

/** The state a device's own tables are read in: its own (RoutingCtx.at) when it has one. */
export function deviceCtx(ctx: RoutingCtx | undefined, device: string): RoutingCtx | undefined {
  if (!ctx || !ctx.at) return ctx;
  return ctx.at(device) || ctx;
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
      // (a container's address without a length is in its network's subnet)
      const len = i.type === 'veth' ? vethPrefixLength(model, i) : undefined;
      for (const address of i.addresses) {
        const p = parsePrefix(len !== undefined && address.indexOf('/') < 0 ? `${address}/${len}` : address, false);
        if (!p) continue;
        out.push({ device, iface: i.id, vrf: vrfKey(i.vrf), net: networkOf(p), addr: { version: p.version, bytes: p.bytes }, address });
      }
    }
  }
  out.sort((a, b) => cmpStr(a.vrf, b.vrf) || comparePrefix(a.net, b.net) || cmpStr(a.iface, b.iface) || compareAddr(a.addr, b.addr));
  byDev.set(device, out);
  return out;
}

/** The prefix length of a veth's container network (its subnet's), if it has one. */
function vethPrefixLength(model: Model, i: Interface): number | undefined {
  const x = vethNetwork(model, i);
  const p = x && x.net.subnet ? parsePrefix(x.net.subnet) : null;
  return p ? p.prefix : undefined;
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
  /** dynamic: where the route was originated and how (connected, advertised, a default route, redistributed from …) */
  origin?: RouteOrigin;
  /** dynamic, BGP: the AS path (nearest AS first) and the local preference */
  asPath?: number[];
  localPref?: number;
  /** dynamic: the policy decisions on its way here ("hq-rtr1 export rule 1 (permit 0.0.0.0/0 to br1)") */
  policy?: string[];
  /** static, not written: a container's default route via its network's gateway, in words */
  implicit?: string;
}

/** Where a dynamic route came from. */
export interface RouteOrigin {
  device: string;
  /** connected, advertised (a policy's `advertise`), default (`default_route`), or redistributed */
  how: 'connected' | 'advertised' | 'default' | 'redistributed';
  /** redistributed: from what (connected, static, another protocol) */
  from?: string;
  /** the routing domains it came through before this one, oldest first: "rip@rip-a" (a protocol's connected set of adjacencies, named by its first device) */
  history: string[];
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
export function ribOf(model: Model, device: string, vrf: string, ctx0?: RoutingCtx): RibEntry[] {
  const ctx = deviceCtx(ctx0, device);
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
  if (d && vrf === '') for (const e of containerDefaults(model, d, out)) out.push(e);
  if (ctx && ctx.extraRoutes) for (const e of ctx.extraRoutes(device, vrf)) out.push(e);
  return dedupeConnected(out.sort(compareEntries));
}

/**
 * A container's default route, as its engine sets it: via the gateway of
 * the first of its networks that has one (in the order of its interfaces),
 * unless a default route of that family is written.
 */
function containerDefaults(model: Model, d: Device, written: RibEntry[]): RibEntry[] {
  if (!isContainer(d)) return [];
  const out: RibEntry[] = [];
  for (const i of d.logical) {
    if (i.type !== 'veth') continue;
    const x = vethNetwork(model, i);
    const gw = x && x.net.gateway !== undefined ? parseAddress(x.net.gateway) : null;
    if (!x || !gw) continue;
    if (written.concat(out).some((e) => e.kind === 'static' && e.net.prefix === 0 && e.net.version === gw.version)) continue;
    const net = parsePrefix(gw.version === 4 ? '0.0.0.0/0' : '::/0') as IpPrefix;
    out.push({ kind: 'static', device: d.id, vrf: '', net, distance: DEFAULT_STATIC_DISTANCE, metric: 0, iface: i.id, via: gw, blackhole: false, implicit: `default route via ${x.net.gateway} (the gateway of the network ${x.net.name})` });
  }
  return out;
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
export function resolveEntry(model: Model, e: RibEntry, ctx0?: RoutingCtx, stack: RibEntry[] = []): Resolution {
  const ctx = deviceCtx(ctx0, e.device);
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
    // (a link-local next hop, fe80::/10, is on the exit interface's link whatever its prefixes: a router's address in router discovery)
    const ll = e.via.version === 6 && e.via.bytes[0] === 0xfe && (e.via.bytes[1] & 0xc0) === 0x80;
    if (own.length && !ll && !own.some((c) => inPrefix(c.net, e.via as IpAddr))) {
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
  return lookupWith(model, device, vrf, dest, deviceCtx(ctx, device), []);
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
  /** "protocol|device\0vrf" -> what that router originates into the protocol (by prefix) */
  originated: Map<string, Map<string, DynRoute>>;
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

/**
 * What a router originates into a routing protocol in a VRF in a state:
 * its connected networks, or its policy's `advertise`, `redistribute` and
 * `default_route` (redistributed routes as the router has them there).
 */
export function originatedRoutes(model: Model, device: string, vrf: string, protocol: string, ctx?: RoutingCtx): Array<{ net: IpPrefix; origin: RouteOrigin }> {
  const m = dynState(model, deviceCtx(ctx, device)).originated.get(protocol + '|' + device + '\0' + vrf);
  return m ? Array.from(m.values()).map((r) => ({ net: r.net, origin: r.origin })) : [];
}

/** The routing adjacencies of the model (one per direction) and those that can't form, sorted. */
export function routingAdjacencies(model: Model, ctx?: RoutingCtx): { adjacencies: Adjacency[]; missing: MissingAdjacency[] } {
  const st = dynState(model, ctx);
  return { adjacencies: st.adjacencies, missing: st.missing };
}

/** The routes a device learns over its adjacencies in one VRF (see the module comment), sorted. */
export function dynamicEntries(model: Model, device: string, vrf: string, ctx?: RoutingCtx): RibEntry[] {
  return dynState(model, deviceCtx(ctx, device)).entries.get(device + '\0' + vrf) || [];
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
  // IS-IS forms its adjacency on the link, whatever the addresses (its PDUs are frames): over an unnumbered interface (no
  // address of its own) its routes go out of it to the neighbour's own address (its router ID, else a loopback's); numbered
  // interfaces in different subnets have no IPv4 next hop for each other
  if (protocol === 'isis') {
    const hop = isisLinkHop(model, r, from, to, aIfs, bIfs, ctx);
    if (hop) return { relation: r.id, protocol, from, to, fromVrf: ifaceVrf(model, from, hop.iface), toVrf: hop.peer.vrf, iface: hop.iface, via: hop.peer.addr, peerIface: hop.peerIface, cost, distance };
    const link = cableBetween(model, from, to, aIfs, bIfs);
    if (link) return `the IS-IS adjacency over ${from}:${link.a} – ${to}:${link.b} has no IP next hop: the interfaces are numbered in different subnets`;
  }
  if (down) return `an interface between ${from} and ${to} is down`;
  const where = (dev: string, ifs: string[] | null): string => (ifs ? ifs.map((i) => dev + ':' + i).join(', ') : dev);
  return `${where(from, aIfs)} and ${where(to, bIfs)} have no network in common`;
}

/** A cable between two devices' interfaces (the relation's endpoint interfaces when written): its two interface ids. */
function cableBetween(model: Model, from: string, to: string, aIfs: string[] | null, bIfs: string[] | null): { a: string; b: string } | null {
  for (const l of model.links.slice().sort((x, y) => cmpStr(x.id, y.id))) {
    for (const [x, y] of [[l.a, l.b], [l.b, l.a]]) {
      if (x.device !== from || y.device !== to || x.iface === undefined || y.iface === undefined) continue;
      if ((aIfs && aIfs.indexOf(x.iface) < 0) || (bIfs && bIfs.indexOf(y.iface) < 0)) continue;
      return { a: x.iface, b: y.iface };
    }
  }
  return null;
}

/** IS-IS over an unnumbered interface of `from` on a cable to `to`: the exit interface and the neighbour's own address. */
function isisLinkHop(model: Model, r: Relation, from: string, to: string, aIfs: string[] | null, bIfs: string[] | null, ctx: RoutingCtx | undefined): { iface: string; peerIface: string; peer: Connected } | null {
  void r;
  const link = cableBetween(model, from, to, aIfs, bIfs);
  if (!link || !isUp(ctx, from, link.a) || !isUp(ctx, to, link.b)) return null;
  if (connectedOf(model, from).some((c) => c.iface === link.a)) return null;
  const peer = connectedOf(model, to).filter((c) => isUp(ctx, to, c.iface) && c.addr.version === 4);
  const d = model.index.devices.get(to);
  const own = d && d.routerId && d.routerId.address ? parseAddress(d.routerId.address) : null;
  const byRid = own ? peer.find((c) => compareAddr(c.addr, own) === 0) : undefined;
  const loop = peer.find((c) => {
    const i = model.index.interfaces.get(to + ':' + c.iface);
    return !!i && i.type === 'loopback';
  });
  const p = byRid || loop || peer.find((c) => c.iface === link.b);
  return p ? { iface: link.a, peerIface: link.b, peer: p } : null;
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

/** A route as one router holds it for one protocol while routes propagate. */
interface DynRoute {
  net: IpPrefix;
  metric: number;
  /** the first adjacencies of every best chain (none: originated here) */
  via: Adjacency[];
  asPath: number[];
  localPref: number;
  origin: RouteOrigin;
  /** the policy decisions on its way */
  policy: string[];
  /** a link-state import filter refused it here: it is flooded on, not installed */
  notInstalled?: string;
}

/** The policy of a device's routing protocol (none written: none). */
function policyOf(model: Model, device: string, protocol: string): RoutingPolicy | undefined {
  const d = model.index.devices.get(device);
  const svc = d ? d.services.find((x) => x.id === protocol) : undefined;
  return svc ? svc.policy : undefined;
}

/** Is `a` a better BGP / IGP route than `b` (-1), as good (0), or worse (1)? */
function rank(protocol: string, a: DynRoute, b: DynRoute): number {
  if (protocol === 'bgp') {
    if (a.localPref !== b.localPref) return a.localPref > b.localPref ? -1 : 1;
    if (a.asPath.length !== b.asPath.length) return a.asPath.length < b.asPath.length ? -1 : 1;
  }
  return a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0;
}

/** The static routes of a device in a VRF that resolve directly (a next hop on a connected network, an exit interface, or a black hole): what `advertise`, `redistribute: [static]` and `if_installed` read. */
function directStatics(model: Model, device: string, vrf: string, ctx: RoutingCtx | undefined): IpPrefix[] {
  const d = model.index.devices.get(device);
  if (!d) return [];
  const conn = connectedOf(model, device).filter((c) => c.vrf === vrf && isUp(ctx, device, c.iface));
  const out: IpPrefix[] = [];
  for (const r of d.routes) {
    if (vrfKey(r.vrf) !== vrf) continue;
    const e = staticEntry(r);
    if (!e) continue;
    // (a null route is installed: the usual anchor of an advertised summary)
    if (e.blackhole) {
      out.push(e.net);
      continue;
    }
    if ((e.iface !== undefined && isUp(ctx, device, e.iface)) || (e.via && conn.some((c) => inPrefix(c.net, e.via as IpAddr)))) out.push(e.net);
  }
  return out;
}

/** A prefix's text as a table key, cached per prefix object (a learned route passes its own on). */
const PREFIX_KEYS = new WeakMap<IpPrefix, string>();
function prefixKey(net: IpPrefix): string {
  let k = PREFIX_KEYS.get(net);
  if (k === undefined) {
    k = prefixText(net);
    PREFIX_KEYS.set(net, k);
  }
  return k;
}

/** Are two routes the same for the fixpoint (metric, preference, AS path, adjacencies, history, installed)? */
function sameRoute(a: DynRoute, b: DynRoute): boolean {
  if (a.metric !== b.metric || a.localPref !== b.localPref || !!a.notInstalled !== !!b.notInstalled) return false;
  if (a.asPath.length !== b.asPath.length || a.via.length !== b.via.length || a.origin.history.length !== b.origin.history.length) return false;
  for (let i = 0; i < a.asPath.length; i++) if (a.asPath[i] !== b.asPath[i]) return false;
  for (let i = 0; i < a.via.length; i++) if (a.via[i] !== b.via[i]) return false;
  for (let i = 0; i < a.origin.history.length; i++) if (a.origin.history[i] !== b.origin.history[i]) return false;
  return true;
}

/** Are two route tables the same (by prefix)? */
function sameTable(a: Map<string, DynRoute>, b: Map<string, DynRoute>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, r] of a) {
    const o = b.get(k);
    if (!o || !sameRoute(r, o)) return false;
  }
  return true;
}

function computeDynamic(model: Model, ctx: RoutingCtx | undefined): DynState {
  const adjacencies: Adjacency[] = [];
  const missing: MissingAdjacency[] = [];
  const rels = model.relations.slice().sort((a, b) => cmpStr(a.id, b.id));
  // a distance-vector protocol whose routers' own tables the state gives (the simulation's RIP): its adjacencies say only how a
  // neighbour is reached; what is learned over them is in those tables
  const dvs = new Map<string, DvTables>();
  if (ctx && ctx.dv) for (const p of ROUTING_PROTOCOLS) {
    const t = ctx.dv(p);
    if (t) dvs.set(p, t);
  }
  for (const r of rels) {
    const protocol = routingProtocol(model, r);
    if (!protocol) continue;
    if (ctx && ctx.relUp && !ctx.relUp(r.id)) continue;
    const devs = relationDevices(r).slice().sort(cmpStr);
    for (const from of devs) {
      for (const to of devs) {
        if (from === to) continue;
        if (ctx && ctx.adjUp && !dvs.has(protocol) && !ctx.adjUp(r.id, from, to)) continue;
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
  const node = (dev: string, vrf: string): string => dev + '\0' + vrf;
  const protocols = ROUTING_PROTOCOLS.filter((p) => adjacencies.some((a) => a.protocol === p));
  // each protocol's routers, and the adjacencies each learns over (by the learning node)
  const nodesOf = new Map<string, string[]>();
  const inbound = new Map<string, Adjacency[]>();
  for (const p of protocols) {
    const adj = adjacencies.filter((a) => a.protocol === p);
    nodesOf.set(p, Array.from(new Set(adj.map((a) => node(a.from, a.fromVrf)).concat(adj.map((a) => node(a.to, a.toVrf))))).sort(cmpStr));
    for (const a of adj) {
      const k = p + '|' + node(a.from, a.fromVrf);
      if (!inbound.has(k)) inbound.set(k, []);
      (inbound.get(k) as Adjacency[]).push(a);
    }
  }
  // each protocol's routing domains: its connected sets of adjacencies (a route never re-enters a domain it came through)
  const domain = new Map<string, string>();
  for (const p of protocols) {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r) as string;
      return r;
    };
    for (const n of nodesOf.get(p) as string[]) parent.set(n, n);
    for (const a of adjacencies.filter((x) => x.protocol === p)) {
      const ra = find(node(a.from, a.fromVrf));
      const rb = find(node(a.to, a.toVrf));
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    }
    for (const n of nodesOf.get(p) as string[]) domain.set(p + '|' + n, p + '@' + find(n).split('\0')[0]);
  }
  const domainOf = (p: string, n: string): string => domain.get(p + '|' + n) || p + '@' + n.split('\0')[0];
  // the best routes per protocol and node, by prefix
  const best = new Map<string, Map<string, DynRoute>>();
  const tableOf = (p: string, n: string): Map<string, DynRoute> => best.get(p + '|' + n) || new Map();
  const connMemo = new Map<string, Connected[]>();
  const conn = (dev: string, vrf: string): Connected[] => {
    const k = dev + '\0' + vrf;
    let v = connMemo.get(k);
    if (!v) connMemo.set(k, (v = connectedOf(model, dev).filter((c) => c.vrf === vrf && isUp(ctx, dev, c.iface))));
    return v;
  };
  const staticsMemo = new Map<string, IpPrefix[]>();
  const staticsOf = (dev: string, vrf: string): IpPrefix[] => {
    const k = dev + '\0' + vrf;
    let v = staticsMemo.get(k);
    if (!v) staticsMemo.set(k, (v = directStatics(model, dev, vrf, ctx)));
    return v;
  };
  /** what a router originates into a protocol now (its own routes: metric 0) */
  const originate = (p: string, n: string): Map<string, DynRoute> => {
    const [dev, vrf] = n.split('\0');
    const pol = policyOf(model, dev, p);
    const out = new Map<string, DynRoute>();
    const add = (net: IpPrefix, origin: RouteOrigin): void => {
      const k = prefixKey(net);
      if (!out.has(k)) out.set(k, { net, metric: 0, via: [], asPath: [], localPref: DEFAULT_LOCAL_PREF, origin, policy: [] });
    };
    const own = conn(dev, vrf);
    const statics = staticsOf(dev, vrf);
    if (pol && pol.advertise) {
      for (const t of pol.advertise) {
        const pp = parsePrefix(t);
        if (!pp) continue;
        const net = networkOf(pp);
        if (own.some((c) => comparePrefix(c.net, net) === 0) || statics.some((x) => comparePrefix(x, net) === 0)) add(net, { device: dev, how: 'advertised', history: [] });
      }
    } else for (const c of own) add(c.net, { device: dev, how: 'connected', history: [] });
    if (pol) {
      for (const src of pol.redistribute) {
        if (src === 'connected') for (const c of own) add(c.net, { device: dev, how: 'redistributed', from: 'connected', history: [] });
        else if (src === 'static') for (const x of statics) add(x, { device: dev, how: 'redistributed', from: 'static', history: [] });
        else {
          // another protocol's routes this router learned (not its own: they are its connected networks already), never back into a domain they came through
          const into = domainOf(p, n);
          for (const r of Array.from(tableOf(src, n).values())) {
            if (!r.via.length || r.notInstalled) continue;
            const history = r.origin.history.concat([domainOf(src, n)]);
            if (history.indexOf(into) >= 0) continue;
            add(r.net, { device: dev, how: 'redistributed', from: src, history });
          }
        }
      }
      if (pol.defaultRoute) {
        const fams = new Set(own.map((c) => c.net.version));
        for (const v of [4, 6] as Array<4 | 6>) {
          if (!fams.has(v)) continue;
          const def = parsePrefix(v === 4 ? '0.0.0.0/0' : '::/0') as IpPrefix;
          const installed = statics.some((x) => x.version === v && x.prefix === 0) || protocols.some((q) => q !== p && Array.from(tableOf(q, n).values()).some((r) => r.net.version === v && r.net.prefix === 0 && r.via.length > 0 && !r.notInstalled));
          if (pol.defaultRoute === 'always' || installed) add(def, { device: dev, how: 'default', history: [] });
        }
      }
    }
    return out;
  };
  // propagate until nothing changes (bounded: a route is never longer than the routers there are)
  const maxRounds = Array.from(nodesOf.values()).reduce((x, l) => x + l.length, 0) + 4;
  const originMemo = new Map<string, Map<string, DynRoute>>();
  const originated = new Map<string, Map<string, DynRoute>>();
  // a router's table is computed again in a round only when what it reads changed in the round before: a neighbour's
  // table of the protocol, or one of its own tables (redistribution, a default route if installed) — the same fixpoint, less work
  let changedTables = new Set<string>();
  let changedNodes = new Set<string>();
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    const next = new Map<string, Map<string, DynRoute>>();
    const nowTables = new Set<string>();
    const nowNodes = new Set<string>();
    for (const p of protocols) {
      const ls = LINK_STATE.indexOf(p) >= 0;
      for (const n of nodesOf.get(p) as string[]) {
        if (round > 0 && !changedNodes.has(n) && !(inbound.get(p + '|' + n) || []).some((a) => changedTables.has(p + '|' + node(a.to, a.toVrf)))) continue;
        const [dev] = n.split('\0');
        // (what it originates reads no learned table unless it redistributes another protocol or has a conditional default: then once)
        let mine = originMemo.get(p + '|' + n);
        if (!mine) {
          mine = originate(p, n);
          const pol = policyOf(model, dev, p);
          if (!pol || (!pol.redistribute.some((x) => x !== 'connected' && x !== 'static') && pol.defaultRoute !== 'if_installed')) originMemo.set(p + '|' + n, mine);
        }
        originated.set(p + '|' + n, mine);
        const out = new Map<string, DynRoute>(mine);
        const dv = dvs.get(p);
        if (dv) {
          // what the router's own table holds (its neighbours' updates, through its filters): over the adjacency it came by
          const [, vrf] = n.split('\0');
          for (const r of dv.routes(dev, vrf)) {
            const a = (inbound.get(p + '|' + n) || []).find((x) => x.relation === r.relation && x.to === r.peer);
            const k = prefixKey(r.net);
            if (!a || (out.get(k) && !(out.get(k) as DynRoute).via.length)) continue;
            out.set(k, { net: r.net, metric: r.metric, via: [a], asPath: [], localPref: DEFAULT_LOCAL_PREF, origin: r.origin, policy: [] });
          }
          if (sameTable(out, tableOf(p, n))) continue;
          next.set(p + '|' + n, out);
          nowTables.add(p + '|' + n);
          nowNodes.add(n);
          changed = true;
          continue;
        }
        const myAs = p === 'bgp' ? bgpAsn(model.index.devices.get(dev)) : undefined;
        const myPol = policyOf(model, dev, p);
        for (const a of inbound.get(p + '|' + n) || []) {
          const from = node(a.to, a.toVrf);
          const theirPol = policyOf(model, a.to, p);
          const theirAs = p === 'bgp' ? bgpAsn(model.index.devices.get(a.to)) : undefined;
          const ebgp = p === 'bgp' && myAs !== undefined && theirAs !== undefined && myAs !== theirAs;
          for (const r of Array.from(tableOf(p, from).values())) {
            // (what it holds but did not install, a link-state router still floods; a distance vector does not pass on what it refused)
            if (r.notInstalled && !ls) continue;
            const evidence = r.policy.slice();
            let prepend = 0;
            if (!ls && theirPol && theirPol.export.length) {
              const d = filterRoute(theirPol.export, r.net, dev, 'export');
              if (!d.permit) continue;
              evidence.push(`${a.to} ${d.text}`);
              prepend = d.prepend || 0;
            }
            // BGP: the AS path, loop prevention, local preference (eBGP resets it)
            let asPath = r.asPath;
            let localPref = r.localPref;
            if (ebgp) {
              if (r.asPath.indexOf(myAs as number) >= 0) continue;
              asPath = Array(prepend + 1).fill(theirAs as number).concat(r.asPath);
              localPref = DEFAULT_LOCAL_PREF;
            }
            const cand: DynRoute = { net: r.net, metric: r.metric + a.cost, via: [a], asPath, localPref, origin: r.origin, policy: evidence };
            if (myPol && myPol.import.length) {
              const d = filterRoute(myPol.import, r.net, a.to, 'import');
              if (!d.permit) {
                if (!ls) continue;
                cand.notInstalled = `${dev} ${d.text}`;
              } else {
                cand.policy = evidence.concat([`${dev} ${d.text}`]);
                if (d.localPref !== undefined) cand.localPref = d.localPref;
              }
            }
            const k = prefixKey(r.net);
            const cur = out.get(k);
            if (!cur) {
              out.set(k, cand);
              continue;
            }
            if (!cur.via.length) continue; // its own route
            const c = rank(p, cand, cur);
            if (c < 0) out.set(k, cand);
            else if (c === 0 && !!cand.notInstalled === !!cur.notInstalled) for (const x of cand.via) if (cur.via.indexOf(x) < 0) cur.via.push(x);
          }
        }
        if (sameTable(out, tableOf(p, n))) continue;
        next.set(p + '|' + n, out);
        nowTables.add(p + '|' + n);
        nowNodes.add(n);
        changed = true;
      }
    }
    for (const [k, v] of next) best.set(k, v);
    if (!changed) break;
    changedTables = nowTables;
    changedNodes = nowNodes;
  }
  // the routes each router installs: what it learned (not its own connected networks), one entry per first adjacency
  const entries = new Map<string, RibEntry[]>();
  for (const p of protocols) {
    for (const n of nodesOf.get(p) as string[]) {
      const [srcDev, srcVrf] = n.split('\0');
      const ownNets = connectedOf(model, srcDev).filter((c) => c.vrf === srcVrf);
      const list = entries.get(n) || [];
      for (const r of Array.from(tableOf(p, n).values())) {
        if (!r.via.length || r.notInstalled) continue;
        if (ownNets.some((o) => comparePrefix(o.net, r.net) === 0)) continue;
        for (const a of r.via) {
          const e: RibEntry = { kind: 'dynamic', device: srcDev, vrf: srcVrf, net: r.net, distance: a.distance, metric: r.metric, iface: a.iface, via: a.via, blackhole: false, protocol: p, relation: a.relation, peer: a.to, origin: r.origin };
          if (p === 'bgp') {
            e.asPath = r.asPath.slice();
            e.localPref = r.localPref;
          }
          if (r.policy.length) e.policy = r.policy.slice();
          list.push(e);
        }
      }
      entries.set(n, list.sort(compareEntries));
    }
  }
  return { adjacencies, missing, entries, originated };
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
