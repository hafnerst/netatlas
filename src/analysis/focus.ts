/**
 * Focus mode's neighbourhood: the devices within N hops of an object, in a
 * view's sense of "directly connected": cables in the physical view,
 * relations (their endpoints) in the logical view. The object itself gives
 * the start: its devices, by the same direct-relation rules the selection
 * uses (model/queries.ts selectionContext): a device itself, an interface's
 * or route's device, a link's two devices, a relation's endpoints, a
 * network's members, a group's devices (nested groups included), a
 * protocol's relations' endpoints. Pure and deterministic.
 */
import { interfaceVlans, linkNetworks, networkMembers, portL2 } from '../model/derive';
import { topicMatches } from '../model/applications';
import { serviceDependencies } from './dependencies';
import { splitRef } from '../model/queries';
import { Model, relationDevices } from '../model/types';

export type FocusView = 'physical' | 'logical';

/**
 * What is up in a simulated state (analysis/failure.ts): focus mode then
 * counts hops only over cables and relations that are up, between devices
 * that are up.
 */
export interface FocusUp {
  device(id: string): boolean;
  link(id: string): boolean;
  relation(id: string): boolean;
}

/** The smallest and largest number of hops focus mode offers. */
export const FOCUS_MIN_HOPS = 1;
export const FOCUS_MAX_HOPS = 3;

/** The devices an object stands for (sorted); empty when it has none or doesn't exist. */
export function focusSeeds(model: Model, ref: string): string[] {
  const ix = model.index;
  let [kind, id] = splitRef(ref);
  if (kind === 'hub') kind = 'relation';
  const out = new Set<string>();
  switch (kind) {
    case 'device':
      if (ix.devices.has(id)) out.add(id);
      break;
    case 'iface': {
      const i = ix.interfaces.get(id);
      if (i) out.add(i.device);
      break;
    }
    case 'route': {
      const r = ix.routes.get(id);
      if (r) out.add(r.device);
      break;
    }
    case 'link': {
      const l = ix.links.get(id);
      if (l) {
        out.add(l.a.device);
        out.add(l.b.device);
      }
      break;
    }
    case 'relation': {
      const r = ix.relations.get(id);
      if (r) for (const d of relationDevices(r)) out.add(d);
      break;
    }
    case 'network':
      if (ix.networks.has(id)) for (const m of networkMembers(model, id)) out.add(m.device);
      break;
    case 'group': {
      const inGroup = (gid: string | undefined): boolean => {
        let g = gid ? ix.groups.get(gid) : undefined;
        while (g) {
          if (g.id === id) return true;
          g = g.parent ? ix.groups.get(g.parent) : undefined;
        }
        return false;
      };
      for (const d of model.devices) if (inGroup(d.group)) out.add(d.id);
      break;
    }
    case 'protocol':
      for (const r of model.relations) if (r.protocol === id) for (const d of relationDevices(r)) out.add(d);
      break;
  }
  return Array.from(out).sort();
}

/** Device → the devices one hop away in a view (cables, or relations), as sorted lists. */
export function hopGraph(model: Model, view: FocusView, up?: FocusUp): Map<string, string[]> {
  const adj = new Map<string, Set<string>>();
  const join = (xs: string[]): void => {
    for (const x of xs) {
      if (!adj.has(x)) adj.set(x, new Set());
      for (const y of xs) if (y !== x) (adj.get(x) as Set<string>).add(y);
    }
  };
  const devUp = (d: string): boolean => !up || up.device(d);
  if (view === 'physical') {
    for (const l of model.links) if (!up || up.link(l.id)) join([l.a.device, l.b.device].filter(devUp));
  } else for (const r of model.relations) if (!up || up.relation(r.id)) join(relationDevices(r).filter(devUp));
  const out = new Map<string, string[]>();
  adj.forEach((s, k) => out.set(k, Array.from(s).sort()));
  return out;
}

// ------------------------------------------------------------ contextual focus

/**
 * A contextual focus: instead of a neighbourhood by hops, the devices that
 * take part in one thing the model configures. Configured structure, never
 * observed traffic, and never proof of reachability (graph proximity is not
 * a path):
 *
 *   vlan       the devices with a port or VLAN interface in the VLAN, and
 *              the members of its networks;
 *   app        a device's applications and services with what they depend
 *              on and what depends on them: peers, brokers, subscribers of
 *              what it publishes, its resolvers and DHCP servers, the
 *              clients that name it, its host and guests;
 *   multicast  a group's configured senders (streams) and receivers
 *              (joins), the PIM routers and the snooping switches of the
 *              receivers' VLANs;
 *   timing     a PTP domain's clocks (and the transparent clocks), or an
 *              NTP device's upstreams and the devices that take time from it;
 *   set        the devices an analysis result names (Analyze: Show only
 *              relevant objects) — display only: the result's own scope is
 *              what it evaluated.
 */
export type FocusContext = { kind: 'vlan'; vlan: number } | { kind: 'app'; device: string } | { kind: 'multicast'; group: string } | { kind: 'timing'; device: string } | { kind: 'vrf'; vrf: string } | { kind: 'set'; devices: string[]; label: string };

export interface ContextFocus {
  /** device → 0 (what the context is about) or 1 (what it involves) */
  devices: Map<string, number>;
  /** what is shown, in words */
  note: string;
}

const sortU = (xs: string[]): string[] => Array.from(new Set(xs)).sort();

/** The contextual focus actions that apply to an object (the selection), with their labels. */
export function focusContexts(model: Model, ref: string): Array<{ ctx: FocusContext; label: string }> {
  const out: Array<{ ctx: FocusContext; label: string }> = [];
  const [kind, id] = splitRef(ref);
  const ix = model.index;
  const vlans = new Set<number>();
  let device: string | undefined;
  if (kind === 'network') {
    const n = ix.networks.get(id);
    if (n && n.vlan !== undefined) vlans.add(n.vlan);
  } else if (kind === 'iface') {
    const i = ix.interfaces.get(id);
    if (i) {
      device = i.device;
      for (const v of interfaceVlans(model, i)) vlans.add(v);
      const l2 = portL2(model, i.device, i.id);
      if (l2) for (const v of l2.vlans.slice(0, 4)) vlans.add(v);
    }
  } else if (kind === 'link') {
    const l = ix.links.get(id);
    if (l) for (const nid of linkNetworks(model, l)) {
      const n = ix.networks.get(nid);
      if (n && n.vlan !== undefined) vlans.add(n.vlan);
    }
  } else if (kind === 'device') device = id;
  Array.from(vlans).sort((a, b) => a - b).slice(0, 4).forEach((v) => out.push({ ctx: { kind: 'vlan', vlan: v }, label: `VLAN ${v} members` }));
  const d = device ? ix.devices.get(device) : undefined;
  // the VRFs of the interface, or of the device's interfaces
  const vrfs = new Set<string>();
  const ifc = kind === 'iface' ? ix.interfaces.get(id) : undefined;
  if (ifc && ifc.vrf) vrfs.add(ifc.vrf);
  else if (d) for (const i of d.interfaces.concat(d.logical)) if (i.vrf) vrfs.add(i.vrf);
  Array.from(vrfs).sort().slice(0, 4).forEach((v) => out.push({ ctx: { kind: 'vrf', vrf: v }, label: `VRF ${v}` }));
  if (d) {
    const deps = appNeighbours(model, d.id);
    if (deps.length) out.push({ ctx: { kind: 'app', device: d.id }, label: 'Application and service dependencies' });
    const groups = new Set<string>();
    for (const i of d.interfaces.concat(d.logical)) if (i.multicast) for (const x of (i.multicast.joins as Array<{ group: string }>).concat(i.multicast.streams)) groups.add(x.group);
    Array.from(groups).sort().slice(0, 3).forEach((g) => out.push({ ctx: { kind: 'multicast', group: g }, label: `Multicast group ${g}` }));
    const svc = d.appServices;
    if (svc && (svc.has('ptp') || svc.has('ntp'))) out.push({ ctx: { kind: 'timing', device: d.id }, label: svc.has('ptp') ? 'PTP timing domain' : 'NTP time sources' });
  }
  return out;
}

/** What a device's applications and services depend on, and what depends on them (configured). */
function appNeighbours(model: Model, dev: string): string[] {
  const out: string[] = [];
  const d = model.index.devices.get(dev);
  if (!d) return out;
  const head = (t: string): string => t.split('/')[0];
  for (const a of d.applications || []) {
    if (a.peer) {
      const p = head(a.peer);
      if (model.index.devices.has(p)) out.push(p);
    }
    if (a.broker) out.push(a.broker);
    // the subscribers of what it publishes, through its broker
    if (a.broker && a.publish.length) for (const x of model.devices) for (const b of x.applications || []) if (b.broker === a.broker && b.subscribe.some((f) => a.publish.some((t) => topicMatches(f, t)))) out.push(x.id);
  }
  // the configured service dependencies (analysis/dependencies.ts): what it depends on, what depends on it
  for (const x of serviceDependencies(model)) {
    if (x.consumer === dev) for (const o of x.options) if (o.provider) out.push(o.provider);
    if (x.options.some((o) => o.provider === dev)) out.push(x.consumer);
  }
  // virtualization: its host, its guests
  if (d.host && model.index.devices.has(d.host)) out.push(d.host);
  for (const g of model.devices) if (g.host === dev) out.push(g.id);
  return sortU(out.filter((x) => x !== dev));
}

/** The devices of a contextual focus (see FocusContext). */
export function contextFocus(model: Model, c: FocusContext): ContextFocus {
  const devices = new Map<string, number>();
  const put = (d: string, k: number): void => {
    if (!model.index.devices.has(d)) return;
    const cur = devices.get(d);
    if (cur === undefined || k < cur) devices.set(d, k);
  };
  if (c.kind === 'vlan') {
    for (const d of model.devices) {
      for (const i of d.interfaces.concat(d.logical)) {
        const l2 = portL2(model, d.id, i.id);
        if ((l2 && l2.vlans.indexOf(c.vlan) >= 0) || interfaceVlans(model, i).indexOf(c.vlan) >= 0) put(d.id, 0);
      }
    }
    for (const n of model.networks) if (n.vlan === c.vlan) for (const m of networkMembers(model, n.id)) put(m.device, 1);
    // a guest's host carries what its guests' port groups carry: the host is shown with the guests
    for (const g of model.devices) if (g.host && devices.has(g.id)) put(g.host, 1);
    return { devices, note: `VLAN ${c.vlan}: the devices with a port or VLAN interface in it and the members of its networks (configured membership, not observed traffic)` };
  }
  if (c.kind === 'app') {
    put(c.device, 0);
    for (const x of appNeighbours(model, c.device)) put(x, 1);
    return { devices, note: `The configured dependencies of ${c.device}’s applications and services, both ways (configured, not proof that they reach each other)` };
  }
  if (c.kind === 'multicast') {
    const recvVlans = new Set<number>();
    for (const d of model.devices) {
      for (const i of d.interfaces.concat(d.logical)) {
        if (!i.multicast) continue;
        if (i.multicast.streams.some((s) => s.group === c.group)) put(d.id, 0);
        if (i.multicast.joins.some((j) => j.group === c.group)) {
          put(d.id, 0);
          const l2 = portL2(model, d.id, i.id);
          if (l2) for (const v of l2.vlans) recvVlans.add(v);
          for (const n of model.networks) if (n.vlan !== undefined && networkMembers(model, n.id).some((m) => m.device === d.id)) recvVlans.add(n.vlan);
        }
      }
    }
    // PIM routers (the relations of PIM) and the snooping switches of the receivers' VLANs
    for (const r of model.relations) if (/^pim/i.test(r.protocol)) for (const x of relationDevices(r)) put(x, 1);
    for (const d of model.devices) if (d.snooping && d.snooping.some((s) => s.enabled && Array.from(recvVlans).some((v) => v >= s.from && v <= s.to))) put(d.id, 1);
    return { devices, note: `Multicast group ${c.group}: its configured senders and receivers, the PIM routers and the snooping switches of the receivers’ VLANs (configured; the simulation’s multicast tables show the observed distribution)` };
  }
  if (c.kind === 'set') {
    for (const d of c.devices) put(d, 0);
    return { devices, note: `${c.label}: the ${devices.size} device${devices.size === 1 ? '' : 's'} the result names (display only: the analysis covered its own scope)` };
  }
  if (c.kind === 'vrf') {
    // the devices with an interface in it, and the devices cabled to those interfaces
    for (const d of model.devices) {
      for (const i of d.interfaces.concat(d.logical)) {
        if (i.vrf !== c.vrf) continue;
        put(d.id, 0);
        for (const l of model.links) {
          if (l.a.device === d.id && l.a.iface === i.id) put(l.b.device, 1);
          if (l.b.device === d.id && l.b.iface === i.id) put(l.a.device, 1);
        }
      }
    }
    return { devices, note: `VRF ${c.vrf}: the devices with an interface in it and their neighbours on those interfaces (configured)` };
  }
  // timing
  const d = model.index.devices.get(c.device);
  const ptp = d && d.appServices ? d.appServices.get('ptp') : undefined;
  if (ptp) {
    const dom = typeof ptp.values.domain === 'number' ? (ptp.values.domain as number) : 0;
    for (const x of model.devices) {
      const p = x.appServices ? x.appServices.get('ptp') : undefined;
      if (!p) continue;
      if (p.values.clock === 'transparent') put(x.id, 1);
      else if ((typeof p.values.domain === 'number' ? (p.values.domain as number) : 0) === dom) put(x.id, 0);
    }
    return { devices, note: `PTP domain ${dom}: its clocks and the transparent clocks (configured; not proof that they synchronize)` };
  }
  put(c.device, 0);
  const ntp = d && d.appServices ? d.appServices.get('ntp') : undefined;
  const ups = ntp && Array.isArray(ntp.values.upstreams) ? (ntp.values.upstreams as string[]) : [];
  const owns = (x: { interfaces: Array<{ addresses: string[] }>; logical: Array<{ addresses: string[] }> }, a: string): boolean => x.interfaces.concat(x.logical).some((i) => i.addresses.some((t) => t.split('/')[0] === a));
  for (const a of ups) for (const x of model.devices) if (owns(x, a)) put(x.id, 1);
  // the devices that take time from it
  const mine = d ? d.interfaces.concat(d.logical).flatMap((i) => i.addresses.map((t) => t.split('/')[0])) : [];
  for (const x of model.devices) {
    const n = x.appServices ? x.appServices.get('ntp') : undefined;
    const u = n && Array.isArray(n.values.upstreams) ? (n.values.upstreams as string[]) : [];
    if (u.some((a) => mine.indexOf(a) >= 0)) put(x.id, 1);
  }
  return { devices, note: `NTP: ${c.device}, its upstreams and the devices that take time from it (configured; not proof that they synchronize)` };
}

/**
 * What can be navigated to by context (Find → Applications, VLANs and
 * VRFs…): every application (its device), every VLAN with its number of
 * devices, every VRF with its devices. Configured structure.
 */
export function navigationIndex(model: Model): { apps: Array<{ device: string; app: string; name: string }>; vlans: Array<{ vlan: number; devices: number; name: string }>; vrfs: Array<{ vrf: string; devices: string[] }> } {
  const apps: Array<{ device: string; app: string; name: string }> = [];
  for (const d of model.devices) for (const a of d.applications || []) apps.push({ device: d.id, app: a.id, name: a.name || a.id });
  const vset = new Set<number>();
  for (const d of model.devices)
    for (const i of d.interfaces.concat(d.logical)) {
      const l2 = portL2(model, d.id, i.id);
      if (l2) for (const v of l2.vlans) vset.add(v);
      for (const v of interfaceVlans(model, i)) vset.add(v);
    }
  for (const n of model.networks) if (n.vlan !== undefined) vset.add(n.vlan);
  const vlans = Array.from(vset).sort((a, b) => a - b).slice(0, 4094).map((v) => {
    const n = model.networks.find((x) => x.vlan === v);
    return { vlan: v, devices: contextFocus(model, { kind: 'vlan', vlan: v }).devices.size, name: n ? n.label || n.id : '' };
  });
  const vm = new Map<string, Set<string>>();
  for (const d of model.devices) for (const i of d.interfaces.concat(d.logical)) if (i.vrf) vm.set(i.vrf, (vm.get(i.vrf) || new Set()).add(d.id));
  const vrfs = Array.from(vm).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([vrf, ds]) => ({ vrf, devices: Array.from(ds).sort() }));
  return { apps, vlans, vrfs };
}

/** A contextual focus in words, for the banner: "VLAN 10 members". */
export function contextLabel(c: FocusContext): string {
  return c.kind === 'vlan' ? `VLAN ${c.vlan} members` : c.kind === 'app' ? `Dependencies of ${c.device}` : c.kind === 'multicast' ? `Multicast group ${c.group}` : c.kind === 'vrf' ? `VRF ${c.vrf}` : c.kind === 'set' ? c.label : `Timing of ${c.device}`;
}

/**
 * The devices within `hops` hops (clamped to 1–3) of the object in a view,
 * with how far each is (0 for the object's own devices). Empty when the
 * object has no device.
 */
export function focusNeighbourhood(model: Model, ref: string, hops: number, view: FocusView, up?: FocusUp): Map<string, number> {
  const n = Math.max(FOCUS_MIN_HOPS, Math.min(FOCUS_MAX_HOPS, Math.round(hops)));
  const dist = new Map<string, number>();
  const seeds = focusSeeds(model, ref);
  for (const s of seeds) dist.set(s, 0);
  const g = hopGraph(model, view, up);
  let frontier = seeds;
  for (let k = 1; k <= n && frontier.length; k++) {
    const next: string[] = [];
    for (const d of frontier) {
      for (const x of g.get(d) || []) {
        if (dist.has(x)) continue;
        dist.set(x, k);
        next.push(x);
      }
    }
    frontier = next.sort();
  }
  return dist;
}
