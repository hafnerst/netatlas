/**
 * Failure impact: what goes down when cables, ports, devices or relations
 * fail, propagated through the model, and the single points of failure.
 * A model-based approximation, like the path tracer:
 *
 *   * a failed device fails its interfaces and the cables at it; a failed
 *     port (or any interface) fails its cable; a cable that fails takes its
 *     ports down (no carrier);
 *   * an aggregate (a virtual interface with member ports) stays up while
 *     enough members are up: its `min_links`, else one. With members down it
 *     is degraded; a VLAN interface goes down when every port carrying its
 *     VLAN is down; a tunnel interface when its source interface or its
 *     tunnel relation is down;
 *   * a relation fails when what it runs `over` fails (recursively: OSPF over
 *     GRE over IPsec over cables), or when its endpoints fail. A LAG or MLAG
 *     relation (LACP, MLAG) runs over its cables side by side: it is degraded
 *     while enough of them are up. A redundancy group (VRRP, HSRP …) with a
 *     member left is degraded (it fails over), not down; a relation of more
 *     than two devices is degraded while two of them are left;
 *   * a network loses the members whose interfaces are down: degraded, or
 *     down when none is left;
 *   * static routes whose next hop can't be reached any more fail; a route
 *     that is used now and was not before (a floating route) takes over;
 *   * virtualization: a failed host takes its guests down (a container in a
 *     VM with the VM), unless a VM's host is in an HA cluster with a member
 *     left: then the VM restarts on the first of them (by id) and is
 *     degraded, a VM with a passthrough port excepted (it is bound to its
 *     host's port). A vNIC goes down when every uplink of its virtual switch
 *     is down (degraded while it has failed over to another), or with its
 *     passthrough port; a macvlan / ipvlan container with its parent;
 *   * the routing context (analysis/routing.ts RoutingCtx) of the result
 *     lets the routing tables and the path tracer see the failure.
 *
 * Deterministic: the result depends on the set of failed objects and the
 * model, never on the order of either.
 */
import { lookupProtocol, protocolBase } from '../model/protocols';
import { Interface, Model, Relation, Route, deviceInterfaces, ifaceKey, relationDevices, Device } from '../model/types';
import { networkMembers, subinterfaceParent } from '../model/derive';
import { clusterMembers, hostOf, isGuest, portGroupAttachments, portGroupOf, uplinkPorts, vethNetwork, vnicHost, vnicPortGroup, vswitchRef, isVm } from '../model/virtual';
import { prefixText } from './ipmath';
import { RibEntry, RoutingCtx, connectedOf, resolveEntry, ribOf, routeRef, routeText, staticEntry } from './routing';
import { pathRefs, portsOf, tracePath, tunnelRelation } from './trace';
import { capabilities } from '../model/capabilities';

export type FailState = 'down' | 'degraded' | 'up';

/** What a route does under the failure: fails, takes over (a floating route now used), or stays as it was. */
export type RouteState = 'down' | 'takeover' | 'up';

/** Objects that can be failed: a device, a cable, an interface (port), a relation. */
export function failableRef(model: Model, ref: string): boolean {
  const i = ref.indexOf(':');
  const kind = ref.slice(0, i);
  const id = ref.slice(i + 1);
  if (kind === 'device') return model.index.devices.has(id);
  if (kind === 'link') return model.index.links.has(id);
  if (kind === 'relation') return model.index.relations.has(id);
  if (kind === 'iface') return model.index.interfaces.has(id);
  return false;
}

export interface FailureResult {
  /** the failed objects (refs that exist), sorted */
  failed: string[];
  devices: Map<string, FailState>;
  /** key "device:iface" */
  ifaces: Map<string, FailState>;
  links: Map<string, FailState>;
  relations: Map<string, FailState>;
  networks: Map<string, FailState>;
  /** static routes by ref ("route:<device>:<index>") */
  routes: Map<string, RouteState>;
  /** why an object is down or degraded (by ref) */
  why: Map<string, string>;
  /** what the routing tables and the path tracer see */
  ctx: RoutingCtx;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Is a relation a bundle of parallel cables (LACP, MLAG): up while enough of them are? */
function isBundle(model: Model, r: Relation): boolean {
  const base = protocolBase(model.protocols, r.protocol);
  return base === 'lacp' || base === 'mlag';
}

/** Propagate the failure of `refs` (see the module comment). */
export function simulate(model: Model, refs: string[]): FailureResult {
  const failed = Array.from(new Set(refs.filter((r) => failableRef(model, r)))).sort(cmp);
  const fDev = new Set<string>();
  const fIf = new Set<string>();
  const fLink = new Set<string>();
  const fRel = new Set<string>();
  for (const r of failed) {
    const id = r.slice(r.indexOf(':') + 1);
    if (r.indexOf('device:') === 0) fDev.add(id);
    else if (r.indexOf('link:') === 0) fLink.add(id);
    else if (r.indexOf('relation:') === 0) fRel.add(id);
    else fIf.add(id);
  }
  const why = new Map<string, string>();
  // guests: down with their host, or restarted by its HA cluster (see the module comment)
  const guests = guestFates(model, fDev);
  const userFailed = new Set(fDev);
  guests.down.forEach((_, id) => fDev.add(id));
  // cables: failed, or a device or port at an end failed
  const links = new Map<string, FailState>();
  for (const l of model.links) {
    let st: FailState = 'up';
    if (fLink.has(l.id)) {
      st = 'down';
      why.set('link:' + l.id, 'failed');
    } else {
      for (const e of [l.a, l.b]) {
        if (st === 'down') break;
        if (fDev.has(e.device)) {
          st = 'down';
          why.set('link:' + l.id, `${e.device} failed`);
        } else if (e.iface !== undefined && fIf.has(ifaceKey(e.device, e.iface))) {
          st = 'down';
          why.set('link:' + l.id, `${e.device}:${e.iface} failed`);
        }
      }
    }
    links.set(l.id, st);
  }
  // interfaces and relations: a fixpoint (things only ever go down or degrade)
  const ifaces = new Map<string, FailState>();
  const relations = new Map<string, FailState>();
  const allIfaces: Interface[] = [];
  for (const d of model.devices) for (const i of deviceInterfaces(d)) allIfaces.push(i);
  for (const i of allIfaces) ifaces.set(ifaceKey(i.device, i.id), 'up');
  for (const r of model.relations) relations.set(r.id, 'up');
  const networks = new Map<string, FailState>();
  for (const n of model.networks) networks.set(n.id, 'up');
  const set = <K>(m: Map<K, FailState>, k: K, st: FailState, ref: string, reason: string): boolean => {
    const cur = m.get(k) || 'up';
    const rank = (s: FailState): number => (s === 'down' ? 2 : s === 'degraded' ? 1 : 0);
    if (rank(st) <= rank(cur)) return false;
    m.set(k, st);
    why.set(ref, reason);
    return true;
  };
  const ifState = (device: string, iface: string): FailState => ifaces.get(ifaceKey(device, iface)) || 'up';
  for (let round = 0; round < 50; round++) {
    let changed = false;
    for (const i of allIfaces) {
      const key = ifaceKey(i.device, i.id);
      const ref = 'iface:' + key;
      if (fDev.has(i.device)) {
        changed = set(ifaces, key, 'down', ref, userFailed.has(i.device) ? `${i.device} failed` : (guests.down.get(i.device) as string)) || changed;
        continue;
      }
      if (fIf.has(key)) {
        changed = set(ifaces, key, 'down', ref, 'failed') || changed;
        continue;
      }
      const vs = virtualState(model, i, ifState, guests.moved);
      if (vs) {
        changed = set(ifaces, key, vs.st, ref, vs.why) || changed;
        continue;
      }
      if (i.type === 'physical') {
        const lid = model.index.ifaceLink.get(key);
        if (lid && links.get(lid) === 'down') changed = set(ifaces, key, 'down', ref, `its cable ${lid} is down`) || changed;
      } else if (i.type === 'virtual' && i.members.length) {
        const up = i.members.filter((m) => ifState(i.device, m) !== 'down').length;
        const min = i.minLinks !== undefined ? i.minLinks : 1;
        if (up < min) changed = set(ifaces, key, 'down', ref, `${up} of ${i.members.length} member ports up, ${min} needed${i.minLinks !== undefined ? ' (min_links)' : ''}`) || changed;
        else if (up < i.members.length) changed = set(ifaces, key, 'degraded', ref, `${up} of ${i.members.length} member ports up`) || changed;
      } else if (i.type === 'virtual') {
        const ports = portsOf(model, i.device, i.id).filter((p) => p !== i.id);
        if (ports.length && ports.every((p) => ifState(i.device, p) === 'down')) changed = set(ifaces, key, 'down', ref, `every port carrying it is down (${ports.join(', ')})`) || changed;
      } else if (i.type === 'tunnel') {
        if (i.source && i.source.iface !== undefined && ifState(i.device, i.source.iface) === 'down') changed = set(ifaces, key, 'down', ref, `its source ${i.source.iface} is down`) || changed;
        const tr = tunnelRelation(model, i.device, i.id);
        if (tr && relations.get(tr.id) === 'down') changed = set(ifaces, key, 'down', ref, `its tunnel ${tr.id} is down`) || changed;
      }
    }
    for (const n of model.networks) {
      const ms = networkMembers(model, n.id);
      const m: Array<{ device: string; iface: string }> = [];
      for (const x of ms) for (const a of x.matches) m.push({ device: a.device, iface: a.iface });
      if (!m.length) continue;
      const down = m.filter((x) => ifState(x.device, x.iface) === 'down');
      if (down.length === m.length) changed = set(networks, n.id, 'down', 'network:' + n.id, 'none of its members is left') || changed;
      else if (down.length) changed = set(networks, n.id, 'degraded', 'network:' + n.id, `lost ${Array.from(new Set(down.map((x) => x.device))).sort(cmp).join(', ')}`) || changed;
    }
    for (const r of model.relations) {
      const ref = 'relation:' + r.id;
      if (fRel.has(r.id)) {
        changed = set(relations, r.id, 'down', ref, 'failed') || changed;
        continue;
      }
      const devs = relationDevices(r);
      const alive = devs.filter((d) => !fDev.has(d) && r.endpoints.filter((e) => e.device === d).some((e) => e.iface === undefined || ifState(d, e.iface) !== 'down'));
      // the endpoints lost, named as what failed: the device, or its interface
      const lost = devs
        .filter((d) => alive.indexOf(d) < 0)
        .sort(cmp)
        .map((d) => {
          if (fDev.has(d)) return d;
          const e = r.endpoints.find((x) => x.device === d && x.iface !== undefined);
          return e ? `${d}:${e.iface}` : d;
        });
      // what it runs over
      const overStates = r.over.map((o) => ({ id: o, st: links.has(o) ? (links.get(o) as FailState) : relations.has(o) ? (relations.get(o) as FailState) : networks.has(o) ? (networks.get(o) === 'down' ? 'down' : 'up') : 'up' }));
      const overDown = overStates.filter((o) => o.st === 'down').map((o) => o.id);
      const overDeg = overStates.filter((o) => o.st === 'degraded').map((o) => o.id);
      if (isBundle(model, r)) {
        const minOf = r.endpoints.map((e) => (e.iface !== undefined ? model.index.interfaces.get(ifaceKey(e.device, e.iface)) : undefined)).map((i) => (i && i.minLinks !== undefined ? i.minLinks : 1));
        const min = Math.max(1, ...minOf);
        const up = overStates.length - overDown.length;
        if (alive.length < 2) changed = set(relations, r.id, 'down', ref, `${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} down`) || changed;
        else if (overStates.length && up < min) changed = set(relations, r.id, 'down', ref, `${up} of ${overStates.length} cables up, ${min} needed`) || changed;
        else if (overDown.length) changed = set(relations, r.id, 'degraded', ref, `${up} of ${overStates.length} cables up (${overDown.join(', ')} down)`) || changed;
        else if (lost.length) changed = set(relations, r.id, 'degraded', ref, `lost ${lost.join(', ')}`) || changed;
        continue;
      }
      if (overDown.length) {
        changed = set(relations, r.id, 'down', ref, `it runs over ${overDown.join(', ')}, which ${overDown.length === 1 ? 'is' : 'are'} down`) || changed;
        continue;
      }
      if (r.category === 'redundancy') {
        if (!alive.length) changed = set(relations, r.id, 'down', ref, 'no member is left') || changed;
        else if (lost.length) changed = set(relations, r.id, 'degraded', ref, `fails over: ${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} down, ${alive.slice().sort(cmp).join(', ')} left`) || changed;
        continue;
      }
      if (lost.length && (devs.length <= 2 || alive.length < 2)) {
        changed = set(relations, r.id, 'down', ref, `${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} down`) || changed;
        continue;
      }
      if (lost.length) changed = set(relations, r.id, 'degraded', ref, `lost ${lost.join(', ')}`) || changed;
      else if (overDeg.length) changed = set(relations, r.id, 'degraded', ref, `it runs over ${overDeg.join(', ')}, which ${overDeg.length === 1 ? 'is' : 'are'} degraded`) || changed;
    }
    if (!changed) break;
  }
  // devices: failed, or degraded when something of theirs is down
  const devices = new Map<string, FailState>();
  for (const d of model.devices) {
    if (fDev.has(d.id)) {
      devices.set(d.id, 'down');
      why.set('device:' + d.id, userFailed.has(d.id) ? 'failed' : (guests.down.get(d.id) as string));
      continue;
    }
    if (guests.moved.has(d.id) || guests.movedWhy.has(d.id)) {
      devices.set(d.id, 'degraded');
      why.set('device:' + d.id, guests.movedWhy.get(d.id) as string);
      continue;
    }
    const lostIfs = deviceInterfaces(d)
      .filter((i) => ifState(d.id, i.id) !== 'up')
      .map((i) => i.id)
      .sort(cmp);
    if (lostIfs.length) {
      devices.set(d.id, 'degraded');
      why.set('device:' + d.id, `${lostIfs.join(', ')} ${lostIfs.length === 1 ? 'is' : 'are'} down or degraded`);
    } else devices.set(d.id, 'up');
  }
  const ctx: RoutingCtx = {
    up: (device, iface) => !fDev.has(device) && ifState(device, iface) !== 'down',
    relUp: (id) => relations.get(id) !== 'down',
    linkUp: (id) => links.get(id) !== 'down',
  };
  if (guests.moved.size) ctx.hostOf = (g) => guests.moved.get(g);
  const routes = routeStates(model, ctx, why);
  return { failed, devices, ifaces, links, relations, networks, routes, why, ctx };
}

/**
 * What happens to the guests when devices fail: those that go down (with
 * why), the VMs restarted on another member of their host's HA cluster (by
 * their new host), and why each moved guest (and a container moving with
 * its VM) is degraded.
 */
function guestFates(model: Model, failed: Set<string>): { down: Map<string, string>; moved: Map<string, string>; movedWhy: Map<string, string> } {
  const down = new Map<string, string>();
  const moved = new Map<string, string>();
  const movedWhy = new Map<string, string>();
  // hosts before their guests: by the depth of the guest
  const depth = (d: { id: string }): number => {
    let n = 0;
    let x = model.index.devices.get(d.id);
    while (x && isGuest(x) && n < 5) {
      x = hostOf(model, x);
      n++;
    }
    return n;
  };
  const gs = model.devices.filter((d) => isGuest(d) && d.host !== undefined && !failed.has(d.id)).sort((a, b) => depth(a) - depth(b));
  for (const g of gs) {
    const h = hostOf(model, g);
    if (!h) continue;
    const hostGone = failed.has(h.id) || down.has(h.id);
    if (moved.has(h.id) || movedWhy.has(h.id)) {
      if (!hostGone) movedWhy.set(g.id, `moves with ${h.id} (restarted on ${moved.get(h.id) || h.id})`);
      continue;
    }
    if (!hostGone) continue;
    const what = failed.has(h.id) ? `its host ${h.id} failed` : `its host ${h.id} is down`;
    const cluster = isVm(g) && h.hypervisor ? h.hypervisor.cluster : undefined;
    const spare = clusterMembers(model, cluster).filter((m) => m.id !== h.id && !failed.has(m.id)).map((m) => m.id).sort(cmp);
    const pinned = g.logical.some((i) => i.type === 'vnic' && i.passthrough !== undefined);
    if (cluster !== undefined && spare.length && !pinned) {
      moved.set(g.id, spare[0]);
      movedWhy.set(g.id, `${what}: restarts on ${spare[0]} (HA cluster ${cluster})`);
    } else down.set(g.id, cluster !== undefined && spare.length && pinned ? `${what}; with a passthrough port HA can't restart it elsewhere` : what);
  }
  return { down, moved, movedWhy };
}

/**
 * The state of a guest's virtual interface (or a host's own vNIC) from what
 * it depends on: its virtual switch's uplinks, its passthrough port, its
 * macvlan parent, its vNIC (a VLAN subinterface). Null for other interfaces.
 */
function virtualState(model: Model, i: Interface, ifState: (device: string, iface: string) => FailState, moved: Map<string, string>): { st: FailState; why: string } | null {
  if (i.type === 'vnic') {
    const to = moved.get(i.device);
    const host = to !== undefined ? model.index.devices.get(to) : vnicHost(model, i);
    if (i.passthrough !== undefined) {
      const h = vnicHost(model, i);
      return h && ifState(h.id, i.passthrough) === 'down' ? { st: 'down', why: `its passthrough port ${h.id}:${i.passthrough} is down` } : null;
    }
    const x = to !== undefined ? portGroupOf(host, i.portGroup) : vnicPortGroup(model, i);
    if (!host) return null;
    if (!x) return to !== undefined && i.portGroup !== undefined ? { st: 'down', why: `restarted on ${to}, which has no port group ${i.portGroup}` } : null;
    const ports = uplinkPorts(model, host, x.vswitch);
    if (!ports.length) return null;
    const gone = ports.filter((p) => ifState(host.id, p) === 'down');
    if (gone.length === ports.length) return { st: 'down', why: `every uplink of ${x.vswitch.name} on ${host.id} is down (${gone.join(', ')})` };
    if (gone.length) return { st: 'degraded', why: `${x.vswitch.name} on ${host.id} fails over: ${gone.join(', ')} down` };
    return null;
  }
  if (i.type === 'veth') {
    const x = vethNetwork(model, i);
    if (x && (x.net.driver === 'macvlan' || x.net.driver === 'ipvlan') && x.net.parent !== undefined && ifState(x.host.id, x.net.parent) === 'down') return { st: 'down', why: `its parent ${x.host.id}:${x.net.parent} is down` };
    return null;
  }
  if (i.type === 'virtual' && !i.members.length) {
    const p = subinterfaceParent(model, i);
    const pi = p !== undefined ? model.index.interfaces.get(ifaceKey(i.device, p)) : undefined;
    if (pi && pi.type === 'vnic') {
      const st = ifState(i.device, p as string);
      return st === 'up' ? { st: 'up', why: '' } : { st, why: `its vNIC ${p} is ${st}` };
    }
  }
  return null;
}

/** The entries a table selects for exactly one prefix (the lowest distance, then metric, among the usable ones). */
function selectedFor(model: Model, device: string, vrf: string, prefix: string, ctx: RoutingCtx | undefined): RibEntry[] {
  const same = ribOf(model, device, vrf, ctx).filter((e) => prefixText(e.net) === prefix && (e.blackhole || resolveEntry(model, e, ctx).ok));
  if (!same.length) return [];
  const d = Math.min(...same.map((e) => e.distance));
  const atD = same.filter((e) => e.distance === d);
  const m = Math.min(...atD.map((e) => e.metric));
  return atD.filter((e) => e.metric === m);
}

function routeStates(model: Model, ctx: RoutingCtx, why: Map<string, string>): Map<string, RouteState> {
  const out = new Map<string, RouteState>();
  for (const d of model.devices) {
    for (const r of d.routes) {
      const ref = routeRef(r);
      const e = staticEntry(r);
      if (!e) {
        out.set(ref, 'up');
        continue;
      }
      const before = resolveEntry(model, e).ok || r.blackhole;
      const after = r.blackhole ? !(ctx.up && e.iface !== undefined && !ctx.up(r.device, e.iface)) : resolveEntry(model, e, ctx).ok;
      if (before && !after) {
        const res = resolveEntry(model, e, ctx);
        out.set(ref, 'down');
        why.set(ref, res.ok ? 'down' : `its next hop can't be reached: ${res.detail}`);
        continue;
      }
      const p = prefixText(e.net);
      const inUse = (c: RoutingCtx | undefined): boolean => selectedFor(model, r.device, e.vrf, p, c).some((x) => x.route === r);
      if (!inUse(undefined) && inUse(ctx)) {
        out.set(ref, 'takeover');
        why.set(ref, `takes over ${p}: the routes used before failed`);
      } else out.set(ref, 'up');
    }
  }
  return out;
}

/** The state of everything the diagrams mark, by ref (only what is not up). */
export function failureRefs(res: FailureResult): Map<string, 'down' | 'degraded'> {
  const out = new Map<string, 'down' | 'degraded'>();
  const put = (ref: string, st: string): void => {
    if (st === 'down') out.set(ref, 'down');
    else if (st === 'degraded' || st === 'takeover') out.set(ref, 'degraded');
  };
  res.devices.forEach((st, id) => put('device:' + id, st));
  res.ifaces.forEach((st, k) => put('iface:' + k, st));
  res.links.forEach((st, id) => put('link:' + id, st));
  res.relations.forEach((st, id) => put('relation:' + id, st));
  res.networks.forEach((st, id) => put('network:' + id, st));
  res.routes.forEach((st, ref) => put(ref, st));
  return out;
}

export interface Affected {
  ref: string;
  state: FailState | RouteState;
  why: string;
}

/** The affected objects of one kind, down first, then by id. */
function affected<K>(m: Map<K, FailState | RouteState>, ref: (k: K) => string, why: Map<string, string>, keep: (k: K) => boolean = () => true): Affected[] {
  const out: Affected[] = [];
  m.forEach((st, k) => {
    if (st === 'up' || !keep(k)) return;
    const r = ref(k);
    out.push({ ref: r, state: st, why: why.get(r) || '' });
  });
  const rank = (s: string): number => (s === 'down' ? 0 : 1);
  return out.sort((a, b) => rank(a.state) - rank(b.state) || cmp(a.ref, b.ref));
}

export interface FailureSummary {
  devices: Affected[];
  links: Affected[];
  relations: Affected[];
  tunnels: Affected[];
  networks: Affected[];
  routes: Affected[];
}

/** What is affected, per kind (tunnels: relations of category tunnel or overlay). */
export function summarize(model: Model, res: FailureResult): FailureSummary {
  const tunnel = (id: string): boolean => {
    const r = model.index.relations.get(id);
    return !!r && (r.category === 'tunnel' || r.category === 'overlay');
  };
  return {
    devices: affected(res.devices, (k) => 'device:' + k, res.why),
    links: affected(res.links, (k) => 'link:' + k, res.why),
    relations: affected(res.relations, (k) => 'relation:' + k, res.why, (k) => !tunnel(k)),
    tunnels: affected(res.relations, (k) => 'relation:' + k, res.why, tunnel),
    networks: affected(res.networks, (k) => 'network:' + k, res.why),
    routes: affected(res.routes, (k) => k, res.why),
  };
}

// ------------------------------------------------------------ reachability

/** At most this many devices are checked pairwise for reachability. */
export const REACH_MAX_DEVICES = 40;

export interface LostPair {
  from: string;
  to: string;
  /** where and why the trace stops now (the main path's end) */
  detail: string;
  /** some equal-cost paths still reach: only part of the traffic is lost */
  partial: boolean;
}

/** per model and ordered pair: does it reach, and what its paths touch */
const reachCache = new WeakMap<Model, Map<string, { ok: boolean; partial: boolean; refs: Set<string> }>>();

/** The devices whose reachability is checked: those with an address, by id (at most REACH_MAX_DEVICES). */
export function reachDevices(model: Model): { devices: string[]; total: number } {
  const all = model.devices
    .filter((d) => connectedOf(model, d.id).length > 0)
    .map((d) => d.id)
    .sort(cmp);
  return { devices: all.slice(0, REACH_MAX_DEVICES), total: all.length };
}

/** Does `from` reach `to`: on all equal-cost paths (ok), some of them (partial), or none? */
function reaches(model: Model, from: string, to: string, ctx?: RoutingCtx): { ok: boolean; partial: boolean; detail: string; refs: Set<string> } {
  const t = tracePath(model, { from, to }, ctx);
  const refs = new Set<string>();
  for (const p of t.paths) pathRefs(p).forEach((r) => refs.add(r));
  if (t.error || !t.paths.length) return { ok: false, partial: false, detail: t.error || 'no path', refs };
  const reached = t.paths.filter((p) => p.end.kind === 'reached').length;
  const bad = t.paths.find((p) => p.end.kind !== 'reached');
  const e = bad ? bad.end : t.paths[0].end;
  const detail = e.kind === 'stopped' ? `stops at ${e.device}: ${e.detail}` : e.kind === 'reached' ? '' : e.kind === 'exits' ? `leaves the model at ${e.device}` : `delivered by ${e.device}`;
  return { ok: reached === t.paths.length, partial: reached > 0 && reached < t.paths.length, detail, refs };
}

/**
 * The ordered device pairs that reached each other without the failure and
 * don't with it (traced device to device; a failed device's own pairs are
 * not counted). Sorted by source and destination. A failure only takes
 * routes away, so a pair whose paths touched nothing affected keeps them:
 * only the others are traced again.
 */
export function lostReachability(model: Model, res: FailureResult): { pairs: LostPair[]; checked: number; total: number } {
  const { devices, total } = reachDevices(model);
  let before = reachCache.get(model);
  if (!before) reachCache.set(model, (before = new Map()));
  const pairs: LostPair[] = [];
  const hit = failureRefs(res);
  for (const a of devices) {
    if (res.devices.get(a) === 'down') continue;
    for (const b of devices) {
      if (a === b || res.devices.get(b) === 'down') continue;
      const k = a + '\n' + b;
      let was = before.get(k);
      if (was === undefined) {
        const r = reaches(model, a, b);
        before.set(k, (was = { ok: r.ok, partial: r.partial, refs: r.refs }));
      }
      if (!(was.ok || was.partial) || !Array.from(was.refs).some((r) => hit.has(r))) continue;
      const now = reaches(model, a, b, res.ctx);
      if (now.ok) continue;
      // all of it lost, or a part that reached before
      if (!now.partial) pairs.push({ from: a, to: b, detail: now.detail, partial: false });
      else if (was.ok) pairs.push({ from: a, to: b, detail: now.detail, partial: true });
    }
  }
  return { pairs, checked: devices.length, total };
}

// ------------------------------------------------------------ single points of failure

export interface Spof {
  kind: 'cable' | 'device' | 'lag' | 'vswitch' | 'passthrough';
  /** the object (link, device or aggregate interface) */
  ref: string;
  /** what the simulation fails for it */
  fail: string[];
  /** devices cut off from the rest of the network they were connected to (each group sorted) */
  isolated: string[][];
  /** relations that go down although their endpoints are still up */
  relations: string[];
  /** guests (VMs, containers) that go down or lose every network interface with it, sorted */
  guests: string[];
  /** a virtual switch: why it is one ("one uplink", "its uplinks all go to tor1") */
  note?: string;
}

/**
 * Which of a device's ports it joins (null: all of them, as a switch or a
 * router does). What it can do decides: an inline or pass-through device
 * joins only its paired ports (a pair with its monitor ports); a passive
 * monitor joins none (it only receives); a Separation gateway joins its two
 * domains only when its policy permits some transfer between them, and its
 * management interfaces join nothing.
 */
export function portGroups(d: Device): string[][] | null {
  const c = capabilities(d);
  const ports = d.interfaces.map((i) => i.id);
  if (c.inline || c.passThrough) {
    const out: string[][] = d.portPairs.map((p) => [p.a, p.b, ...p.copy]);
    for (const x of ports) if (!out.some((g) => g.indexOf(x) >= 0)) out.push([x]);
    return out;
  }
  if (c.passiveCopy) return ports.map((x) => [x]);
  if (c.separationGateway) {
    const sep = d.separation;
    const doms = sep ? sep.domains.map((x) => x.interfaces.slice()) : [];
    const permits = !!sep && !!sep.implementation && sep.directions.length > 0 && (sep.rules.length > 0 || sep.profiles.length > 0);
    const out: string[][] = permits && doms.length === 2 ? [doms[0].concat(doms[1])] : doms;
    for (const x of ports) if (!out.some((g) => g.indexOf(x) >= 0)) out.push([x]);
    return out;
  }
  if (d.management.length) {
    // (a transparent firewall's or an IDS/IPS's management interfaces are no way through it)
    const data = ports.filter((x) => d.management.indexOf(x) < 0);
    return [data, ...d.management.map((x) => [x])];
  }
  return null;
}

/** The groups of devices joined by cables that are up (each sorted; groups by first id), through each device as far as it joins its ports. */
function components(model: Model, devUp: (d: string) => boolean, linkUp: (l: string) => boolean): string[][] {
  const adj = new Map<string, string[]>();
  // a device that joins only some of its ports: a node per group of ports ("id#n"), the device itself with its first group
  const node = new Map<string, string>();
  const nodeOf = (dev: string, port: string | undefined): string => node.get(dev + '\0' + (port || '')) || dev;
  const join = (x: string, y: string): void => {
    (adj.get(x) as string[]).push(y);
    (adj.get(y) as string[]).push(x);
  };
  for (const d of model.devices) {
    if (!devUp(d.id)) continue;
    adj.set(d.id, []);
    const groups = portGroups(d);
    if (!groups) continue;
    groups.forEach((g, n) => {
      const id = n === 0 ? d.id : `${d.id}#${n}`;
      if (n > 0) adj.set(id, []);
      for (const port of g) node.set(d.id + '\0' + port, id);
    });
  }
  for (const l of model.links) {
    if (!linkUp(l.id) || !adj.has(l.a.device) || !adj.has(l.b.device) || l.a.device === l.b.device) continue;
    join(nodeOf(l.a.device, l.a.iface), nodeOf(l.b.device, l.b.iface));
  }
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const d of Array.from(adj.keys()).sort(cmp)) {
    if (seen.has(d)) continue;
    const comp: string[] = [];
    const q = [d];
    seen.add(d);
    while (q.length) {
      const x = q.shift() as string;
      comp.push(x);
      for (const y of adj.get(x) as string[]) if (!seen.has(y)) (seen.add(y), q.push(y));
    }
    const devs = comp.filter((x) => x.indexOf('#') < 0);
    if (devs.length) out.push(devs.sort(cmp));
  }
  return out;
}

/**
 * The cables, devices and LAGs whose failure alone would partition the
 * physical network (devices that were connected by cables no longer are,
 * leaving out the failed device itself) or bring down relations whose
 * endpoints are still up (no redundant underlay). Most impact first.
 */
export function singlePointsOfFailure(model: Model): Spof[] {
  const before = components(model, () => true, () => true);
  const compOf = new Map<string, number>();
  before.forEach((c, i) => c.forEach((d) => compOf.set(d, i)));
  const cands: Array<{ kind: Spof['kind']; ref: string; fail: string[]; note?: string }> = [];
  for (const l of model.links) cands.push({ kind: 'cable', ref: 'link:' + l.id, fail: ['link:' + l.id] });
  for (const d of model.devices) cands.push({ kind: 'device', ref: 'device:' + d.id, fail: ['device:' + d.id] });
  for (const d of model.devices) {
    for (const i of d.logical) {
      if (!i.members.length) continue;
      const ls = i.members.map((m) => model.index.ifaceLink.get(ifaceKey(d.id, m))).filter((x): x is string => !!x);
      if (ls.length < 2) continue;
      // one LAG between two devices is listed once (from the device first by id)
      const far = ls.map((id) => {
        const l = model.index.links.get(id);
        return l ? (l.a.device === d.id ? l.b.device : l.a.device) : '';
      });
      if (far.every((f) => f && f < d.id && model.devices.some((x) => x.id === f && x.logical.some((j) => j.members.length && ls.every((lid) => j.members.some((m) => model.index.ifaceLink.get(ifaceKey(f, m)) === lid)))))) continue;
      cands.push({ kind: 'lag', ref: `iface:${d.id}:${i.id}`, fail: Array.from(new Set(ls)).sort(cmp).map((x) => 'link:' + x) });
    }
  }
  cands.push(...virtualCandidates(model));
  const out: Spof[] = [];
  for (const c of cands) {
    const res = simulate(model, c.fail);
    const after = components(model, (d) => res.devices.get(d) !== 'down', (l) => res.links.get(l) !== 'down');
    // groups of survivors cut off from devices they were connected to: every group but the largest of each former group
    const isolated: string[][] = [];
    const byFormer = new Map<number, string[][]>();
    for (const g of after) {
      const k = compOf.get(g[0]) as number;
      if (!byFormer.has(k)) byFormer.set(k, []);
      (byFormer.get(k) as string[][]).push(g);
    }
    byFormer.forEach((gs) => {
      if (gs.length < 2) return;
      const sorted = gs.slice().sort((a, b) => b.length - a.length || cmp(a[0], b[0]));
      for (const g of sorted.slice(1)) isolated.push(g);
    });
    isolated.sort((a, b) => cmp(a[0], b[0]));
    const relations: string[] = [];
    res.relations.forEach((st, id) => {
      if (st !== 'down') return;
      const r = model.index.relations.get(id) as Relation;
      if (relationDevices(r).every((d) => res.devices.get(d) !== 'down')) relations.push(id);
    });
    relations.sort(cmp);
    // guests (not the failed object itself) that go down, or keep no network interface that is up
    const failedDevs = new Set(c.fail.filter((f) => f.indexOf('device:') === 0).map((f) => f.slice(7)));
    const guests = model.devices
      .filter((d) => isGuest(d) && d.host !== undefined && !failedDevs.has(d.id))
      .filter((d) => {
        if (res.devices.get(d.id) === 'down') return true;
        const nics = d.logical.filter((i) => i.type === 'vnic' || i.type === 'veth');
        return nics.length > 0 && nics.every((i) => res.ifaces.get(ifaceKey(d.id, i.id)) === 'down');
      })
      .map((d) => d.id)
      .sort(cmp);
    if (isolated.length || relations.length || guests.length) {
      const s: Spof = { kind: c.kind, ref: c.ref, fail: c.fail, isolated, relations, guests };
      if (c.note !== undefined) s.note = c.note;
      out.push(s);
    }
  }
  const weight = (s: Spof): number => s.isolated.reduce((n, g) => n + g.length, 0) + s.relations.length + s.guests.length;
  const kindRank = { device: 0, lag: 1, vswitch: 2, passthrough: 3, cable: 4 };
  return out.sort((a, b) => weight(b) - weight(a) || kindRank[a.kind] - kindRank[b.kind] || cmp(a.ref, b.ref));
}

/**
 * The virtual candidates: each virtual switch with guests on it whose
 * uplinks are one port (its failure) or all go to one device (that
 * device's failure), and each passthrough port.
 */
function virtualCandidates(model: Model): Array<{ kind: Spof['kind']; ref: string; fail: string[]; note?: string }> {
  const out: Array<{ kind: Spof['kind']; ref: string; fail: string[]; note?: string }> = [];
  for (const h of model.devices) {
    if (!h.hypervisor) continue;
    for (const vs of h.hypervisor.vswitches) {
      const used = vs.portGroups.some((pg) => portGroupAttachments(model, h, pg.name).some((i) => i.device !== h.id));
      const ports = uplinkPorts(model, h, vs);
      if (!used || !ports.length) continue;
      if (ports.length === 1) {
        out.push({ kind: 'vswitch', ref: vswitchRef(h.id, vs.name), fail: [`iface:${h.id}:${ports[0]}`], note: `one uplink (${ports[0]})` });
        continue;
      }
      const far = new Set<string>();
      for (const p of ports) {
        const lid = model.index.ifaceLink.get(ifaceKey(h.id, p));
        const l = lid ? model.index.links.get(lid) : undefined;
        if (l) far.add(l.a.device === h.id ? l.b.device : l.a.device);
      }
      if (far.size === 1) {
        const f = Array.from(far)[0];
        out.push({ kind: 'vswitch', ref: vswitchRef(h.id, vs.name), fail: ['device:' + f], note: `its uplinks all go to ${f}` });
      }
    }
    for (const g of model.devices) {
      if (!isVm(g) || g.host !== h.id) continue;
      for (const i of g.logical) if (i.type === 'vnic' && i.passthrough !== undefined) out.push({ kind: 'passthrough', ref: `iface:${h.id}:${i.passthrough}`, fail: [`iface:${h.id}:${i.passthrough}`] });
    }
  }
  return out;
}

/** What failed, named: "hq-fw, cable l-peer1". */
export function failedText(model: Model, res: FailureResult): string {
  return res.failed.map((r) => refLabel(model, r)).join(', ');
}

/** A failure as one line: "failed hq-fw, cable l-peer1 · 9 down, 6 degraded". */
export function failureLine(model: Model, res: FailureResult): string {
  let down = 0;
  let deg = 0;
  failureRefs(res).forEach((st, ref) => {
    if (ref.indexOf('device:') === 0 || ref.indexOf('link:') === 0 || ref.indexOf('relation:') === 0 || ref.indexOf('network:') === 0 || ref.indexOf('route:') === 0) {
      if (st === 'down') down++;
      else deg++;
    }
  });
  const names = res.failed.map((r) => refLabel(model, r));
  return `failed ${names.join(', ')} · ${down} down, ${deg} degraded`;
}

/** A ref as the lists name it: "hq-fw", "cable l-peer1", "hq-core1:Ethernet51", "relation ipsec-muc", "route 0.0.0.0/0 via … (br-rtr)". */
export function refLabel(model: Model, ref: string): string {
  const id = ref.slice(ref.indexOf(':') + 1);
  if (ref.indexOf('device:') === 0) return id;
  if (ref.indexOf('link:') === 0) return 'cable ' + id;
  if (ref.indexOf('iface:') === 0) return id;
  if (ref.indexOf('relation:') === 0) {
    const r = model.index.relations.get(id);
    return r ? `${lookupProtocol(model.protocols, r.protocol, r.category).label} ${id}` : id;
  }
  if (ref.indexOf('network:') === 0) return 'network ' + id;
  if (ref.indexOf('route:') === 0) {
    const r = model.index.routes.get(id) as Route | undefined;
    return r ? `${routeText(r)} (${r.device})` : id;
  }
  return id;
}
