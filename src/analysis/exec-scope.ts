/**
 * Execution scopes: what a simulation runs, apart from what is displayed
 * (the diagram's filters, the senders) and what an analysis evaluates. A
 * scope is a set of devices the simulation runs as a model of its own (a
 * sub-model): the devices outside it are not run at all — never frozen
 * and shown as participants, never answering — and the cables to them are
 * the scope's boundary, where traffic leaves the execution scope (the
 * engine says so where it drops it).
 *
 *   entire          every device;
 *   communication   the devices on a communication's evaluated paths (every
 *                   equal-cost path and the way back, the layer-2 devices
 *                   and a tunnel's underlay on the way);
 *   dependencies    a device and the providers of its configured
 *                   dependencies, with the devices on their way;
 *   group           the devices of a group (a site, a room, a rack: its
 *                   subgroups too);
 *   vlan            the devices that carry or are members of a VLAN;
 *   domain          a failure domain's members.
 *
 * What a scope needs to execute faithfully is added and said: the switches
 * between its routers' adjacencies, the routing domains whose routes its
 * paths use (every router of the protocol's connected adjacencies), the
 * DHCP and DNS providers of its devices that take addresses or names, and
 * the other members of its gateways' redundancy groups. What still stays
 * outside is listed as the boundary. When what was asked for can't run
 * faithfully in the scope (an end outside it), that is said instead of
 * running it. Pure and deterministic.
 */
import { Group, Interface, Link, Model, ModelIndex, Relation, deviceInterfaces, ifaceKey, relationDevices, routeKey } from '../model/types';
import { protocolBase } from '../model/protocols';
import { CommCheck } from './communication';
import { evaluateDependency, serviceDependencies } from './dependencies';
import { failureCondition } from './failure';
import { routingProtocol } from './routing';
import { Path } from './trace';
import { l2Domain, netOf } from './sim/net';

export type ExecScopeKind = 'entire' | 'communication' | 'dependencies' | 'group' | 'vlan' | 'domain';

export const EXEC_SCOPE_TEXT: { [k in ExecScopeKind]: string } = {
  entire: 'Entire model',
  communication: 'Selected communication',
  dependencies: 'Dependency slice',
  group: 'Site or group',
  vlan: 'VLAN',
  domain: 'Failure domain',
};

export interface ExecScope {
  kind: ExecScopeKind;
  /** "Selected communication: hmi → plc/registers" */
  label: string;
  /** the devices it runs */
  devices: Set<string>;
  /** what was added for it to run faithfully, and why */
  included: Array<{ device: string; why: string }>;
  /** the cables that lead out of it: the device and port inside, the device outside */
  boundary: Array<{ device: string; iface?: string; link: string; outside: string }>;
  /** relations to devices outside it: their sessions can't form in it */
  cutRelations: string[];
  /** what the scope can't execute faithfully (said, never run as if it could) */
  cannot: string[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The devices a path crosses: the hops, the layer-2 devices between them, a tunnel's underlay. */
function pathDevices(p: Path, out: Set<string>, depth = 0): void {
  for (const h of p.hops) {
    out.add(h.device);
    for (const x of h.l2) out.add(x);
    if (h.underlay && depth < 4) pathDevices(h.underlay, out, depth + 1);
  }
}

/**
 * Add what a set of devices needs to run faithfully (see the module
 * comment): routing domains whose routes are used, the switches between
 * adjacencies, DHCP and DNS providers, redundancy-group members.
 */
function closeOver(model: Model, seed: Set<string>, included: Array<{ device: string; why: string }>, protocolsUsed: Set<string>): Set<string> {
  const out = new Set(seed);
  const add = (d: string, why: string): void => {
    if (out.has(d) || !model.index.devices.has(d)) return;
    out.add(d);
    included.push({ device: d, why });
  };
  // the routing domains: every router of a protocol's connected adjacencies that touch the scope
  for (const p of Array.from(protocolsUsed).sort(cmp)) {
    const rels = model.relations.filter((r) => routingProtocol(model, r) === p);
    let grew = true;
    const domain = new Set<string>(Array.from(out).filter((d) => rels.some((r) => relationDevices(r).indexOf(d) >= 0)));
    while (grew) {
      grew = false;
      for (const r of rels) {
        const ds = relationDevices(r);
        if (!ds.some((d) => domain.has(d))) continue;
        for (const d of ds)
          if (!domain.has(d)) {
            domain.add(d);
            grew = true;
          }
      }
    }
    for (const d of Array.from(domain).sort(cmp)) add(d, `a router of the ${p.toUpperCase()} domain whose routes the scope uses`);
  }
  // redundancy groups: the other members of a gateway group on the scope's routers
  for (const r of model.relations) {
    const base = protocolBase(model.protocols, r.protocol);
    if (['vrrp', 'hsrp', 'glbp', 'carp'].indexOf(base) < 0) continue;
    const ds = relationDevices(r);
    if (ds.some((d) => out.has(d))) for (const d of ds) add(d, `a member of the ${base.toUpperCase()} group ${r.id}`);
  }
  // DHCP and DNS: the providers of the scope's devices (and the devices on their way)
  const deps = serviceDependencies(model).filter((d) => (d.kind === 'dhcp' || d.kind === 'dns') && seed.has(d.consumer));
  for (const d of deps) {
    const st = evaluateDependency(model, d);
    for (const ref of Array.from(st.refs).sort(cmp)) if (ref.indexOf('device:') === 0) add(ref.slice(7), `on the way to ${d.consumer}’s ${d.kind === 'dhcp' ? 'DHCP server' : 'resolver'}`);
    for (const o of d.options) if (o.provider) add(o.provider, `${d.consumer}’s ${d.kind === 'dhcp' ? 'DHCP server' : 'DNS server'}`);
  }
  // the switches between the scope's routed neighbours: their broadcast domains
  const net = netOf(model);
  for (const d of Array.from(out).sort(cmp)) {
    const dev = model.index.devices.get(d);
    for (const i of dev ? deviceInterfaces(dev) : []) {
      if (!i.addresses.length && !i.dhcp) continue;
      const dom = l2Domain(net, { dev: d, iface: i.id });
      const reachedIn = dom.reached.some((x) => x.dev !== d && out.has(x.dev));
      if (!reachedIn) continue;
      for (const b of dom.bridges) {
        const sd = net.devices.get(b.dev);
        const owner = sd && sd.virt ? sd.virt.owner : b.dev;
        add(owner, `bridges ${d}:${i.id} to its neighbours in the scope`);
      }
    }
  }
  return out;
}

/** The boundary and the cut relations of a set of devices. */
function finish(model: Model, kind: ExecScopeKind, label: string, devices: Set<string>, included: ExecScope['included'], cannot: string[]): ExecScope {
  const boundary: ExecScope['boundary'] = [];
  for (const l of model.links.slice().sort((a, b) => cmp(a.id, b.id))) {
    const ia = devices.has(l.a.device);
    const ib = devices.has(l.b.device);
    if (ia === ib) continue;
    const inside = ia ? l.a : l.b;
    const outside = ia ? l.b : l.a;
    boundary.push({ device: inside.device, iface: inside.iface, link: l.id, outside: outside.device });
  }
  const cutRelations = model.relations.filter((r) => {
    const ds = relationDevices(r);
    return ds.some((d) => devices.has(d)) && ds.some((d) => !devices.has(d));
  }).map((r) => r.id).sort(cmp);
  return { kind, label, devices, included: included.sort((a, b) => cmp(a.device, b.device)), boundary, cutRelations, cannot };
}

/** The entire model. */
export function entireScope(model: Model): ExecScope {
  return finish(model, 'entire', EXEC_SCOPE_TEXT.entire, new Set(model.devices.map((d) => d.id)), [], []);
}

/** The devices a communication check's evaluated paths need (see the module comment). */
export function communicationScope(model: Model, c: CommCheck): ExecScope {
  const seed = new Set<string>();
  const used = new Set<string>();
  const cannot: string[] = [];
  const paths = (c.trace ? c.trace.paths : []).concat(c.reverse ? c.reverse.trace.paths : []);
  for (const p of paths) {
    pathDevices(p, seed);
    for (const h of p.hops) {
      if (h.via.kind === 'dynamic' && h.via.relation) {
        const r = model.index.relations.get(h.via.relation);
        const proto = r ? routingProtocol(model, r) : null;
        if (proto) used.add(proto);
      }
    }
    if (p.end.kind === 'exits') cannot.push(`the path leaves the model at ${p.end.device}: what is beyond is not run in any scope`);
  }
  for (const g of c.legs) if (g.check.trace) for (const p of g.check.trace.paths) pathDevices(p, seed);
  if (c.from) seed.add(c.from.device);
  if (c.to && c.to.device) seed.add(c.to.device);
  if (!seed.size) cannot.push('the communication resolves to no device of the model');
  const included: ExecScope['included'] = [];
  const devices = closeOver(model, seed, included, used);
  return finish(model, 'communication', `${EXEC_SCOPE_TEXT.communication}: ${c.request.from} → ${c.request.to || 'its peer'}`, devices, included, cannot);
}

/** A device and its configured dependencies' providers, with the devices on their way. */
export function dependencyScope(model: Model, device: string): ExecScope {
  const seed = new Set<string>([device]);
  const included: ExecScope['included'] = [];
  for (const d of serviceDependencies(model).filter((x) => x.consumer === device)) {
    const st = evaluateDependency(model, d);
    for (const ref of Array.from(st.refs).sort(cmp)) if (ref.indexOf('device:') === 0) seed.add(ref.slice(7));
    for (const o of d.options) if (o.provider) seed.add(o.provider);
  }
  const used = new Set<string>();
  for (const r of model.relations) {
    const p = routingProtocol(model, r);
    if (p && relationDevices(r).some((x) => seed.has(x))) used.add(p);
  }
  const devices = closeOver(model, seed, included, used);
  return finish(model, 'dependencies', `${EXEC_SCOPE_TEXT.dependencies}: ${device}`, devices, included, []);
}

/** The devices of a group (and its subgroups). */
export function groupScope(model: Model, group: string): ExecScope {
  const groups = new Set<string>([group]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of model.groups as Group[])
      if (g.parent !== undefined && groups.has(g.parent) && !groups.has(g.id)) {
        groups.add(g.id);
        grew = true;
      }
  }
  const seed = new Set(model.devices.filter((d) => d.group !== undefined && groups.has(d.group)).map((d) => d.id));
  const g = model.index.groups.get(group);
  return finish(model, 'group', `${EXEC_SCOPE_TEXT.group}: ${g ? g.label || g.id : group}`, seed, [], seed.size ? [] : [`the group ${group} has no devices`]);
}

/** The devices that carry or are members of a VLAN (its ports, its VLAN interfaces, the hosts on its access ports). */
export function vlanScope(model: Model, vlan: number): ExecScope {
  const seed = new Set<string>();
  const net = netOf(model);
  for (const sd of net.devices.values()) {
    const owner = sd.virt ? sd.virt.owner : sd.id;
    for (const bp of sd.bridgePorts.values()) if (bp.vlans.untagged === vlan || (bp.vlans.tagged !== 'all' && bp.vlans.tagged.indexOf(vlan) >= 0)) seed.add(owner);
    for (const l of sd.l3.values()) if (l.vlan === vlan) seed.add(owner);
  }
  // the hosts on its access ports
  for (const d of Array.from(seed)) {
    const sd = net.devices.get(d);
    for (const bp of sd ? sd.bridgePorts.values() : []) {
      if (bp.vlans.untagged !== vlan || bp.vlans.mode !== 'access') continue;
      const dom = l2Domain(net, { dev: d, iface: bp.members[0], vlan });
      for (const r of dom.reached) seed.add(r.dev);
    }
  }
  return finish(model, 'vlan', `${EXEC_SCOPE_TEXT.vlan} ${vlan}`, seed, [], seed.size ? [] : [`no device carries VLAN ${vlan}`]);
}

/** A failure domain's members (its devices; a cable's or relation's ends). */
export function domainScope(model: Model, domain: string): ExecScope {
  const fc = failureCondition(model, [domain]);
  const seed = new Set<string>();
  for (const r of fc.refs) {
    if (r.indexOf('device:') === 0) seed.add(r.slice(7));
    const l = r.indexOf('link:') === 0 ? model.index.links.get(r.slice(5)) : undefined;
    if (l) [l.a.device, l.b.device].forEach((d) => seed.add(d));
  }
  return finish(model, 'domain', `${EXEC_SCOPE_TEXT.domain}: ${domain}`, seed, [], seed.size ? [] : [`the failure domain ${domain} names no device`]);
}

/**
 * The model a scope runs: its devices, the cables and relations between
 * them, the networks, groups and protocols as they are; the boundary named
 * (Model.execScope) so the engine says where traffic leaves the scope. The
 * entire scope is the model itself.
 */
export function scopedModel(model: Model, scope: ExecScope): Model {
  if (scope.kind === 'entire') return model;
  const keep = scope.devices;
  const devices = model.devices.filter((d) => keep.has(d.id));
  const links = model.links.filter((l) => keep.has(l.a.device) && keep.has(l.b.device));
  const relations = model.relations.filter((r: Relation) => relationDevices(r).every((d) => keep.has(d)));
  const interfaces = new Map<string, Interface>();
  for (const d of devices) for (const i of deviceInterfaces(d)) interfaces.set(ifaceKey(d.id, i.id), i);
  const ifaceLink = new Map<string, string>();
  const radioLinks = new Map<string, string[]>();
  for (const l of links as Link[]) {
    for (const e of [l.a, l.b]) {
      if (e.iface === undefined) continue;
      const k = ifaceKey(e.device, e.iface);
      if (!ifaceLink.has(k)) ifaceLink.set(k, l.id);
      const r = model.index.radioLinks.get(k);
      if (r) radioLinks.set(k, r.filter((x) => links.some((y) => y.id === x)));
    }
  }
  const routes = new Map<string, import('../model/types').Route>();
  for (const d of devices) for (const rt of d.routes) routes.set(routeKey(d.id, rt.index), rt);
  const index: ModelIndex = { groups: model.index.groups, devices: new Map(devices.map((d) => [d.id, d])), interfaces, links: new Map(links.map((l) => [l.id, l])), networks: model.index.networks, relations: new Map(relations.map((r) => [r.id, r])), ifaceLink, radioLinks, routes };
  const boundary = new Map<string, string>();
  for (const b of scope.boundary) if (b.iface !== undefined) boundary.set(ifaceKey(b.device, b.iface), b.outside);
  return { ...model, devices, links, relations, index, demands: model.demands.filter((x) => keep.has(x.source.split(':')[0]) && keep.has(x.destination.split(':')[0])), expectations: [], experiments: [], failureDomains: [], execScope: { label: scope.label, boundary } };
}
