/**
 * Consistency checks: rules about the network the model describes, beyond
 * the format's own rules (validation/validate.ts). Each check has a stable
 * id, a default severity, a short title and a statement of exactly which
 * fields it reads. A check runs only on data that is present: where a value
 * it compares is missing, it says nothing (no default is assumed).
 *
 * A finding names the check, its severity, a message, every object it
 * concerns (refs such as "link:x", "iface:d:i", "route:d:3") and the place
 * to jump to (a ref and, where it is about one field, the field). Validation
 * attaches each finding to that place in the YAML file, so the Problems tab
 * and the Edit tab show it there.
 *
 * Findings are sorted by check, then by message and place, so they don't
 * depend on the order of the YAML file.
 */
import { endL2, isBridgePort, lagOf, portBadgeText, portL2, tagMismatch, vlanIds, vlanRangesText } from '../model/derive';
import { compareAddr, formatAddr, inPrefix, prefixText } from './ipmath';
import { parseAddress } from '../model/ip';
import { Interface, Link, LinkEnd, Model, Route, ifaceKey } from '../model/types';
import { MORE_CHECKS } from './checks-more';
import { SERVICE_CHECKS } from './checks-services';
import { MULTICAST_CHECKS } from './checks-multicast';
import { NETSERVICE_CHECKS } from './checks-netservices';
import { DEFAULT_STATIC_DISTANCE, connectedOf, isOwnAddress, resolveEntry, routeRef, routeText, staticEntry, vrfKey, vrfName } from './routing';

export type Severity = 'error' | 'warning' | 'info';
export const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info'];

/** Where a finding is shown and where "jump to" goes: an object, and the field of it the finding is about. */
export interface Target {
  ref: string;
  /** a key of that object's YAML entry ("via", "vlans" of a port, "a.speed" for an end of a link …) */
  field?: string;
}

export interface Finding {
  check: string;
  severity: Severity;
  message: string;
  /** every object the finding concerns, the target's first */
  refs: string[];
  at: Target;
}

type Emit = (f: { message: string; refs: string[]; at: Target }) => void;

export interface CheckDef {
  id: string;
  severity: Severity;
  /** what it finds, in a few words */
  title: string;
  /** the fields (and attrs keys) it reads */
  reads: string;
  run(model: Model, emit: Emit): void;
}

// ------------------------------------------------------------ static routes

/** Routes of the model, in model order. */
function allRoutes(model: Model): Route[] {
  const out: Route[] = [];
  for (const d of model.devices) out.push(...d.routes);
  return out;
}

const routeChecks: CheckDef[] = [
  {
    id: 'route-nexthop-self',
    severity: 'error',
    title: 'Next hop is the device’s own address',
    reads: 'routes: via; interfaces: ip',
    run(model, emit) {
      for (const r of allRoutes(model)) {
        const via = r.via !== undefined ? parseAddress(r.via) : null;
        if (!via || !isOwnAddress(model, r.device, via)) continue;
        const own = connectedOf(model, r.device).find((c) => compareAddr(c.addr, via) === 0);
        emit({
          message: `route ${routeText(r)} on ${r.device}: the next hop ${r.via} is an address of ${r.device} itself${own ? ` (${own.iface})` : ''}`,
          refs: [routeRef(r)].concat(own ? [`iface:${r.device}:${own.iface}`] : []),
          at: { ref: routeRef(r), field: 'via' },
        });
      }
    },
  },
  {
    id: 'route-nexthop-interface',
    severity: 'error',
    title: 'Next hop is not on the exit interface',
    reads: 'routes: via, interface; interfaces: ip',
    run(model, emit) {
      for (const r of allRoutes(model)) {
        const via = r.via !== undefined ? parseAddress(r.via) : null;
        if (!via || r.iface === undefined || isOwnAddress(model, r.device, via)) continue;
        const own = connectedOf(model, r.device).filter((c) => c.iface === r.iface);
        // an interface without an address of its own (unnumbered, a tunnel) can reach any next hop
        if (!own.length || own.some((c) => inPrefix(c.net, via))) continue;
        emit({
          message: `route ${routeText(r)} on ${r.device}: the next hop ${r.via} is not in a network of its exit interface ${r.iface} (${own.map((c) => prefixText(c.net)).join(', ')})`,
          refs: [routeRef(r), `iface:${r.device}:${r.iface}`],
          at: { ref: routeRef(r), field: 'via' },
        });
      }
    },
  },
  {
    id: 'route-nexthop-unresolved',
    severity: 'error',
    title: 'Next hop is not connected and does not resolve',
    reads: 'routes: prefix, via, interface, vrf, blackhole; interfaces: ip, vrf',
    run(model, emit) {
      for (const r of allRoutes(model)) {
        const via = r.via !== undefined ? parseAddress(r.via) : null;
        if (!via || r.iface !== undefined || isOwnAddress(model, r.device, via)) continue;
        const e = staticEntry(r);
        if (!e) continue;
        const res = resolveEntry(model, e);
        if (res.ok) continue;
        // connected in another table: say so, that is the usual cause
        const elsewhere = connectedOf(model, r.device).find((c) => c.vrf !== e.vrf && inPrefix(c.net, via));
        const why = elsewhere ? `${r.via} is in ${prefixText(elsewhere.net)} on ${elsewhere.iface}, which is in ${vrfName(elsewhere.vrf)}, not in ${vrfName(e.vrf)}` : res.detail;
        emit({
          message: `route ${routeText(r)} on ${r.device}: the next hop is not in a network directly connected to ${r.device} in ${vrfName(e.vrf)} and does not resolve through another route (${why})`,
          refs: [routeRef(r)].concat(elsewhere ? [`iface:${r.device}:${elsewhere.iface}`] : []),
          at: { ref: routeRef(r), field: 'via' },
        });
      }
    },
  },
  {
    id: 'route-nexthop-recursive',
    severity: 'info',
    title: 'Next hop resolves through another route',
    reads: 'routes: prefix, via, interface, vrf; interfaces: ip, vrf',
    run(model, emit) {
      for (const r of allRoutes(model)) {
        const via = r.via !== undefined ? parseAddress(r.via) : null;
        if (!via || r.iface !== undefined) continue;
        const e = staticEntry(r);
        if (!e) continue;
        const res = resolveEntry(model, e);
        if (!res.ok || !res.recursive) continue;
        emit({
          message: `route ${routeText(r)} on ${r.device}: the next hop ${r.via} is not directly connected; it resolves recursively and leaves through ${res.hops.map((h) => h.iface + (h.gateway ? ' to ' + formatAddr(h.gateway) : '')).join(', ')}`,
          refs: [routeRef(r)].concat(res.hops.map((h) => `iface:${r.device}:${h.iface}`)),
          at: { ref: routeRef(r), field: 'via' },
        });
      }
    },
  },
  {
    id: 'route-exit-interface',
    severity: 'error',
    title: 'Exit interface can’t forward the route',
    reads: 'routes: interface, vrf; interfaces: type, members, vrf; links (cabling)',
    run(model, emit) {
      for (const r of allRoutes(model)) {
        if (r.iface === undefined) continue;
        const i = model.index.interfaces.get(ifaceKey(r.device, r.iface));
        if (!i) continue;
        const d = model.index.devices.get(r.device);
        const agg = d ? d.logical.find((x) => x.members.indexOf(i.id) >= 0) : undefined;
        let why = '';
        if (i.type === 'loopback') why = `${i.id} is a loopback: nothing leaves the device through it`;
        else if (agg) why = `${i.id} is a member port of ${agg.id}: route through the aggregate ${agg.id}`;
        else if (i.type === 'physical' && !model.index.ifaceLink.has(ifaceKey(r.device, i.id))) why = `${i.id} is a physical port without a cable in the model`;
        else if (vrfKey(i.vrf) !== vrfKey(r.vrf)) why = `${i.id} is in ${vrfName(vrfKey(i.vrf))}, the route in ${vrfName(vrfKey(r.vrf))}`;
        if (!why) continue;
        emit({
          message: `route ${routeText(r)} on ${r.device}: ${why}`,
          refs: [routeRef(r), `iface:${r.device}:${i.id}`].concat(agg ? [`iface:${r.device}:${agg.id}`] : []),
          at: { ref: routeRef(r), field: 'interface' },
        });
      }
    },
  },
  {
    id: 'route-duplicate',
    severity: 'warning',
    title: 'The same route twice',
    reads: 'routes: prefix, via, interface, blackhole, distance, metric, vrf',
    run(model, emit) {
      for (const d of model.devices) {
        const seen = new Map<string, Route>();
        for (const r of d.routes) {
          const e = staticEntry(r);
          if (!e) continue;
          const key = [e.vrf, prefixText(e.net), e.via ? formatAddr(e.via) : '', e.iface || '', e.blackhole, r.distance === undefined ? '' : r.distance, r.metric === undefined ? '' : r.metric].join('|');
          const first = seen.get(key);
          if (!first) {
            seen.set(key, r);
            continue;
          }
          emit({
            message: `route ${routeText(r)} on ${d.id} is configured twice in ${vrfName(e.vrf)}`,
            refs: [routeRef(r), routeRef(first)],
            at: { ref: routeRef(r) },
          });
        }
      }
    },
  },
  {
    id: 'route-conflict',
    severity: 'warning',
    title: 'Routes to one prefix that contradict each other',
    reads: 'routes: prefix, via, interface, blackhole, distance, metric, vrf',
    run(model, emit) {
      for (const d of model.devices) {
        const groups = new Map<string, Route[]>();
        for (const r of d.routes) {
          const e = staticEntry(r);
          if (!e) continue;
          const key = e.vrf + '|' + prefixText(e.net) + '|' + e.distance;
          if (!groups.has(key)) groups.set(key, []);
          (groups.get(key) as Route[]).push(r);
        }
        groups.forEach((rs) => {
          if (rs.length < 2) return;
          const bh = rs.filter((r) => r.blackhole);
          const fw = rs.filter((r) => !r.blackhole);
          const dist = rs[0].distance !== undefined ? rs[0].distance : DEFAULT_STATIC_DISTANCE;
          if (bh.length && fw.length) {
            emit({
              message: `${d.id} has a blackhole route and a forwarding route to ${rs[0].prefix} with the same distance ${dist}${rs[0].vrf ? ' in VRF ' + rs[0].vrf : ''}: they can't both be used`,
              refs: rs.map(routeRef),
              at: { ref: routeRef(bh[0]) },
            });
          }
          // the same next hop with different metrics: one of them can never be used
          const byHop = new Map<string, Route[]>();
          for (const r of fw) {
            const k = (r.via || '') + '|' + (r.iface || '');
            if (!byHop.has(k)) byHop.set(k, []);
            (byHop.get(k) as Route[]).push(r);
          }
          byHop.forEach((same) => {
            const metrics = Array.from(new Set(same.map((r) => (r.metric === undefined ? 0 : r.metric))));
            if (metrics.length < 2) return;
            emit({
              message: `${d.id} has routes to ${same[0].prefix} via the same next hop with the same distance ${dist} but different metrics (${metrics.sort((a, b) => a - b).join(', ')})`,
              refs: same.map(routeRef),
              at: { ref: routeRef(same[1]), field: 'metric' },
            });
          });
        });
      }
    },
  },
];

// --------------------------------------------------------- VLAN tagging

function endRef(e: LinkEnd): string {
  return e.iface !== undefined ? `iface:${e.device}:${e.iface}` : 'device:' + e.device;
}

function endName(e: LinkEnd): string {
  return e.iface !== undefined ? `${e.device}:${e.iface}` : e.device;
}

/** VLAN IDs some part of the model defines: a network's `vlan` or a VLAN interface's `vlan`. */
export function definedVlans(model: Model): Set<number> {
  const s = new Set<number>();
  for (const n of model.networks) if (n.vlan !== undefined) s.add(n.vlan);
  for (const d of model.devices) for (const i of d.logical) if (i.vlan !== undefined) s.add(i.vlan);
  return s;
}

function linkRefs(l: Link): string[] {
  return ['link:' + l.id, endRef(l.a), endRef(l.b)];
}

/** The ref of the interface that holds a link end's VLANs (the aggregate of a member port), and its field. */
function vlanSource(model: Model, e: LinkEnd, field: 'vlans' | 'native' = 'vlans'): Target {
  const l = endL2(model, e);
  if (l && l.lag !== undefined) return { ref: `iface:${e.device}:${l.lag}`, field };
  return e.iface !== undefined ? { ref: `iface:${e.device}:${e.iface}`, field } : { ref: 'device:' + e.device };
}

/** The ports that hold VLANs: physical ports that are no aggregate member, and aggregates; in model order. */
function vlanPorts(model: Model): Array<{ device: string; iface: Interface }> {
  const out: Array<{ device: string; iface: Interface }> = [];
  for (const d of model.devices) {
    for (const i of d.interfaces) if (lagOf(model, d.id, i.id) === undefined) out.push({ device: d.id, iface: i });
    for (const i of d.logical) if (i.type === 'virtual' && i.members.length) out.push({ device: d.id, iface: i });
  }
  return out;
}

const vlanChecks: CheckDef[] = [
  {
    id: 'vlan-access-mismatch',
    severity: 'warning',
    title: 'Access ports in different VLANs at the two ends of a cable',
    reads: 'interfaces: vlans (of the ports at both ends of a link)',
    run(model, emit) {
      for (const l of model.links) {
        const m = tagMismatch(model, l);
        if (!m || !m.access) continue;
        emit({ message: `link ${l.id}: ${endName(l.a)} is an access port in VLAN ${m.access[0]}, ${endName(l.b)} in VLAN ${m.access[1]}: the cable joins the two VLANs (frames of one arrive in the other)`, refs: linkRefs(l), at: vlanSource(model, l.b) });
      }
    },
  },
  {
    id: 'vlan-trunk-mismatch',
    severity: 'warning',
    title: 'Trunks with different VLANs at the two ends of a cable',
    reads: 'interfaces: vlans (of the trunks at both ends of a link)',
    run(model, emit) {
      for (const l of model.links) {
        const m = tagMismatch(model, l);
        if (!m || (!m.onlyA.length && !m.onlyB.length)) continue;
        const parts = [m.onlyA.length ? `only ${endName(l.a)}: ${vlanRangesText(m.onlyA)}` : '', m.onlyB.length ? `only ${endName(l.b)}: ${vlanRangesText(m.onlyB)}` : ''].filter((x) => x);
        emit({ message: `link ${l.id}: the two trunks carry different VLANs (${parts.join('; ')}); a VLAN only one end allows is dropped by the other`, refs: linkRefs(l), at: vlanSource(model, m.onlyB.length ? l.b : l.a) });
      }
    },
  },
  {
    id: 'vlan-native-mismatch',
    severity: 'error',
    title: 'Native VLAN differs between the two trunks of a cable',
    reads: 'interfaces: vlans, native (of the trunks at both ends of a link)',
    run(model, emit) {
      for (const l of model.links) {
        const m = tagMismatch(model, l);
        if (!m || !m.native) continue;
        const t = (v: number | undefined): string => (v !== undefined ? `VLAN ${v}` : 'none (every VLAN tagged)');
        emit({ message: `link ${l.id}: the native VLAN is ${t(m.native[0])} at ${endName(l.a)} and ${t(m.native[1])} at ${endName(l.b)}: untagged frames of one end arrive in another VLAN at the other (or are dropped)`, refs: linkRefs(l), at: vlanSource(model, m.native[1] !== undefined ? l.b : l.a, 'native') });
      }
    },
  },
  {
    id: 'vlan-access-trunk',
    severity: 'warning',
    title: 'Access port cabled to a trunk whose native VLAN is another one',
    reads: 'interfaces: vlans, native (of the ports at both ends of a link)',
    run(model, emit) {
      for (const l of model.links) {
        const m = tagMismatch(model, l);
        if (!m || !m.accessTrunk) continue;
        const acc = m.accessTrunk.side === 'a' ? l.a : l.b;
        const tr = m.accessTrunk.side === 'a' ? l.b : l.a;
        const nat = m.accessTrunk.native;
        emit({
          message: `link ${l.id}: ${endName(acc)} is an access port in VLAN ${m.accessTrunk.vlan}, but ${endName(tr)} is a trunk ${nat !== undefined ? `whose native VLAN is ${nat}: its untagged frames are in VLAN ${nat} there` : 'without a native VLAN: it drops the untagged frames'}`,
          refs: linkRefs(l),
          at: vlanSource(model, tr, nat !== undefined ? 'native' : 'vlans'),
        });
      }
    },
  },
  {
    id: 'vlan-unknown',
    severity: 'warning',
    title: 'VLAN on a port that no network or VLAN interface defines (VLAN 1, the default, aside)',
    reads: 'interfaces: vlans; networks: vlan; logical_interfaces: vlan',
    run(model, emit) {
      // (VLAN 1 is every switch's default VLAN: it needs no network to exist)
      const known = definedVlans(model).add(1);
      for (const { device, iface } of vlanPorts(model)) {
        const missing = vlanIds(iface.vlans).filter((v) => !known.has(v));
        if (!missing.length) continue;
        emit({
          message: `${device}:${iface.id} carries VLAN${missing.length > 1 ? 's' : ''} ${vlanRangesText(missing)}, which no network and no VLAN interface of the model defines`,
          refs: [`iface:${device}:${iface.id}`],
          at: { ref: `iface:${device}:${iface.id}`, field: 'vlans' },
        });
      }
    },
  },
  {
    id: 'lag-member-vlans',
    severity: 'warning',
    title: 'Member ports of an aggregate whose far ends carry different VLANs',
    reads: 'logical_interfaces: members, vlans, native; interfaces: vlans, native (at the members’ far ends); links',
    run(model, emit) {
      for (const d of model.devices) {
        for (const g of d.logical) {
          if (g.type !== 'virtual' || !g.members.length) continue;
          const own = portL2(model, d.id, g.id);
          const far: Array<{ end: LinkEnd; text: string }> = [];
          for (const mid of g.members) {
            const lid = model.index.ifaceLink.get(ifaceKey(d.id, mid));
            const l = lid !== undefined ? model.index.links.get(lid) : undefined;
            if (!l) continue;
            const other = l.a.device === d.id && l.a.iface === mid ? l.b : l.a;
            const ol = endL2(model, other);
            if (!ol || !isBridgePort(ol)) continue;
            far.push({ end: other, text: portBadgeText(ol) });
          }
          if (!far.length || !own || !isBridgePort(own)) continue;
          const mine = portBadgeText(own);
          const odd = far.filter((x) => x.text !== mine);
          if (!odd.length) continue;
          emit({
            message: `aggregate ${d.id}:${g.id} (${mine}): its member${far.length > 1 ? 's’' : '’s'} far end${odd.length > 1 ? 's differ' : ' differs'}: ${odd.map((x) => `${endName(x.end)} (${x.text})`).join(', ')}; a bundle carries the same VLANs on every member`,
            refs: [`iface:${d.id}:${g.id}`].concat(odd.map((x) => endRef(x.end))),
            at: vlanSource(model, odd[0].end),
          });
        }
      }
    },
  },
];

// ------------------------------------------------------------- registry

/** Every check, in the order findings are listed. */
export const CHECKS: CheckDef[] = routeChecks.concat(vlanChecks, MORE_CHECKS, SERVICE_CHECKS, MULTICAST_CHECKS, NETSERVICE_CHECKS);

export function checkById(id: string): CheckDef | undefined {
  return CHECKS.find((c) => c.id === id);
}

/** What a model's `checks:` section says about one check: switched off, or another severity. */
export type CheckSetting = Severity | 'off';

/** Run every check that is not switched off; findings sorted by check, message and place. */
export function runChecks(model: Model, settings: Map<string, CheckSetting> = new Map()): Finding[] {
  const out: Finding[] = [];
  CHECKS.forEach((c) => {
    const set = settings.get(c.id);
    if (set === 'off') return;
    const severity = set || c.severity;
    const found: Finding[] = [];
    c.run(model, (f) => found.push({ check: c.id, severity, message: f.message, refs: f.refs, at: f.at }));
    found.sort((p, q) => cmp(p.message, q.message) || cmp(p.at.ref, q.at.ref) || cmp(p.at.field || '', q.at.field || ''));
    out.push(...found);
  });
  return out;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
