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
import { routingRole } from '../model/device-types';
import { IpAddr, IpPrefix, parseAddress, parsePrefix } from '../model/ip';
import { Model, Route, deviceInterfaces, routeKey } from '../model/types';
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

/** Which interfaces are up (all of them without a failure; see analysis/failure.ts). */
export interface RoutingCtx {
  up?: (device: string, iface: string) => boolean;
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
  kind: 'connected' | 'static';
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
    (a.route && b.route ? a.route.index - b.route.index : 0)
  );
}

/** All entries of a device's table for one VRF (connected and static), sorted. */
export function ribOf(model: Model, device: string, vrf: string): RibEntry[] {
  const out: RibEntry[] = [];
  for (const c of connectedOf(model, device)) {
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
  const conn = connectedOf(model, e.device).filter((c) => c.vrf === e.vrf);
  if (e.via && conn.some((c) => compareAddr(c.addr, e.via as IpAddr) === 0)) {
    return { ok: false, reason: 'self', detail: `${formatAddr(e.via)} is an address of ${e.device} itself` };
  }
  if (e.iface !== undefined) {
    const iface = e.iface;
    if (!isUp(ctx, e.device, iface)) return { ok: false, reason: 'down', detail: `exit interface ${iface} is down` };
    if (!e.via) return { ok: true, hops: [{ iface }], recursive: false };
    const own = connectedOf(model, e.device).filter((c) => c.iface === iface);
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
  if (connectedOf(model, device).some((c) => c.vrf === vrf && compareAddr(c.addr, dest) === 0 && isUp(ctx, device, c.iface))) {
    return { kind: 'local', entries: [], hops: [], unusable: [] };
  }
  // resolving a next hop (stack not empty): default routes don't count
  const matching = ribOf(model, device, vrf).filter((e) => inPrefix(e.net, dest) && (!stack.length || e.net.prefix > 0));
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
  return !!d && routingRole(d.type) !== null;
}

export function forwards(model: Model, device: string): boolean {
  const d = model.index.devices.get(device);
  return !!d && routingRole(d.type) === 'router';
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
