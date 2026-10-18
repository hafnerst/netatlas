/**
 * The modeled scope of addresses: which interfaces share a switched
 * segment, and which devices are parts of one connected architecture. Only
 * what the model draws counts (cables, relations, a guest on its host);
 * nothing is assumed where it draws nothing, so an answer can be "not
 * known" (an interface without a cable).
 *
 *   segment   the interfaces a frame from an interface can reach without
 *             a router: over cables, through the devices that carry frames
 *             between their ports (switches, access points, inline devices,
 *             external networks), in the network's VLAN where the ports say
 *             which VLANs they carry. A link-local address (fe80::/10,
 *             169.254.0.0/16) is unique only within its segment.
 *   part      the devices joined by cables, relations (tunnels, overlays,
 *             routing adjacencies, sessions) and virtualization (a guest on
 *             its host): two parts the model does not join are separate
 *             architectures (an address used in both is reuse, not a
 *             conflict).
 *
 * Pure and deterministic; cached per model.
 */
import { capabilities } from '../model/capabilities';
import { NO_DEVICE_TYPE } from '../model/device-types';
import { endL2, isBridgePort } from '../model/derive';
import { Interface, LinkEnd, Model, ifaceKey, relationDevices } from '../model/types';
import { hostOf, isGuest } from '../model/virtual';
import { portsOf } from './trace';
import type { RoutingCtx } from './routing';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Does the device carry frames between its ports? */
function transit(model: Model, device: string): boolean {
  const d = model.index.devices.get(device);
  if (!d) return false;
  const c = capabilities(d);
  return d.type === NO_DEVICE_TYPE || c.l2Transit || c.externalTransit;
}

/** Does the port at a cable end carry the VLAN (a port that says nothing about VLANs carries what comes)? */
function carries(model: Model, e: LinkEnd, vlan: number | undefined): boolean {
  if (vlan === undefined) return true;
  const l = endL2(model, e);
  if (!l || !(isBridgePort(l) || (l.kind === 'routed' && l.tagged.length > 0))) return true;
  return l.vlans.indexOf(vlan) >= 0;
}

/** The VLAN of an interface's segment: a VLAN interface's, else none (an untagged port's). */
function ifaceVlan(i: Interface | undefined): number | undefined {
  return i && i.type === 'virtual' && i.vlan !== undefined ? i.vlan : undefined;
}

/**
 * The segment of an interface: the interfaces ("device:iface") it reaches
 * without a router, itself included. Null when the interface has no cable
 * (the model says nothing about its segment).
 */
export function segmentOf(model: Model, device: string, iface: string, vlan?: number, ctx?: RoutingCtx): Set<string> | null {
  const i = model.index.interfaces.get(ifaceKey(device, iface));
  const v = vlan !== undefined ? vlan : ifaceVlan(i);
  const ports = portsOf(model, device, iface);
  const start = ports.length ? ports : [iface];
  // (in a failure: only cables that are up, between ports that are up)
  const usable = (l: { id: string; a: LinkEnd; b: LinkEnd }): boolean => !ctx || ((!ctx.linkUp || ctx.linkUp(l.id)) && [l.a, l.b].every((e) => e.iface === undefined || !ctx.up || ctx.up(e.device, e.iface)));
  const links = model.links.filter(usable).sort((a, b) => cmp(a.id, b.id));
  const out = new Set<string>([device + ':' + iface]);
  const queue: Array<{ device: string; via: string | null }> = [];
  const seenDev = new Set<string>([device]);
  // (whether the model draws a cable here at all: a cable that is down still says where the segment is)
  const atStart = (e: LinkEnd): boolean => e.device === device && (e.iface === undefined || start.indexOf(e.iface) >= 0);
  const cabled = model.links.some((l) => atStart(l.a) || atStart(l.b)) || (transit(model, device) && model.links.some((l) => l.a.device === device || l.b.device === device));
  const enter = (far: LinkEnd, viaLink: string): void => {
    if (far.iface !== undefined) out.add(far.device + ':' + far.iface);
    const fd = model.index.devices.get(far.device);
    // a VLAN interface of a device the frame reaches is on the segment (a Layer 3 switch's SVI)
    if (fd && v !== undefined) for (const x of fd.logical) if (x.type === 'virtual' && x.vlan === v) out.add(fd.id + ':' + x.id);
    if (!seenDev.has(far.device) && transit(model, far.device)) {
      seenDev.add(far.device);
      queue.push({ device: far.device, via: viaLink });
    }
  };
  for (const l of links) {
    const near = l.a.device === device && (l.a.iface === undefined || start.indexOf(l.a.iface) >= 0) ? l.a : l.b.device === device && (l.b.iface === undefined || start.indexOf(l.b.iface) >= 0) ? l.b : null;
    if (!near) continue;

    const far = near === l.a ? l.b : l.a;
    if (!carries(model, near, v) || !carries(model, far, v)) continue;
    enter(far, l.id);
  }
  // an interface of a transit device itself (a switch's SVI) starts inside it
  if (transit(model, device)) queue.push({ device, via: null });
  while (queue.length) {
    const s = queue.shift() as { device: string; via: string | null };
    for (const l of links) {
      if (l.id === s.via) continue;
      const near = l.a.device === s.device ? l.a : l.b.device === s.device ? l.b : null;
      if (!near) continue;

      const far = near === l.a ? l.b : l.a;
      if (!carries(model, near, v) || !carries(model, far, v)) continue;
      enter(far, l.id);
    }
  }
  return cabled ? out : null;
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
