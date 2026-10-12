/**
 * Scenario templates (Simulate → Scenario templates…): each looks at the
 * model, says why it doesn't apply or proposes concrete steps for it, which
 * the user reviews and saves as a normal scenario. Pure, DOM-free and
 * deterministic: a proposal depends on the model only (never on the order
 * of the file), and ties are broken by ids.
 */
import { Spof, simulate, singlePointsOfFailure } from './failure';
import { virtualGateways } from './identity';
import { compareAddr, formatAddr } from './ipmath';
import { relParam } from './routing';
import { declaredUnderlay, isAsymmetric, returnRequest, tracePath, vipHolder } from './trace';
import { groupDevices, lagCables, riskGroupIds, riskMembers } from './scenario';
import { routingRole } from '../model/device-types';
import { protocolBase, relationStyle } from '../model/protocols';
import { Model, Relation, ScenarioStep, StepAction, TargetKind, relationDevices } from '../model/types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface TemplateDef {
  id: string;
  label: string;
  /** what it simulates, in one sentence */
  summary: string;
}

/** The templates, in the order the menu lists them. */
export const TEMPLATES: TemplateDef[] = [
  { id: 'wan-uplink', label: 'WAN / ISP uplink outage', summary: 'Fail the primary uplink of a dual-homed site and see the failover (BGP, a floating static route, a backup tunnel).' },
  { id: 'fhrp', label: 'First-hop redundancy failover', summary: 'Fail the active member of a VRRP / HSRP group and see the gateway move.' },
  { id: 'core', label: 'Core or spine failure', summary: 'Fail a core or spine device and see the paths that remain.' },
  { id: 'location', label: 'Site, room or rack loss', summary: 'Fail every device of a location at once, as in a power outage.' },
  { id: 'srlg', label: 'Shared-risk fibre cut', summary: 'Fail everything in one risk group and reveal redundancy that isn’t real.' },
  { id: 'rolling', label: 'Rolling maintenance of a redundant pair', summary: 'Take the first member out of service, restore it, then the second, checking for loss at each step.' },
  { id: 'flap', label: 'Link flapping', summary: 'Fail and restore one cable twice and see the routes change at each step.' },
  { id: 'vpn', label: 'VPN / tunnel failover', summary: 'Fail the primary tunnel (IPsec, GRE …) between two sites and see the backup tunnel take over.' },
  { id: 'lag', label: 'MLAG peer-link or LAG member loss', summary: 'Fail the member cables of a LAG one at a time until fewer than min_links are left.' },
  { id: 'service', label: 'Service server failure', summary: 'Fail a DNS, NTP, syslog or AAA server and see which clients lose the service.' },
  { id: 'asymmetric', label: 'Asymmetric routing check', summary: 'Fail a cable on a demand’s path and compare the way there with the way back.' },
];

/** A template's proposal for a model: the steps to review, or why it doesn't apply. */
export interface Proposal {
  template: string;
  label: string;
  applicable: boolean;
  /** why it doesn't apply ('' when it does) */
  reason: string;
  /** the scenario's proposed name and description */
  name: string;
  description: string;
  steps: ScenarioStep[];
  /** what to look at while playing it */
  notes: string[];
}

const step = (action: StepAction, kind: TargetKind, id: string, note?: string): ScenarioStep => {
  const s: ScenarioStep = { action, target: { kind, id }, line: 0 };
  if (note) s.note = note;
  return s;
};

const no = (t: TemplateDef, reason: string): Proposal => ({ template: t.id, label: t.label, applicable: false, reason, name: '', description: '', steps: [], notes: [] });

/** The location groups that hold devices, with the devices of each (nested groups included). */
function locations(model: Model): Array<{ id: string; kind: string; label: string; devices: string[] }> {
  return model.groups
    .map((g) => ({ id: g.id, kind: g.kind, label: g.label, devices: groupDevices(model, g.id) }))
    .filter((g) => g.devices.length)
    .sort((a, b) => cmp(a.id, b.id));
}

const isProvider = (model: Model, device: string): boolean => {
  const d = model.index.devices.get(device);
  if (!d) return false;
  if (d.type === 'cloud') return true;
  const g = d.group ? model.index.groups.get(d.group) : undefined;
  return !!g && /^(provider|carrier|isp|external)$/.test(g.kind);
};

/** The cables between a set of devices and the rest (sorted by id). */
function leaving(model: Model, inside: Set<string>): Array<{ id: string; near: string; far: string }> {
  const out: Array<{ id: string; near: string; far: string }> = [];
  for (const l of model.links.slice().sort((a, b) => cmp(a.id, b.id))) {
    const ia = inside.has(l.a.device);
    const ib = inside.has(l.b.device);
    if (ia === ib) continue;
    out.push({ id: l.id, near: ia ? l.a.device : l.b.device, far: ia ? l.b.device : l.a.device });
  }
  return out;
}

const speedOf = (model: Model, id: string): number => {
  const l = model.index.links.get(id);
  const m = l && l.speed ? /^([0-9.]+)\s*([kMGT]?)/i.exec(l.speed) : null;
  if (!m) return 0;
  return parseFloat(m[1]) * ({ '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 } as { [k: string]: number })[m[2].toLowerCase()];
};

/** The cables of a demand's main path, in order (empty when it can't be traced). */
function demandCables(model: Model, d: { source: string; destination: string }): string[] {
  const tr = tracePath(model, { from: d.source, to: d.destination });
  if (tr.error || !tr.paths.length || tr.paths[0].end.kind === 'stopped') return [];
  const out: string[] = [];
  const walk = (p: typeof tr.paths[0]): void => {
    for (const h of p.hops) {
      if (h.underlay) walk(h.underlay);
      for (const l of h.links) if (out.indexOf(l) < 0) out.push(l);
    }
  };
  walk(tr.paths[0]);
  return out;
}

// ------------------------------------------------------------ the templates

function wanUplink(model: Model, t: TemplateDef): Proposal {
  // dual-homed: a site (or campus, building) with two or more cables leaving it, or two uplinks to providers or clouds;
  // first those with provider uplinks, then a site where demands start, then the larger, then by id
  const starts = new Set(model.demands.map((d) => d.source.split(':')[0]));
  const cands = locations(model)
    .filter((g) => g.devices.length < model.devices.length)
    .map((g) => {
      const ups = leaving(model, new Set(g.devices));
      const wan = ups.filter((u) => isProvider(model, u.far));
      return { g, ups: wan.length >= 2 ? wan : ups, wan: wan.length >= 2, src: g.devices.some((d) => starts.has(d)) };
    })
    .filter((x) => x.ups.length >= 2 && (x.wan || /^(site|campus|building)$/.test(x.g.kind)))
    .sort((a, b) => Number(b.wan) - Number(a.wan) || Number(b.src) - Number(a.src) || b.g.devices.length - a.g.devices.length || cmp(a.g.id, b.g.id));
  if (!cands.length) return no(t, 'No dual-homed site in this model (a site, campus or building with two or more cables leaving it, or two uplinks to providers)');
  const { g, ups } = cands[0];
  // the primary: the uplink the site's traffic takes now (the first demand leaving the site), else the fastest, then by id
  const inside = new Set(g.devices);
  let primary = '';
  for (const d of model.demands.slice().sort((a, b) => cmp(a.id, b.id))) {
    const src = d.source.split(':')[0];
    if (!inside.has(src) && !model.devices.some((x) => inside.has(x.id) && x.interfaces.concat(x.logical).some((i) => i.addresses.some((a) => a.split('/')[0] === d.source)))) continue;
    const used = demandCables(model, d).find((l) => ups.some((u) => u.id === l));
    if (used) {
      primary = used;
      break;
    }
  }
  if (!primary) primary = ups.slice().sort((a, b) => speedOf(model, b.id) - speedOf(model, a.id) || cmp(a.id, b.id))[0].id;
  const backups = ups.filter((u) => u.id !== primary).map((u) => u.id);
  return {
    template: t.id,
    label: t.label,
    applicable: true,
    reason: '',
    name: `Uplink outage at ${g.label}`,
    description: `The primary uplink of ${g.label} (${primary}) fails; ${backups.join(', ')} ${backups.length === 1 ? 'is' : 'are'} left.`,
    steps: [step('fail', 'cable', primary, `the uplink of ${g.label} that its traffic takes`)],
    notes: [`Look at what fails over: BGP sessions, floating static routes and backup tunnels over ${backups.join(', ')} (Simulation tab, Changed by this step), and at the paths (Trace path, Traffic).`],
  };
}

function fhrp(model: Model, t: TemplateDef): Proposal {
  const vgs = virtualGateways(model);
  const groups = new Map<string, typeof vgs>();
  for (const g of vgs) {
    const k = formatAddr(g.address);
    if (!groups.has(k)) groups.set(k, []);
    (groups.get(k) as typeof vgs).push(g);
  }
  const multi = Array.from(groups.entries())
    .filter(([, gs]) => new Set(gs.map((x) => x.device)).size >= 2)
    .sort((a, b) => compareAddr(a[1][0].address, b[1][0].address));
  if (!multi.length) return no(t, 'No VRRP / HSRP group with two or more members in this model');
  const [vip, members] = multi[0];
  const h = vipHolder(model, members[0].address, {}, null);
  const active = h ? h.holder.device : members[0].device;
  const next = members.map((m) => m.device).filter((d) => d !== active).sort(cmp)[0];
  const svc = (model.services.get(members[0].service) || { label: members[0].service }).label;
  return {
    template: t.id,
    label: t.label,
    applicable: true,
    reason: '',
    name: `${svc} failover of ${vip}`,
    description: `The active member of the ${svc} group of ${vip} (${active}) fails; the gateway moves to ${next}.`,
    steps: [step('fail', 'device', active, `the active member of ${vip}`)],
    notes: [`The ${svc} relation shows Degraded — fails over; Trace path from a host behind ${vip} leaves through ${next}. With Traffic on, the advertisements now come from ${next}.`],
  };
}

function core(model: Model, t: TemplateDef): Proposal {
  const degree = new Map<string, number>();
  for (const l of model.links) for (const d of [l.a.device, l.b.device]) degree.set(d, (degree.get(d) || 0) + 1);
  const cands = model.devices
    .filter((d) => (d.type === 'router' || d.type === 'switch') && (degree.get(d.id) || 0) >= 2)
    .map((d) => {
      const g = d.group ? model.index.groups.get(d.group) : undefined;
      return { d, named: /core|spine/i.test(`${d.id} ${d.label} ${g ? g.id + ' ' + g.label : ''}`), deg: degree.get(d.id) || 0 };
    })
    .filter((x) => x.named || x.deg >= 3)
    .sort((a, b) => Number(b.named) - Number(a.named) || b.deg - a.deg || cmp(a.d.id, b.d.id));
  if (!cands.length) return no(t, 'No core or spine device in this model (a router or switch named core or spine, or with three or more cables)');
  const d = cands[0].d;
  return {
    template: t.id,
    label: t.label,
    applicable: true,
    reason: '',
    name: `Loss of ${d.id}`,
    description: `The ${cands[0].named ? 'core / spine' : 'most connected'} device ${d.id} fails (${cands[0].deg} cables).`,
    steps: [step('fail', 'device', d.id)],
    notes: ['See which equal-cost paths remain (Trace path lists them; the Traffic section shows the demands’ paths) and which device pairs lose reachability. Remaining capacity is not computed yet: the model has no load analysis.'],
  };
}

const KIND_RANK = ['rack', 'room', 'floor', 'zone', 'building', 'campus', 'site'];

function location(model: Model, t: TemplateDef): Proposal {
  const rank = (k: string): number => {
    const i = KIND_RANK.indexOf(k);
    return i < 0 ? KIND_RANK.length : i;
  };
  const cands = locations(model)
    .filter((g) => g.devices.length < model.devices.length && !/^(provider|carrier|isp|external)$/.test(g.kind))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.devices.length - a.devices.length || cmp(a.id, b.id));
  if (!cands.length) return no(t, 'No location (site, room, rack …) with devices that is not the whole network');
  const g = cands[0];
  return {
    template: t.id,
    label: t.label,
    applicable: true,
    reason: '',
    name: `Loss of ${g.label}`,
    description: `Every device of the ${g.kind || 'location'} ${g.label} fails at once (${g.devices.length}: ${g.devices.join(', ')}), as in a power outage.`,
    steps: [step('fail', 'group', g.id, 'e.g. a power outage')],
    notes: ['See what the rest of the network loses: device pairs, relations through the location, demands that are lost.'],
  };
}

function srlg(model: Model, t: TemplateDef): Proposal {
  const cands = riskGroupIds(model)
    .map((id) => ({ id, members: riskMembers(model, id) }))
    .filter((x) => x.members.length >= 2)
    .sort((a, b) => b.members.length - a.members.length || cmp(a.id, b.id));
  if (!cands.length) return no(t, 'No risk group shared by two or more cables, ports or devices (list it in their risk_groups)');
  const r = cands[0];
  return {
    template: t.id,
    label: t.label,
    applicable: true,
    reason: '',
    name: `Shared-risk failure: ${r.id}`,
    description: `Everything in risk group ${r.id} fails at once: ${r.members.map((m) => m.slice(m.indexOf(':') + 1)).join(', ')}.`,
    steps: [step('fail', 'risk', r.id, 'e.g. a cut conduit or a lost power feed')],
    notes: ['Redundancy that shares this risk isn’t real: whatever is lost here was redundant only on paper (see the device pairs and demands that are lost).'],
  };
}

/** Redundant pairs: the members of a VRRP / HSRP group, the two ends of an MLAG or HA relation. */
function pairs(model: Model): Array<{ a: string; b: string; what: string }> {
  const out: Array<{ a: string; b: string; what: string }> = [];
  const seen = new Set<string>();
  const add = (x: string, y: string, what: string): void => {
    const [a, b] = x < y ? [x, y] : [y, x];
    if (a === b || seen.has(a + '\n' + b)) return;
    seen.add(a + '\n' + b);
    out.push({ a, b, what });
  };
  for (const r of model.relations.slice().sort((p, q) => cmp(p.id, q.id))) {
    const base = protocolBase(model.protocols, r.protocol);
    const ds = relationDevices(r);
    if (ds.length !== 2) continue;
    if (['vrrp', 'hsrp', 'glbp', 'carp', 'mlag', 'ha-sync'].indexOf(base) >= 0) add(ds[0], ds[1], relationStyle(model, r).label);
  }
  return out;
}

function rolling(model: Model, t: TemplateDef): Proposal {
  const ps = pairs(model);
  if (!ps.length) return no(t, 'No redundant pair in this model (a VRRP / HSRP group, an MLAG or HA pair of two devices)');
  const p = ps[0];
  return {
    template: t.id,
    label: t.label,
    applicable: true,
    reason: '',
    name: `Rolling maintenance of ${p.a} and ${p.b}`,
    description: `${p.a} and ${p.b} (${p.what}) are taken out of service one after the other for planned maintenance.`,
    steps: [step('maintain', 'device', p.a, 'drain the first member'), step('restore', 'device', p.a), step('maintain', 'device', p.b, 'then the second'), step('restore', 'device', p.b)],
    notes: ['At each step: is anything lost (device pairs, demands)? If not, the window can go ahead as planned. Cost-out (draining by raising the routing cost first) is not simulated: maintenance takes the device out of service at once.'],
  };
}

/**
 * Cables whose failure alone cuts devices off (partitioning single points of
 * failure), as a set of link ids. A cable that only takes down a relation
 * riding on it (a point-to-point OSPF adjacency) is not one here: routing
 * can go around it.
 */
function spofCables(spofs: Spof[]): Set<string> {
  const s = new Set<string>();
  for (const p of spofs) if (p.kind === 'cable' && p.isolated.length) s.add(p.ref.slice(5));
  return s;
}

/** For each cable: how many relations ride over it (down through their carriers). */
function carried(model: Model): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of model.relations) for (const l of declaredUnderlay(model, r).links) m.set(l, (m.get(l) || 0) + 1);
  return m;
}

function flap(model: Model, t: TemplateDef, spofs: Spof[]): Proposal {
  const single = spofCables(spofs);
  let cable = '';
  let why = '';
  for (const d of model.demands.slice().sort((a, b) => cmp(a.id, b.id))) {
    const c = demandCables(model, d).find((l) => !single.has(l));
    if (c) {
      cable = c;
      why = `on the path of demand ${d.id}`;
      break;
    }
  }
  if (!cable) {
    const n = carried(model);
    const best = Array.from(n.entries())
      .filter(([l]) => !single.has(l))
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0];
    if (best) {
      cable = best[0];
      why = `${best[1]} relation${best[1] === 1 ? '' : 's'} ride over it`;
    }
  }
  if (!cable) return no(t, 'No redundant cable that carries traffic (every cable that carries a relation or a demand is a single point of failure)');
  return {
    template: t.id,
    label: t.label,
    applicable: true,
    reason: '',
    name: `Flapping cable ${cable}`,
    description: `Cable ${cable} (${why}) goes down and up twice.`,
    steps: [step('fail', 'cable', cable, 'down'), step('restore', 'cable', cable, 'up'), step('fail', 'cable', cable, 'down again'), step('restore', 'cable', cable, 'up again')],
    notes: ['Each step changes the routes back and forth: see Changed by this step and, with demands, the reroutes in the Traffic section. Protocol timers and dampening are not simulated.'],
  };
}

/** The lowest cost of the routing relations carried (directly or deeper) over a relation (Infinity: none). */
function carriedCost(model: Model, tunnel: Relation): number {
  let best = Infinity;
  for (const r of model.relations) {
    if (r === tunnel || declaredUnderlay(model, r).relations.indexOf(tunnel.id) < 0) continue;
    const v = relParam(r, 'cost', relationDevices(r)[0]);
    const c = v === undefined ? NaN : Number(v);
    best = Math.min(best, isNaN(c) ? 1 : c);
  }
  return best;
}

function vpn(model: Model, t: TemplateDef): Proposal {
  // the outer tunnels (not carried over another relation) between each pair of devices
  const byPair = new Map<string, Relation[]>();
  for (const r of model.relations) {
    if (r.category !== 'tunnel' || r.over.some((o) => model.index.relations.has(o))) continue;
    const ds = relationDevices(r).slice().sort(cmp);
    if (ds.length !== 2) continue;
    const k = ds.join('\n');
    if (!byPair.has(k)) byPair.set(k, []);
    (byPair.get(k) as Relation[]).push(r);
  }
  const cands = Array.from(byPair.entries())
    .filter(([, rs]) => rs.length >= 2)
    .sort((a, b) => cmp(a[0], b[0]));
  if (!cands.length) return no(t, 'No two sites joined by two tunnel paths (a primary and a backup tunnel between the same devices)');
  const [key, rs] = cands[0];
  const [a, b] = key.split('\n');
  const ranked = rs.slice().sort((x, y) => carriedCost(model, x) - carriedCost(model, y) || cmp(x.id, y.id));
  const primary = ranked[0];
  const backup = ranked.slice(1).map((r) => r.id);
  return {
    template: t.id,
    label: t.label,
    applicable: true,
    reason: '',
    name: `Tunnel failover ${a} – ${b}`,
    description: `The primary tunnel between ${a} and ${b} (${primary.id}${isFinite(carriedCost(model, primary)) ? ', carrying the cheaper routing adjacency' : ''}) fails; ${backup.join(', ')} ${backup.length === 1 ? 'is' : 'are'} left.`,
    steps: [step('fail', 'relation', primary.id, 'the primary tunnel path')],
    notes: [`What rides over ${primary.id} goes down with it (GRE, the routing adjacency); the routes now lead over ${backup.join(', ')}: Trace path between the two sites shows the backup tunnel.`],
  };
}

function lag(model: Model, t: TemplateDef): Proposal {
  const peerLinked = new Set<string>();
  for (const r of model.relations) {
    const base = protocolBase(model.protocols, r.protocol);
    if (base === 'mlag' || base === 'lacp') for (const e of r.endpoints) if (e.iface) peerLinked.add(e.device + ':' + e.iface);
  }
  const cands: Array<{ id: string; cables: string[]; min: number; peer: boolean }> = [];
  for (const d of model.devices)
    for (const i of d.logical) {
      if (!i.members.length) continue;
      const id = d.id + ':' + i.id;
      const c = lagCables(model, id);
      // (a min_links above the members it has: it is down from the start, nothing to take away one at a time)
      if (typeof c === 'string' || c.length < 2 || (i.minLinks || 1) > c.length) continue;
      cands.push({ id, cables: c, min: i.minLinks || 1, peer: peerLinked.has(id) && routingRole(d.type) !== 'host' });
    }
  cands.sort((a, b) => Number(b.peer) - Number(a.peer) || b.cables.length - a.cables.length || cmp(a.id, b.id));
  if (!cands.length) return no(t, 'No LAG with two or more cabled member ports in this model');
  const g = cands[0];
  // fail members one at a time until fewer than min_links are up
  const n = Math.min(g.cables.length, g.cables.length - g.min + 1);
  const steps = g.cables.slice(0, n).map((l, k) => step('fail', 'cable', l, k === n - 1 ? `fewer than ${g.min} member${g.min === 1 ? '' : 's'} up: the LAG goes down` : `${g.cables.length - k - 1} of ${g.cables.length} members left`));
  return {
    template: t.id,
    label: t.label,
    applicable: true,
    reason: '',
    name: `${g.peer ? 'Peer-link' : 'LAG'} member loss on ${g.id}`,
    description: `The member cables of ${g.id} fail one at a time (min_links ${g.min}): degraded while enough are up, then down.`,
    steps,
    notes: ['Each step until the last: the LAG and its relation are Degraded (fewer members, less capacity); the last one takes them down.'],
  };
}

const BUILTIN_SERVICES = new Set(['dns', 'ntp', 'syslog', 'snmp', 'radius', 'dhcp', 'https', 'netflow']);

function service(model: Model, t: TemplateDef): Proposal {
  const byServer = new Map<string, Relation[]>();
  for (const r of model.relations) {
    // the services NetAtlas knows (DNS, NTP, syslog, SNMP, RADIUS / TACACS+, DHCP …), not a protocol of the model's own
    if (r.category !== 'service' || relationStyle(model, r).custom || !BUILTIN_SERVICES.has(protocolBase(model.protocols, r.protocol))) continue;
    const ds = relationDevices(r);
    if (ds.length < 2) continue;
    const server = ds[ds.length - 1];
    if (!byServer.has(server)) byServer.set(server, []);
    (byServer.get(server) as Relation[]).push(r);
  }
  const cands = Array.from(byServer.entries()).sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0]));
  if (!cands.length) return no(t, 'No service relation (DNS, NTP, syslog, AAA …) in this model');
  const [server, rels] = cands[0];
  const notes: string[] = [];
  for (const r of rels.slice().sort((a, b) => cmp(a.id, b.id))) {
    const ds = relationDevices(r);
    const clients = ds.filter((d) => d !== server);
    const label = relationStyle(model, r).label;
    const base = protocolBase(model.protocols, r.protocol);
    const others = Array.from(byServer.keys()).filter((s) => s !== server && (byServer.get(s) as Relation[]).some((x) => protocolBase(model.protocols, x.protocol) === base));
    notes.push(`${label} (${r.id}): ${clients.join(', ')} lose${clients.length === 1 ? 's' : ''} it${others.length ? `; another ${label} server remains: ${others.join(', ')} (check that it is reachable: Trace path)` : `; no other ${label} server in the model`}.`);
  }
  return {
    template: t.id,
    label: t.label,
    applicable: true,
    reason: '',
    name: `Loss of server ${server}`,
    description: `${server}, the server of ${rels.map((r) => r.id).sort(cmp).join(', ')}, fails.`,
    steps: [step('fail', 'device', server)],
    notes,
  };
}

function asymmetric(model: Model, t: TemplateDef, spofs: Spof[]): Proposal {
  if (!model.demands.length) return no(t, 'No traffic demands in this model (the check compares their way there and their way back)');
  const single = spofCables(spofs);
  // a cable on a demand's path whose failure keeps the demand delivered; best one after which the way back differs
  let found: { cable: string; demand: string; asym: boolean } | null = null;
  for (const d of model.demands.slice().sort((a, b) => cmp(a.id, b.id))) {
    for (const c of demandCables(model, d)) {
      if (single.has(c)) continue;
      const ctx = simulate(model, ['link:' + c]).ctx;
      const there = tracePath(model, { from: d.source, to: d.destination }, ctx);
      if (there.error || !there.paths.length || there.paths[0].end.kind === 'stopped') continue;
      const rq = returnRequest(there);
      const back = rq ? tracePath(model, rq, ctx) : null;
      const asym = !!back && isAsymmetric(there, back);
      if (!found || (asym && !found.asym)) found = { cable: c, demand: d.id, asym };
      if (asym) break;
    }
    if (found && found.asym) break;
  }
  if (!found) return no(t, 'No cable on a demand’s path can fail and leave the demand delivered');
  return {
    template: t.id,
    label: t.label,
    applicable: true,
    reason: '',
    name: `Asymmetric routing after ${found.cable} fails`,
    description: `Cable ${found.cable} on the path of demand ${found.demand} fails; the demand is still delivered${found.asym ? ', but the way back differs from the way there' : ''}: compare the two.`,
    steps: [step('fail', 'cable', found.cable, `on the path of ${found.demand}`)],
    notes: [`The Traffic section says for each demand whether the way back takes the same devices (Returns the same way) or another (Asymmetric); Trace path with “Trace the return path too” shows both hop by hop.`],
  };
}

/** Every template's proposal for a model, in the menu's order. */
export function proposeAll(model: Model): Proposal[] {
  const spofs = singlePointsOfFailure(model);
  return TEMPLATES.map((t) => propose(model, t.id, spofs) as Proposal);
}

/** One template's proposal (null: no such template). */
export function propose(model: Model, id: string, spofs?: Spof[]): Proposal | null {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return null;
  const sp = (): Spof[] => spofs || singlePointsOfFailure(model);
  switch (id) {
    case 'wan-uplink':
      return wanUplink(model, t);
    case 'fhrp':
      return fhrp(model, t);
    case 'core':
      return core(model, t);
    case 'location':
      return location(model, t);
    case 'srlg':
      return srlg(model, t);
    case 'rolling':
      return rolling(model, t);
    case 'flap':
      return flap(model, t, sp());
    case 'vpn':
      return vpn(model, t);
    case 'lag':
      return lag(model, t);
    case 'service':
      return service(model, t);
    case 'asymmetric':
      return asymmetric(model, t, sp());
  }
  return null;
}
