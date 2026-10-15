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
import { endVlans, tagMismatch, vlanIds, vlanRangesText } from '../model/derive';
import { compareAddr, formatAddr, inPrefix, prefixText } from './ipmath';
import { parseAddress } from '../model/ip';
import { Link, LinkEnd, Model, Route, ifaceKey } from '../model/types';
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
  /** a key of that object's YAML entry ("via", "a.untagged" for an end of a link …) */
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

const vlanChecks: CheckDef[] = [
  {
    id: 'vlan-native-mismatch',
    severity: 'error',
    title: 'Untagged (native) VLAN differs between the ends',
    reads: 'links: a/b mode, untagged',
    run(model, emit) {
      for (const l of model.links) {
        const m = tagMismatch(l.a, l.b);
        if (!m || !m.native) continue;
        emit({ message: `link ${l.id}: the untagged VLAN is ${m.native[0]} at ${endName(l.a)} and ${m.native[1]} at ${endName(l.b)}`, refs: linkRefs(l), at: { ref: 'link:' + l.id, field: 'b.untagged' } });
      }
    },
  },
  {
    id: 'vlan-tagged-mismatch',
    severity: 'warning',
    title: 'Tagged VLANs differ between the two trunk ends',
    reads: 'links: a/b mode, tagged',
    run(model, emit) {
      for (const l of model.links) {
        const m = tagMismatch(l.a, l.b);
        if (!m || (!m.onlyA.length && !m.onlyB.length)) continue;
        const parts = [m.onlyA.length ? `only at ${endName(l.a)}: ${vlanRangesText(m.onlyA)}` : '', m.onlyB.length ? `only at ${endName(l.b)}: ${vlanRangesText(m.onlyB)}` : ''].filter((x) => x);
        emit({ message: `link ${l.id}: the two ends tag different VLANs (${parts.join('; ')})`, refs: linkRefs(l), at: { ref: 'link:' + l.id, field: (m.onlyB.length ? 'b' : 'a') + '.tagged' } });
      }
    },
  },
  {
    id: 'vlan-access-tagged',
    severity: 'error',
    title: 'Access port with tagged VLANs',
    reads: 'links: a/b mode, tagged',
    run(model, emit) {
      for (const l of model.links) {
        for (const side of ['a', 'b'] as const) {
          const e = l[side];
          if (e.mode !== 'access' || !e.tagged.length) continue;
          emit({ message: `link ${l.id}: ${endName(e)} is an access port but tags VLANs ${vlanRangesText(vlanIds(e.tagged))}; an access port carries one untagged VLAN`, refs: ['link:' + l.id, endRef(e)], at: { ref: 'link:' + l.id, field: side + '.tagged' } });
        }
      }
    },
  },
  {
    id: 'vlan-untagged-tagged',
    severity: 'error',
    title: 'VLAN untagged at one end and tagged at the other',
    reads: 'links: a/b mode, untagged, tagged',
    run(model, emit) {
      for (const l of model.links) {
        const m = tagMismatch(l.a, l.b);
        if (!m || !m.crossed.length) continue;
        for (const v of m.crossed) {
          const untaggedAtA = l.a.untagged === v;
          emit({
            message: `link ${l.id}: VLAN ${v} is untagged at ${endName(untaggedAtA ? l.a : l.b)} and tagged at ${endName(untaggedAtA ? l.b : l.a)}`,
            refs: linkRefs(l),
            at: { ref: 'link:' + l.id, field: (untaggedAtA ? 'b' : 'a') + '.tagged' },
          });
        }
      }
    },
  },
  {
    id: 'vlan-unknown',
    severity: 'warning',
    title: 'VLAN on a port that no network or VLAN interface defines',
    reads: 'links: a/b untagged, tagged; networks: vlan; logical_interfaces: vlan',
    run(model, emit) {
      const known = definedVlans(model);
      for (const l of model.links) {
        for (const side of ['a', 'b'] as const) {
          const e = l[side];
          const missing = endVlans(e).filter((v) => !known.has(v));
          if (!missing.length) continue;
          emit({
            message: `link ${l.id}: ${endName(e)} carries VLAN${missing.length > 1 ? 's' : ''} ${vlanRangesText(missing)}, which no network and no VLAN interface of the model defines`,
            refs: ['link:' + l.id, endRef(e)],
            at: { ref: 'link:' + l.id, field: side + (e.untagged !== undefined && missing.indexOf(e.untagged) >= 0 ? '.untagged' : '.tagged') },
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
