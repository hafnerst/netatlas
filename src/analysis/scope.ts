/**
 * The modeled scope of addresses: which interfaces share a switched
 * segment, and which devices are parts of one connected architecture. Only
 * what the model draws counts (cables, relations, a guest on its host);
 * nothing is assumed where it draws nothing, so an answer can be "not
 * known" (an interface without a cable).
 *
 *   segment   the broadcast domain of an interface: what a frame from it
 *             reaches without a router, over cables, through the bridges in
 *             the VLAN it has there (an access port's VLAN, a trunk's tag or
 *             native VLAN, a Wi-Fi network's VLAN, a port group's, a
 *             container network), inline devices between their paired
 *             ports. The simulation forwards in the same domain (one
 *             definition: sim/net.ts l2Domain). A VLAN number alone never
 *             joins two segments, and a port without a VLAN context (a
 *             trunk) is not known rather than every VLAN. A link-local
 *             address (fe80::/10, 169.254.0.0/16) is unique only within its
 *             segment.
 *   part      the devices joined by cables, relations (tunnels, overlays,
 *             routing adjacencies, sessions) and virtualization (a guest on
 *             its host): two parts the model does not join are separate
 *             architectures (an address used in both is reuse, not a
 *             conflict).
 *
 * Pure and deterministic; cached per model.
 */
import { Model, relationDevices } from '../model/types';
import { hostOf, isGuest } from '../model/virtual';
import { L2State, l2Domain, netOf, portKey } from './sim/net';
import type { RoutingCtx } from './routing';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The segment of an interface, and why it can't be taken when it can't. */
export interface SegmentInfo {
  /** the interfaces and ports ("device:iface") a frame from it reaches without a router, itself included; null: not known */
  members: Set<string> | null;
  /** the VLAN it is taken in (0: untagged, no VLAN known) */
  vlan: number | null;
  /** why it is not known: no cable, or no VLAN context (a trunk port, a radio with several Wi-Fi networks) */
  unknown?: string;
}

/**
 * The segment of an interface (see the module comment): the broadcast
 * domain the simulation forwards in (sim/net.ts l2Domain: one definition),
 * in the configured model or in a failure's state. A port that names no
 * VLAN context (a trunk, a radio with several Wi-Fi networks) needs `vlan`:
 * without it the segment is not known (an unknown VLAN never means every
 * VLAN on a switch).
 */
export function segmentInfo(model: Model, device: string, iface: string, vlan?: number, ctx?: RoutingCtx): SegmentInfo {
  const net = netOf(model);
  // (a host port the simulation moved to a virtual switch or a VM: its cable ends there now)
  const moved = net.moved.get(portKey(device, iface));
  const from = moved ? { dev: moved.device, iface: moved.port } : { dev: device, iface };
  const st: L2State = ctx
    ? {
        cableUp: (id) => !ctx.linkUp || ctx.linkUp(id),
        portUp: (d, p) => !ctx.up || ctx.up(d, p.indexOf('~') > 0 ? p.slice(0, p.indexOf('~')) : p),
        forwards: (d) => !ctx.up || ctx.up(d, ''),
      }
    : {};
  const dom = l2Domain(net, vlan !== undefined ? { ...from, vlan } : from, st);
  if (dom.ambiguous) return { members: null, vlan: null, unknown: dom.ambiguous };
  if (dom.uncabled) return { members: null, vlan: dom.vlan, unknown: `${device}:${iface} has no cable: its segment is not known` };
  const out = new Set<string>([device + ':' + iface]);
  const key = (k: string): string => k.replace('|', ':');
  for (const r of dom.reached) {
    out.add(r.dev + ':' + r.l3.id);
    if (r.port !== r.l3.id) out.add(r.dev + ':' + r.port);
  }
  for (const k of dom.entered.concat(dom.left, dom.out)) out.add(key(k));
  // (a bridge's member ports behind the aggregates it crosses)
  for (const k of dom.entered.concat(dom.left)) {
    const [d, bp] = k.split('|');
    const sd = net.devices.get(d);
    const p = sd ? sd.bridgePorts.get(bp) : undefined;
    if (p) for (const m of p.members) out.add(d + ':' + m);
  }
  // (a host's untagged frames: the VLAN the first bridge puts them in)
  return { members: out, vlan: dom.vlan || (dom.bridges.length ? dom.bridges[0].vlan : dom.vlan) };
}

/**
 * The segment of an interface: the interfaces ("device:iface") it reaches
 * without a router, itself included. Null when it is not known (no cable,
 * no VLAN context: segmentInfo says which).
 */
export function segmentOf(model: Model, device: string, iface: string, vlan?: number, ctx?: RoutingCtx): Set<string> | null {
  return segmentInfo(model, device, iface, vlan, ctx).members;
}

const partCache = new WeakMap<Model, Map<string, number>>();

/** The part of the architecture each device is in (an index; equal: joined by cables, relations or virtualization). */
export function architectureParts(model: Model): Map<string, number> {
  const known = partCache.get(model);
  if (known) return known;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  const join = (a: string, b: string): void => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const d of model.devices) parent.set(d.id, d.id);
  for (const l of model.links) join(l.a.device, l.b.device);
  for (const r of model.relations) {
    const ds = relationDevices(r);
    for (const x of ds.slice(1)) join(ds[0], x);
  }
  for (const d of model.devices) {
    if (!isGuest(d)) continue;
    const h = hostOf(model, d);
    if (h) join(d.id, h.id);
  }
  const roots = Array.from(new Set(model.devices.map((d) => find(d.id)))).sort(cmp);
  const out = new Map<string, number>();
  for (const d of model.devices) out.set(d.id, roots.indexOf(find(d.id)));
  partCache.set(model, out);
  return out;
}

/** Is a device joined to anything at all (a cable, a relation, a host or guest)? */
export function joined(model: Model, device: string): boolean {
  if (model.links.some((l) => l.a.device === device || l.b.device === device)) return true;
  if (model.relations.some((r) => relationDevices(r).indexOf(device) >= 0)) return true;
  const d = model.index.devices.get(device);
  if (d && isGuest(d) && hostOf(model, d)) return true;
  return model.devices.some((g) => g.host === device);
}

/** Is an address link-local (IPv6 fe80::/10, IPv4 169.254.0.0/16)? */
export function isLinkLocal(bytes: number[], version: 4 | 6): boolean {
  return version === 6 ? bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80 : bytes[0] === 169 && bytes[1] === 254;
}
