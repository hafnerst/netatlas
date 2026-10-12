/**
 * Simulated traffic: the flows the model's configuration implies, in the
 * state a simulation step leaves (analysis/failure.ts) or as written. Pure,
 * DOM-free and deterministic (sorted by ids, never by the order of the file).
 * The UI animates them (ui/traffic.ts) and lists them as text.
 *
 *   * Control traffic of every relation that is up, by its protocol:
 *     routing adjacencies and BFD between their endpoints, both ways; a
 *     redundancy group's advertisements (VRRP, HSRP, GLBP, CARP) from its
 *     active member to the others; a service relation (DNS, syslog, NTP,
 *     AAA …) from its clients to its server, the last endpoint (and the
 *     replies back when it is bidirectional); tunnels, overlays, LACP, MLAG
 *     and the rest keepalives both ways. A unidirectional relation only
 *     from its first endpoint to its last. A relation of three or more
 *     devices (drawn with a hub): each member to the group and back.
 *   * Demands (the `demands:` section): traced with the path tracer from
 *     their source to their destination; equal-cost paths share the demand
 *     equally (an approximation). The dot rate grows with the bandwidth.
 *
 * Each flow names the drawn lines its dots run along, in both views:
 * relation lanes and hub spokes and network membership lines (logical),
 * cables with their direction (physical: the underlay of the relations and
 * the cables of the demands' paths, a tunnel's traced underlay included).
 * A unidirectional cable only ever carries traffic from end a to end b.
 * Traffic without a path is lost where it stops. trafficDiff compares two
 * states: what was rerouted, lost or restored, and what stopped or resumed.
 */
import { FailureResult } from './failure';
import { virtualGateways } from './identity';
import { RoutingCtx } from './routing';
import { Hop, Path, Trace, declaredUnderlay, endText, tracePath, vipHolder } from './trace';
import { protocolBase, relationStyle } from '../model/protocols';
import { Model, Relation, relationDevices } from '../model/types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** At most this many traces for the control traffic's underlay (larger models: the declared `over` cables only). */
export const MAX_CONTROL_TRACES = 400;

/**
 * A drawn line a dot runs along, and which way. Logical: a relation's lane
 * between two devices (`from`, `to`: the devices), a hub spoke (`from` or
 * `to` is "hub"), a network's membership line (`from` or `to` is "net").
 * Physical: a cable, from end `from` ("a" or "b") to end `to`.
 */
export interface Track {
  ref: string;
  from: string;
  to: string;
}

export type FlowKind = 'control' | 'demand';

export interface Flow {
  /** stable: "rel:<relation>:<from>><to>" or "dem:<demand>:<path>" */
  id: string;
  kind: FlowKind;
  /** what it belongs to: "relation:<id>" or "demand:<id>" */
  of: string;
  /** "OSPF hellos", "Demand Web to the server" */
  label: string;
  /** the protocol (control) or traffic class (demand), as text */
  what: string;
  /** dots per second on each track (relative) */
  rate: number;
  /** bits per second (demands: the share of this path) */
  bps?: number;
  /** the share of the demand this path carries (equal-cost paths split it equally) */
  share: number;
  logical: Track[];
  physical: Track[];
  /** lost: no way to the destination (stops at `stop`) */
  state: 'up' | 'lost';
  stop?: { device: string; text: string };
  /** the devices on the way, in order */
  devices: string[];
  /** "w-host → w1 → c1 → c3 → e1 → e-srv: reached e-srv" */
  pathText: string;
}

export interface TrafficState {
  flows: Flow[];
}

/** How fast a demand's dots come: more for more bandwidth (logarithmic), less for a share of it. */
export function demandRate(bps: number, share: number): number {
  const base = 0.6 + 0.7 * Math.log10(1 + bps / 1e6);
  return Math.round(Math.max(0.4, Math.min(4.5, base * Math.max(0.35, share))) * 100) / 100;
}

/** Control traffic: a steady, slow stream. */
export const CONTROL_RATE = 0.45;

const GATEWAY = ['vrrp', 'hsrp', 'glbp', 'carp'];

/** "a" or "b": the end of a cable at a device ('' when neither or both). */
function endAt(model: Model, linkId: string, device: string): 'a' | 'b' | '' {
  const l = model.index.links.get(linkId);
  if (!l) return '';
  if (l.a.device === device && l.b.device !== device) return 'a';
  if (l.b.device === device && l.a.device !== device) return 'b';
  return '';
}

/**
 * Cables in the order a path crosses them, oriented by walking from
 * `start`: at each step the next cable (in the order given, else any) at
 * the device reached so far, leaving from its end there; a cable parallel
 * to the one just taken (a LAG member) runs the same way. Cables the walk
 * never reaches run both ways (their order is unknown). A unidirectional
 * cable is only ever used from end a to end b.
 */
export function orientCables(model: Model, links: string[], start: string): Track[] {
  const out: Track[] = [];
  const push = (id: string, from: 'a' | 'b'): void => {
    const l = model.index.links.get(id);
    if (!l) return;
    if (l.direction === 'unidirectional' && from === 'b') return;
    if (!out.some((t) => t.ref === 'link:' + id && t.from === from)) out.push({ ref: 'link:' + id, from, to: from === 'a' ? 'b' : 'a' });
  };
  const left = links.filter((id, i) => model.index.links.has(id) && links.indexOf(id) === i);
  let cur = start;
  let last: { from: string; to: string } | null = null;
  for (;;) {
    // first the other members of a LAG just crossed (the same two devices: the same way), then the way on
    const lt: { from: string; to: string } | null = last;
    let k: number = lt
      ? left.findIndex((id) => {
          const l = model.index.links.get(id)!;
          return (l.a.device === lt.from && l.b.device === lt.to) || (l.b.device === lt.from && l.a.device === lt.to);
        })
      : -1;
    const parallel = k >= 0;
    if (k < 0) k = left.findIndex((id) => endAt(model, id, cur) !== '');
    if (k < 0) break;
    const id: string = left.splice(k, 1)[0];
    const l = model.index.links.get(id)!;
    if (parallel && last) {
      push(id, l.a.device === last.from ? 'a' : 'b');
      continue;
    }
    const e = endAt(model, id, cur) as 'a' | 'b';
    push(id, e);
    const far = e === 'a' ? l.b.device : l.a.device;
    last = { from: cur, to: far };
    cur = far;
  }
  for (const id of left) {
    push(id, 'a');
    push(id, 'b');
  }
  return out;
}

/** The cables of a traced path from its first device, a tunnel's traced underlay included, in order. */
function pathCables(model: Model, p: Path): Track[] {
  const out: Track[] = [];
  const add = (ts: Track[]): void => {
    for (const t of ts) if (!out.some((x) => x.ref === t.ref && x.from === t.from)) out.push(t);
  };
  for (const h of p.hops) {
    if (h.underlay) add(pathCables(model, h.underlay));
    if (h.links.length) add(orientCables(model, h.links, h.device));
  }
  return out;
}

/** The logical lines of one hop to the next device: the relations it used between the two (a tunnel's stack included), else the network both are in. */
function hopTracks(model: Model, h: Hop, next: string | undefined): Track[] {
  if (!next || next === h.device) return [];
  const out: Track[] = [];
  for (const id of h.relations.slice().sort(cmp)) {
    const r = model.index.relations.get(id);
    if (!r) continue;
    const ds = relationDevices(r);
    if (ds.indexOf(h.device) < 0 || ds.indexOf(next) < 0) continue;
    out.push(...relationTracks(r, h.device, next));
  }
  if (out.length) return out;
  for (const n of h.networks.slice().sort(cmp)) out.push({ ref: 'network:' + n, from: h.device, to: 'net' }, { ref: 'network:' + n, from: 'net', to: next });
  return out;
}

/** The lines of a relation from one of its devices to another: its lane, or the two spokes through its hub. */
function relationTracks(r: Relation, from: string, to: string): Track[] {
  const ref = 'relation:' + r.id;
  if (relationDevices(r).length <= 2) return [{ ref, from, to }];
  return [
    { ref, from, to: 'hub' },
    { ref, from: 'hub', to },
  ];
}

/** The text of an endpoint for the tracer: "device:interface" or "device". */
function endTextOf(r: Relation, device: string): string {
  const e = r.endpoints.find((x) => x.device === device);
  return e && e.iface ? `${device}:${e.iface}` : device;
}

interface Ctx {
  model: Model;
  ctx: RoutingCtx;
  res: FailureResult | null;
  traces: Map<string, Trace>;
  budget: number;
}

function trace(c: Ctx, from: string, to: string): Trace | null {
  const key = from + '\n' + to;
  const known = c.traces.get(key);
  if (known) return known;
  if (c.budget <= 0) return null;
  c.budget--;
  const t = tracePath(c.model, { from, to }, c.ctx);
  c.traces.set(key, t);
  return t;
}

const reached = (p: Path): boolean => p.end.kind !== 'stopped';

/**
 * The cables under a relation's traffic from `s` to `t`: the way the tracer
 * takes between the two endpoints (a tunnel's underlay included), else the
 * cables the relation is declared `over` (down through its carriers).
 */
function relationCables(c: Ctx, r: Relation, s: string, t: string): Track[] {
  const tr = trace(c, endTextOf(r, s), endTextOf(r, t));
  if (tr && !tr.error && tr.paths.length && reached(tr.paths[0])) {
    const ts = pathCables(c.model, tr.paths[0]);
    if (ts.length) return ts;
  }
  const declared = declaredUnderlay(c.model, r).links.filter((l) => !c.res || c.res.links.get(l) !== 'down');
  return orientCables(c.model, declared, s);
}

const deviceUp = (c: Ctx, d: string): boolean => !c.res || c.res.devices.get(d) !== 'down';

/** Is a relation's endpoint at a device up: the device, and the interface it names (a VLAN interface whose ports are down is not)? */
function endpointUp(c: Ctx, r: Relation, d: string): boolean {
  if (!deviceUp(c, d)) return false;
  if (!c.res) return true;
  const ends = r.endpoints.filter((e) => e.device === d);
  return ends.some((e) => e.iface === undefined || c.res!.ifaces.get(d + ':' + e.iface) !== 'down');
}

/** The active member of a redundancy group relation (by its virtual address), else its first device that is up. */
function activeMember(c: Ctx, r: Relation, devices: string[]): string {
  for (const e of r.endpoints) {
    const vg = virtualGateways(c.model).find((g) => g.device === e.device && (e.iface === undefined || g.iface === e.iface));
    if (!vg) continue;
    const h = vipHolder(c.model, vg.address, c.ctx, null);
    if (h && devices.indexOf(h.holder.device) >= 0) return h.holder.device;
  }
  return devices[0];
}

/** The control flows of one relation that is up. */
function controlFlows(c: Ctx, r: Relation): Flow[] {
  if (c.res && c.res.relations.get(r.id) === 'down') return [];
  const def = relationStyle(c.model, r);
  const base = protocolBase(c.model.protocols, r.protocol);
  const all = relationDevices(r);
  const devs = all.filter((d) => endpointUp(c, r, d));
  if (devs.length < 2) return [];
  const pairs: Array<[string, string]> = [];
  let what = def.label;
  if (r.direction === 'unidirectional') {
    const first = all[0];
    const last = all[all.length - 1];
    if (devs.indexOf(first) >= 0 && devs.indexOf(last) >= 0 && first !== last) pairs.push([first, last]);
  } else if (GATEWAY.indexOf(base) >= 0) {
    const active = activeMember(c, r, devs);
    for (const d of devs) if (d !== active) pairs.push([active, d]);
    what = `${def.label} advertisements from ${active}`;
  } else if (r.category === 'service') {
    const server = all[all.length - 1];
    if (devs.indexOf(server) >= 0) for (const d of devs) if (d !== server) pairs.push([d, server], [server, d]);
  } else if (all.length > 2) {
    // each member to the group and back, over the hub
    return devs.flatMap((d) => [hubFlow(c, r, d, true, def.label), hubFlow(c, r, d, false, def.label)]);
  } else pairs.push([devs[0], devs[1]], [devs[1], devs[0]]);
  if (r.category === 'service' && r.direction !== 'unidirectional') what = `${def.label} (client → ${all[all.length - 1]} and replies)`;
  return pairs.map(([s, t]) => ({
    id: `rel:${r.id}:${s}>${t}`,
    kind: 'control' as FlowKind,
    of: 'relation:' + r.id,
    label: `${r.id}: ${s} → ${t}`,
    what,
    rate: CONTROL_RATE,
    share: 1,
    logical: relationTracks(r, s, t),
    physical: relationCables(c, r, s, t),
    state: 'up' as const,
    devices: [s, t],
    pathText: `${s} → ${t}`,
  }));
}

/** A member of a multipoint relation to the group (`out`) or the group to it. */
function hubFlow(c: Ctx, r: Relation, d: string, out: boolean, what: string): Flow {
  const others = relationDevices(r).filter((x) => x !== d && endpointUp(c, r, x));
  const physical: Track[] = [];
  for (const o of others) {
    for (const t of out ? relationCables(c, r, d, o) : relationCables(c, r, o, d)) if (!physical.some((x) => x.ref === t.ref && x.from === t.from)) physical.push(t);
  }
  return {
    id: `rel:${r.id}:${out ? d + '>hub' : 'hub>' + d}`,
    kind: 'control',
    of: 'relation:' + r.id,
    label: `${r.id}: ${out ? d + ' → the group' : 'the group → ' + d}`,
    what,
    rate: CONTROL_RATE,
    share: 1,
    logical: [{ ref: 'relation:' + r.id, from: out ? d : 'hub', to: out ? 'hub' : d }],
    physical,
    state: 'up',
    devices: [d],
    pathText: out ? `${d} → ${others.join(', ')}` : `${others.join(', ')} → ${d}`,
  };
}

/** The flows of one demand: one per equal-cost path (each its share), or one lost flow. */
function demandFlows(c: Ctx, id: string): Flow[] {
  const dm = c.model.demands.find((x) => x.id === id);
  if (!dm) return [];
  const tr = tracePath(c.model, { from: dm.source, to: dm.destination }, c.ctx);
  const head = { kind: 'demand' as FlowKind, of: 'demand:' + dm.id, what: dm.class || 'demand' };
  if (tr.error || !tr.paths.length) {
    const dev = tr.source ? tr.source.device : '';
    return [
      {
        ...head,
        id: `dem:${dm.id}:0`,
        label: `${dm.label} (${dm.bandwidth})`,
        rate: demandRate(dm.bps, 1),
        bps: dm.bps,
        share: 1,
        logical: [],
        physical: [],
        state: 'lost',
        stop: { device: dev, text: tr.error || 'no path' },
        devices: dev ? [dev] : [],
        pathText: `${dm.source} → ${dm.destination}: ${tr.error || 'no path'}`,
      },
    ];
  }
  const n = tr.paths.length;
  const dest = tr.dest ? tr.dest.address : dm.destination;
  return tr.paths.map((p, i) => {
    const devices = p.hops.map((h) => h.device);
    const logical: Track[] = [];
    p.hops.forEach((h, k) => {
      for (const t of hopTracks(c.model, h, p.hops[k + 1] ? p.hops[k + 1].device : undefined)) logical.push(t);
    });
    const lost = p.end.kind === 'stopped';
    const flow: Flow = {
      ...head,
      id: `dem:${dm.id}:${i}`,
      label: `${dm.label} (${dm.bandwidth}${n > 1 ? `, path ${i + 1} of ${n}: ${fmtShare(1 / n)}` : ''})`,
      rate: demandRate(dm.bps, 1 / n),
      bps: dm.bps / n,
      share: 1 / n,
      logical,
      physical: pathCables(c.model, p),
      state: lost ? 'lost' : 'up',
      devices,
      pathText: `${devices.join(' → ')}: ${endText(p.end, dest)}`,
    };
    if (p.end.kind === 'stopped') flow.stop = { device: p.end.device, text: p.end.detail };
    return flow;
  });
}

const fmtShare = (x: number): string => `${Math.round(x * 1000) / 10} %`;

/** The traffic in a state (null: the model as written). */
export function trafficFlows(model: Model, res: FailureResult | null): TrafficState {
  const c: Ctx = { model, ctx: res ? res.ctx : {}, res, traces: new Map(), budget: MAX_CONTROL_TRACES };
  const flows: Flow[] = [];
  for (const r of model.relations.slice().sort((a, b) => cmp(a.id, b.id))) flows.push(...controlFlows(c, r));
  for (const d of model.demands.map((x) => x.id).sort(cmp)) flows.push(...demandFlows(c, d));
  flows.sort((a, b) => (a.kind === b.kind ? cmp(a.id, b.id) : a.kind === 'demand' ? -1 : 1));
  return { flows };
}

/** One change of the traffic from one state to the next. */
export interface TrafficChange {
  /** "relation:<id>" or "demand:<id>" */
  of: string;
  kind: 'rerouted' | 'lost' | 'restored' | 'stopped' | 'resumed';
  /** the lines of the old way (rerouted: shown faded for a moment) */
  before: { logical: Track[]; physical: Track[] };
  /** the lines of the new way (rerouted: emphasized for a moment) */
  after: { logical: Track[]; physical: Track[] };
  text: string;
}

const trackKey = (t: Track): string => `${t.ref}|${t.from}>${t.to}`;

function tracksOf(flows: Flow[]): { logical: Track[]; physical: Track[] } {
  const seen = new Set<string>();
  const logical: Track[] = [];
  const physical: Track[] = [];
  for (const f of flows) {
    for (const t of f.logical) if (!seen.has('L' + trackKey(t)) && seen.add('L' + trackKey(t))) logical.push(t);
    for (const t of f.physical) if (!seen.has('P' + trackKey(t)) && seen.add('P' + trackKey(t))) physical.push(t);
  }
  return { logical, physical };
}

function sameTracks(a: { logical: Track[]; physical: Track[] }, b: { logical: Track[]; physical: Track[] }): boolean {
  const k = (x: { logical: Track[]; physical: Track[] }): string => x.logical.map(trackKey).sort().join(',') + '/' + x.physical.map(trackKey).sort().join(',');
  return k(a) === k(b);
}

/** What changed from `prev` to `cur`, per demand and relation (sorted: demands first, then by id). */
export function trafficDiff(prev: TrafficState, cur: TrafficState): TrafficChange[] {
  const group = (s: TrafficState): Map<string, Flow[]> => {
    const m = new Map<string, Flow[]>();
    for (const f of s.flows) {
      if (!m.has(f.of)) m.set(f.of, []);
      (m.get(f.of) as Flow[]).push(f);
    }
    return m;
  };
  const a = group(prev);
  const b = group(cur);
  const keys = Array.from(new Set(Array.from(a.keys()).concat(Array.from(b.keys())))).sort((x, y) => (x.indexOf('demand:') === 0) === (y.indexOf('demand:') === 0) ? cmp(x, y) : x.indexOf('demand:') === 0 ? -1 : 1);
  const out: TrafficChange[] = [];
  for (const of of keys) {
    const was = a.get(of) || [];
    const now = b.get(of) || [];
    const name = of.slice(of.indexOf(':') + 1);
    const wasUp = was.filter((f) => f.state === 'up');
    const nowUp = now.filter((f) => f.state === 'up');
    const before = tracksOf(wasUp);
    const after = tracksOf(nowUp);
    if (of.indexOf('demand:') === 0) {
      if (wasUp.length && !nowUp.length) {
        const s = now.find((f) => f.stop);
        out.push({ of, kind: 'lost', before, after, text: `Demand ${name} is lost${s && s.stop ? ` at ${s.stop.device}: ${s.stop.text}` : ''}` });
      } else if (!wasUp.length && nowUp.length && was.length) out.push({ of, kind: 'restored', before, after, text: `Demand ${name} is delivered again: ${nowUp.map((f) => f.devices.join(' → ')).join('; ')}` });
      else if (wasUp.length && nowUp.length && !sameTracks(before, after)) out.push({ of, kind: 'rerouted', before, after, text: `Demand ${name} is rerouted: ${nowUp.map((f) => f.devices.join(' → ')).join('; ')} (was ${wasUp.map((f) => f.devices.join(' → ')).join('; ')})` });
      else if (wasUp.length && nowUp.length && wasUp.length !== nowUp.length) out.push({ of, kind: 'rerouted', before, after, text: `Demand ${name} now takes ${nowUp.length} equal-cost path${nowUp.length === 1 ? '' : 's'} (was ${wasUp.length})` });
    } else {
      if (was.length && !now.length) out.push({ of, kind: 'stopped', before, after, text: `${name}: its traffic stopped` });
      else if (!was.length && now.length) out.push({ of, kind: 'resumed', before, after, text: `${name}: its traffic resumed` });
      else if (was.length && now.length && !sameTracks(before, after)) out.push({ of, kind: 'rerouted', before, after, text: `${name}: its traffic takes other cables` });
    }
  }
  return out;
}
