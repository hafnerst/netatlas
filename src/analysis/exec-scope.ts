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
 * What every scope but the entire model needs to execute faithfully is
 * added and said, to a fixed point (each device added is examined in turn,
 * by a work queue): the routing domains of its routing relations (every
 * router of the protocol's connected adjacencies), the other members of
 * its redundancy groups, the DHCP and DNS providers it depends on (with
 * the devices on their way: relays, forwarders' routes), the other end
 * and the underlay of its tunnels, the host a virtual guest runs on, and
 * the switches that bridge it to the scope's other devices. Each addition
 * says why. What still stays outside is listed as the boundary. A relation
 * with more than two endpoints keeps its endpoints inside (a routing LAN,
 * a service's clients with their server inside) and says what it runs
 * without; a two-endpoint relation with an end outside is cut. Where what
 * is left out can change the outcome (a relation run without some of its
 * endpoints, cables shared with demands from outside), that is said as a
 * caveat: the scope's results are not claimed to be the entire model's.
 * When what was asked for can't run faithfully in the scope (an end outside
 * it), that is said instead of running it. Pure and deterministic.
 */
import { Group, Interface, Link, Model, ModelIndex, Relation, deviceInterfaces, ifaceKey, relationDevices, routeKey } from '../model/types';
import { protocolBase } from '../model/protocols';
import { CommCheck } from './communication';
import { evaluateDependency, serviceDependencies } from './dependencies';
import { failureCondition } from './failure';
import { routingProtocol } from './routing';
import { Path, tracePath } from './trace';
import { hostOf } from '../model/virtual';
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
  /** relations with more than two endpoints run with those inside: the relation, its endpoints left out */
  partialRelations: Array<{ relation: string; without: string[] }>;
  /** what the scope can't execute faithfully (said, never run as if it could) */
  cannot: string[];
  /** where what is left out can change the outcome: the scope's results may differ from the entire model's */
  caveats: string[];
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
 * comment), to a fixed point: every device added is examined for its own
 * dependencies in turn. `protocolsUsed`: routing protocols whose domains
 * the seed's paths use besides those of the routers' own relations.
 */
function closeOver(model: Model, seed: Set<string>, included: Array<{ device: string; why: string }>, protocolsUsed: Set<string>): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [];
  const add = (d: string, why: string | null): void => {
    if (out.has(d) || !model.index.devices.has(d)) return;
    out.add(d);
    if (why !== null) included.push({ device: d, why });
    queue.push(d);
  };
  for (const d of Array.from(seed).sort(cmp)) add(d, null);
  const rels = model.relations.slice().sort((a, b) => cmp(a.id, b.id));
  const deps = serviceDependencies(model).filter((d) => d.kind === 'dhcp' || d.kind === 'dns');
  const net = netOf(model);
  const domainDone = new Set<string>();
  const routingDomain = (p: string, from: string): void => {
    // every router of the protocol's connected relations from `from` (its routing domain)
    const k = p + '|' + from;
    if (domainDone.has(k)) return;
    domainDone.add(k);
    const prs = rels.filter((r) => routingProtocol(model, r) === p);
    const dom = new Set<string>([from]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of prs) {
        const ds = relationDevices(r);
        if (!ds.some((d) => dom.has(d))) continue;
        for (const d of ds)
          if (!dom.has(d)) {
            dom.add(d);
            grew = true;
          }
      }
    }
    for (const d of Array.from(dom).sort(cmp)) add(d, `a router of the ${p.toUpperCase()} domain of ${from} (its routes come from it)`);
  };
  const bridged = (): void => {
    // the switches between the scope's devices on one segment: their broadcast domains
    for (const d of Array.from(out).sort(cmp)) {
      const dev = model.index.devices.get(d);
      for (const i of dev ? deviceInterfaces(dev) : []) {
        if (!i.addresses.length && !i.dhcp) continue;
        const dom = l2Domain(net, { dev: d, iface: i.id });
        if (!dom.reached.some((x) => x.dev !== d && out.has(x.dev))) continue;
        for (const b of dom.bridges) {
          const sd = net.devices.get(b.dev);
          add(sd && sd.virt ? sd.virt.owner : b.dev, `bridges ${d}:${i.id} to its neighbours in the scope`);
        }
      }
    }
  };
  // (the seed's paths' routing protocols first: their domains from each seed router that takes part)
  for (const p of Array.from(protocolsUsed).sort(cmp)) for (const d of Array.from(seed).sort(cmp)) if (rels.some((r) => routingProtocol(model, r) === p && relationDevices(r).indexOf(d) >= 0)) routingDomain(p, d);
  for (;;) {
    while (queue.length) {
      const d = queue.shift() as string;
      for (const r of rels) {
        const ds = relationDevices(r);
        if (ds.indexOf(d) < 0) continue;
        const base = protocolBase(model.protocols, r.protocol);
        const p = routingProtocol(model, r);
        if (p) routingDomain(p, d);
        else if (['vrrp', 'hsrp', 'glbp', 'carp'].indexOf(base) >= 0) for (const x of ds) add(x, `a member of the ${base.toUpperCase()} group ${r.id} with ${d}`);
        else if (r.category === 'tunnel' || r.category === 'overlay') {
          // the tunnel's other end, what carries it (the relations it is over), and the devices on its underlay's way
          for (const x of ds) add(x, `the other end of ${d}'s tunnel ${r.id}`);
          for (const o of r.over) {
            const or = model.index.relations.get(o);
            if (or) for (const x of relationDevices(or)) add(x, `an end of ${o}, which carries ${d}'s tunnel ${r.id}`);
          }
          for (const x of ds) {
            if (x === d) continue;
            const tr = tracePath(model, { from: d, to: x });
            const on = new Set<string>();
            for (const pth of tr.paths) pathDevices(pth, on);
            for (const y of Array.from(on).sort(cmp)) add(y, `on the way of ${d}'s tunnel ${r.id} to ${x}`);
          }
        }
      }
      // the DHCP and DNS providers it depends on, and the devices on their way
      for (const dep of deps) {
        if (dep.consumer !== d) continue;
        for (const o of dep.options) if (o.provider) add(o.provider, `${d}’s ${dep.kind === 'dhcp' ? 'DHCP server' : 'DNS server'}`);
        const st = evaluateDependency(model, dep);
        for (const ref of Array.from(st.refs).sort(cmp)) if (ref.indexOf('device:') === 0) add(ref.slice(7), `on the way to ${d}’s ${dep.kind === 'dhcp' ? 'DHCP server' : 'resolver'}`);
      }
      // a virtual guest runs on its host (its virtual switch, its bridge)
      const h = hostOf(model, model.index.devices.get(d));
      if (h) add(h.id, `${d} runs on it`);
    }
    const before = out.size;
    bridged();
    if (out.size === before && !queue.length) break;
  }
  return out;
}

/** The routing protocols of the relations that touch a set of devices (their domains are closed over). */
function protocolsTouching(model: Model, seed: Set<string>): Set<string> {
  const used = new Set<string>();
  for (const r of model.relations) {
    const p = routingProtocol(model, r);
    if (p && relationDevices(r).some((x) => seed.has(x))) used.add(p);
  }
  return used;
}

/** Does a relation keep running with only the endpoints inside (more than two, two of them inside; a service: its server inside)? */
function keepsPartly(model: Model, r: Relation, devices: Set<string>): boolean {
  const ds = relationDevices(r);
  if (ds.length < 3) return false;
  const inside = ds.filter((d) => devices.has(d));
  if (inside.length < 2) return false;
  // a service relation's server is its last endpoint: its clients run only with it
  if (r.category === 'service' && !devices.has(ds[ds.length - 1])) return false;
  return true;
}

/** The boundary, the cut and partly kept relations, and the caveats of a set of devices. */
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
  const cutRelations: string[] = [];
  const partialRelations: ExecScope['partialRelations'] = [];
  for (const r of model.relations.slice().sort((a, b) => cmp(a.id, b.id))) {
    const ds = relationDevices(r);
    if (!ds.some((d) => devices.has(d)) || ds.every((d) => devices.has(d))) continue;
    if (keepsPartly(model, r, devices)) partialRelations.push({ relation: r.id, without: ds.filter((d) => !devices.has(d)).sort(cmp) });
    else cutRelations.push(r.id);
  }
  const caveats: string[] = [];
  if (kind !== 'entire') {
    for (const p of partialRelations) caveats.push(`${p.relation} runs without ${p.without.join(', ')}: an election, a flooding or a load share there can differ from the entire model's`);
    // cables of the scope that demands from outside it share: their load is not there in the scope
    const ext = model.demands.filter((d) => !devices.has(d.source.split(':')[0]) || !devices.has(d.destination.split(':')[0]));
    if (ext.length) caveats.push(`${ext.length} demand${ext.length === 1 ? '' : 's'} with an end outside (${ext.map((d) => d.id).sort(cmp).slice(0, 5).join(', ')}${ext.length > 5 ? ' …' : ''}) are not run: what they load in the scope is missing from it`);
  }
  return { kind, label, devices, included: included.sort((a, b) => cmp(a.device, b.device)), boundary, cutRelations, partialRelations, cannot, caveats };
}

/** Exactly these devices, nothing added (an explicit boundary): its cut and partly kept relations and caveats as any scope's. */
export function explicitScope(model: Model, label: string, devices: Set<string>): ExecScope {
  return finish(model, 'group', label, new Set(devices), [], devices.size ? [] : ['the scope names no device']);
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
  const devices = closeOver(model, seed, included, protocolsTouching(model, seed));
  return finish(model, 'dependencies', `${EXEC_SCOPE_TEXT.dependencies}: ${device}`, devices, included, []);
}

/**
 * Several scopes as one (an experiment's targets and their dependencies):
 * the devices any of them runs, what each added and why, and what any of
 * them can't run.
 */
export function unionScope(model: Model, label: string, scopes: ExecScope[]): ExecScope {
  const seed = new Set<string>();
  const included: ExecScope['included'] = [];
  const cannot: string[] = [];
  for (const s of scopes) {
    s.devices.forEach((d) => seed.add(d));
    for (const x of s.included) if (!included.some((y) => y.device === x.device)) included.push(x);
    for (const c of s.cannot) if (cannot.indexOf(c) < 0) cannot.push(c);
  }
  // (closed over again: together they may need more than each did; what was added already keeps its reason)
  const more: ExecScope['included'] = [];
  const devices = closeOver(model, seed, more, protocolsTouching(model, seed));
  for (const x of more) if (!included.some((y) => y.device === x.device)) included.push(x);
  return finish(model, 'dependencies', label, devices, included.filter((x) => devices.has(x.device)), cannot);
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
  const included: ExecScope['included'] = [];
  return finish(model, 'group', `${EXEC_SCOPE_TEXT.group}: ${g ? g.label || g.id : group}`, closeOver(model, seed, included, protocolsTouching(model, seed)), included, seed.size ? [] : [`the group ${group} has no devices`]);
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
  const included: ExecScope['included'] = [];
  return finish(model, 'vlan', `${EXEC_SCOPE_TEXT.vlan} ${vlan}`, closeOver(model, seed, included, protocolsTouching(model, seed)), included, seed.size ? [] : [`no device carries VLAN ${vlan}`]);
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
  const included: ExecScope['included'] = [];
  return finish(model, 'domain', `${EXEC_SCOPE_TEXT.domain}: ${domain}`, closeOver(model, seed, included, protocolsTouching(model, seed)), included, seed.size ? [] : [`the failure domain ${domain} names no device`]);
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
  // relations inside it, and those it keeps with their endpoints inside (their links and networks there)
  const partial = new Set(scope.partialRelations.map((p) => p.relation));
  const linkIds = new Set(links.map((l) => l.id));
  const relations: Relation[] = [];
  for (const r of model.relations) {
    if (relationDevices(r).every((d) => keep.has(d))) relations.push(r);
    else if (partial.has(r.id)) relations.push({ ...r, endpoints: r.endpoints.filter((e) => keep.has(e.device)), over: r.over.filter((o) => linkIds.has(o) || model.index.networks.has(o) || (model.index.relations.has(o) && relationDevices(model.index.relations.get(o) as Relation).every((d) => keep.has(d)))) });
  }
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
