/**
 * Capacity, bounded: does the traffic the model states fit the capacity it
 * states, in the configured model and under a failure? An architecture
 * check, not a performance simulation: no queues, delay, microbursts,
 * hardware forwarding limits or QoS.
 *
 *   demands     the model's \`demands:\` (a rate between two ends), and the
 *               applications that state a periodic rate: an interval
 *               written, with their sizes (written, else the profile's
 *               modelling defaults) (a UDP sender's payload,
 *               a client's request and answer, an MQTT publisher's payload
 *               to its broker and on to each matching subscriber).
 *               Payload rates: headers are not added. No demand
 *               information means not evaluated, never zero load.
 *   resources   physical capacity, counted once: a cable (its speed; VLANs,
 *               subinterfaces and tunnels riding it share it), an
 *               aggregate (the speeds of its members that are up; a single
 *               flow is limited to one member), a radio (its Wi-Fi
 *               associations share it). A cable without a speed has an
 *               unknown capacity.
 *   paths       each demand is traced (the path tracer, in the failure's
 *               state); a tunnel's traffic rides its underlay's cables.
 *
 * How a demand spreads over equal-cost paths or a bundle's members is not
 * modeled, so it is not assumed: each resource is evaluated with the
 * demand split equally over the evaluated paths and with all of it on any
 * one path. It fits when it fits even then; it exceeds when even the equal
 * split exceeds; in between the outcome depends on the distribution. A
 * demand larger than one member of an aggregate fits only as several
 * flows. Pure and deterministic.
 */
import { APP_DEFAULTS, appProfile, topicMatches } from '../model/applications';
import { bpsText, parseSpeed } from '../model/speed';
import { Model } from '../model/types';
import { RoutingCtx } from './routing';
import { Path, Trace, tracePath } from './trace';

export interface CapDemand {
  id: string;
  label: string;
  from: string;
  to: string;
  bps: number;
  /** where it is stated */
  source: 'demand' | 'application';
  ref: string;
}

export interface CapResource {
  /** "link:l1", "lag:sw1:ae0", "radio:ap1:wlan0" */
  id: string;
  what: string;
  /** bits per second; null: not known (no speed written) */
  capacity: number | null;
  /** an aggregate: the most one flow can use (one member) */
  perFlow?: number;
  /** an aggregate: its members up and in all */
  members?: { up: number; total: number };
  refs: string[];
}

export type CapVerdict = 'fits' | 'exceeds' | 'distribution' | 'unknown';

export interface ResourceLoad {
  resource: CapResource;
  /** with the demands split equally over their evaluated paths, and with each wholly on any one path */
  equal: number;
  worst: number;
  verdict: CapVerdict;
  demands: string[];
}

export interface DemandResult {
  demand: CapDemand;
  connectivity: 'retained' | 'lost' | 'unknown';
  verdict: CapVerdict | 'not-applicable';
  /** the resource that decides it (the tightest), in words */
  text: string;
  /** a single flow larger than an aggregate member on its way */
  perFlow?: string;
  paths: number;
}

export interface CapacityResult {
  evaluated: boolean;
  demands: DemandResult[];
  loads: ResourceLoad[];
  text: string;
  assumptions: string[];
}

export { bpsText };

/** The traffic the model states (see the module comment), sorted by id. */
export function capacityDemands(model: Model): CapDemand[] {
  const out: CapDemand[] = [];
  for (const d of model.demands) out.push({ id: 'demand:' + d.id, label: d.label || d.id, from: d.source, to: d.destination, bps: d.bps, source: 'demand', ref: 'demand:' + d.id });
  for (const dev of model.devices) {
    for (const a of dev.applications || []) {
      const p = appProfile(a.profile);
      if (!p || a.interval === undefined || a.interval <= 0) continue;
      const per = 8000 / a.interval;
      const ref = `app:${dev.id}/${a.id}`;
      if (p.id === 'udp_sender' && a.peer) out.push({ id: ref, label: `${dev.id}/${a.id}`, from: dev.id, to: a.peer.indexOf('/') > 0 ? a.peer.slice(0, a.peer.indexOf('/')) : a.peer, bps: (a.requestSize || APP_DEFAULTS.udpRequest) * per, source: 'application', ref });
      else if ((p.id === 'tcp_client' || p.id === 'udp_client') && a.peer) {
        const to = a.peer.indexOf('/') > 0 ? a.peer.slice(0, a.peer.indexOf('/')) : a.peer;
        out.push({ id: ref + '>', label: `${dev.id}/${a.id} (requests)`, from: dev.id, to, bps: (a.requestSize || (p.id === 'tcp_client' ? APP_DEFAULTS.tcpRequest : APP_DEFAULTS.udpRequest)) * per, source: 'application', ref });
        out.push({ id: ref + '<', label: `${dev.id}/${a.id} (answers)`, from: to, to: dev.id, bps: (a.responseSize || (p.id === 'tcp_client' ? APP_DEFAULTS.tcpResponse : APP_DEFAULTS.udpResponse)) * per, source: 'application', ref });
      } else if (p.id === 'mqtt_client' && a.broker && a.publish.length) {
        out.push({ id: ref + '>', label: `${dev.id}/${a.id} (publish)`, from: dev.id, to: a.broker, bps: (a.payloadSize || APP_DEFAULTS.mqttPayload) * per, source: 'application', ref });
        for (const sd of model.devices) {
          for (const sa of sd.applications || []) {
            if (sa.profile !== 'mqtt_client' || sa.broker !== a.broker || (sd.id === dev.id && sa.id === a.id)) continue;
            if (!a.publish.some((t) => sa.subscribe.some((f) => topicMatches(f, t)))) continue;
            out.push({ id: `${ref}>${sd.id}/${sa.id}`, label: `${dev.id}/${a.id} → ${sd.id}/${sa.id} (via ${a.broker})`, from: a.broker, to: sd.id, bps: (a.payloadSize || APP_DEFAULTS.mqttPayload) * per, source: 'application', ref });
          }
        }
      }
    }
  }
  return out.filter((d) => d.bps > 0).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** A cable's speed: the link's, else the smaller of its ends' (null: none written). */
function linkSpeed(model: Model, id: string): number | null {
  const l = model.index.links.get(id);
  if (!l) return null;
  const own = parseSpeed(l.speed);
  if (own !== null) return own;
  const ends = [parseSpeed(l.a.speed), parseSpeed(l.b.speed)].filter((x): x is number => x !== null);
  return ends.length ? Math.min(...ends) : null;
}

/**
 * The physical resource a cable belongs to: its aggregate (by the
 * aggregate one of its ends is a member of), its radio (a wireless
 * association), else the cable itself.
 */
function resourceOf(model: Model, linkId: string, linkUp: (id: string) => boolean): CapResource {
  const l = model.index.links.get(linkId);
  if (!l) return { id: 'link:' + linkId, what: linkId, capacity: null, refs: ['link:' + linkId] };
  // a radio's associations share it
  if (l.medium === 'wireless') {
    for (const e of [l.a, l.b]) {
      const d = model.index.devices.get(e.device);
      if (!d || !d.wireless || e.iface === undefined) continue;
      const assoc = model.links.filter((x) => x.medium === 'wireless' && [x.a, x.b].some((y) => y.device === e.device && y.iface === e.iface));
      const sp = assoc.map((x) => linkSpeed(model, x.id)).filter((x): x is number => x !== null);
      return { id: `radio:${e.device}:${e.iface}`, what: `${e.device}:${e.iface} (a radio its ${assoc.length} Wi-Fi association${assoc.length === 1 ? '' : 's'} share)`, capacity: sp.length ? Math.max(...sp) : null, refs: assoc.map((x) => 'link:' + x.id) };
    }
  }
  // an aggregate: the speeds of its members that are up
  for (const e of [l.a, l.b]) {
    if (e.iface === undefined) continue;
    const d = model.index.devices.get(e.device);
    const agg = d ? d.logical.find((i) => i.members.indexOf(e.iface as string) >= 0) : undefined;
    if (!d || !agg) continue;
    const members = model.links.filter((x) => [x.a, x.b].some((y) => y.device === d.id && y.iface !== undefined && agg.members.indexOf(y.iface) >= 0));
    const up = members.filter((x) => linkUp(x.id));
    const speeds = up.map((x) => linkSpeed(model, x.id));
    const known = speeds.every((x) => x !== null);
    const all = members.map((x) => linkSpeed(model, x.id)).filter((x): x is number => x !== null);
    return { id: `lag:${d.id}:${agg.id}`, what: `${d.id}:${agg.id} (${up.length} of ${members.length} member${members.length === 1 ? '' : 's'} up)`, capacity: known ? (speeds as number[]).reduce((s, x) => s + x, 0) : null, perFlow: all.length ? Math.max(...all) : undefined, members: { up: up.length, total: members.length }, refs: [`iface:${d.id}:${agg.id}`].concat(members.map((x) => 'link:' + x.id)) };
  }
  return { id: 'link:' + linkId, what: linkId, capacity: linkSpeed(model, linkId), refs: ['link:' + linkId] };
}

/** The cables a path crosses, a tunnel's underlay included. */
function pathLinks(p: Path, depth = 0): string[] {
  const out: string[] = [];
  for (const h of p.hops) {
    for (const l of h.links) if (out.indexOf(l) < 0) out.push(l);
    if (h.underlay && depth < 4) for (const l of pathLinks(h.underlay, depth + 1)) if (out.indexOf(l) < 0) out.push(l);
  }
  return out;
}

/**
 * The capacity of the model's stated traffic (see the module comment), in
 * the configured model or in a failure's state (`ctx`).
 */
export function capacityAnalysis(model: Model, ctx: RoutingCtx = {}): CapacityResult {
  const demands = capacityDemands(model);
  const assumptions = [
    'Rates are what the model states (demands; applications with an interval and their sizes): payload rates, headers not added.',
    'How traffic spreads over equal-cost paths and over an aggregate’s members is not modeled: each resource is evaluated with an equal split and with all of a demand on one path.',
    'A cable’s capacity is its speed; an aggregate’s the speeds of its members that are up, a single flow at most one member’s; a radio is shared by its associations.',
  ];
  if (!demands.length) return { evaluated: false, demands: [], loads: [], text: 'Capacity is not evaluated: the model states no traffic (no demands, no application with an interval)', assumptions };
  const linkUp = (id: string): boolean => !ctx.linkUp || ctx.linkUp(id);
  const loads = new Map<string, ResourceLoad>();
  const perDemand: Array<{ d: CapDemand; trace: Trace; reached: Path[]; resources: CapResource[] }> = [];
  for (const d of demands) {
    const t = tracePath(model, { from: d.from, to: d.to }, ctx);
    const reached = t.error ? [] : t.paths.filter((p) => p.end.kind === 'reached' || p.end.kind === 'delivered');
    const seenAny = new Map<string, CapResource>();
    reached.forEach((p) => {
      const rs = new Map<string, CapResource>();
      for (const lid of pathLinks(p)) {
        const r = resourceOf(model, lid, linkUp);
        rs.set(r.id, r);
      }
      for (const [id, r] of rs) {
        seenAny.set(id, r);
        let ld = loads.get(id);
        if (!ld) loads.set(id, (ld = { resource: r, equal: 0, worst: 0, verdict: 'fits', demands: [] }));
        ld.equal += d.bps / reached.length;
        if (ld.demands.indexOf(d.id) < 0) {
          ld.demands.push(d.id);
          ld.worst += d.bps;
        }
      }
    });
    perDemand.push({ d, trace: t, reached, resources: Array.from(seenAny.values()) });
  }
  for (const ld of loads.values()) {
    const c = ld.resource.capacity;
    ld.verdict = c === null ? 'unknown' : ld.worst <= c ? 'fits' : ld.equal > c ? 'exceeds' : 'distribution';
  }
  const rank: CapVerdict[] = ['exceeds', 'distribution', 'unknown', 'fits'];
  const results: DemandResult[] = perDemand.map(({ d, trace, reached, resources }) => {
    if (trace.error || !reached.length) {
      const stopped = trace.paths.some((p) => p.end.kind === 'stopped');
      return { demand: d, connectivity: trace.error && !stopped ? 'unknown' : 'lost', verdict: 'not-applicable', text: trace.error ? trace.error : 'no evaluated path reaches the destination: the demand is not carried', paths: 0 };
    }
    const own = resources.map((r) => loads.get(r.id) as ResourceLoad);
    own.sort((a, b) => rank.indexOf(a.verdict) - rank.indexOf(b.verdict) || (b.worst / (b.resource.capacity || Infinity)) - (a.worst / (a.resource.capacity || Infinity)));
    const top = own[0];
    const out: DemandResult = { demand: d, connectivity: 'retained', verdict: top ? top.verdict : 'fits', text: '', paths: reached.length };
    const r = top ? top.resource : null;
    out.text = !top ? 'fits (no cable on its way)' : top.verdict === 'unknown' ? `insufficient information: ${r!.what} has no speed written` : `${top.verdict === 'fits' ? 'fits' : top.verdict === 'exceeds' ? 'exceeds' : 'depends on the distribution at'} ${r!.what}: ${bpsText(top.equal)} split equally, ${bpsText(top.worst)} on one path, of ${bpsText(r!.capacity as number)}`;
    const lag = resources.find((x) => x.perFlow !== undefined && d.bps > (x.perFlow as number));
    if (lag) out.perFlow = `${bpsText(d.bps)} is more than one member of ${lag.what} carries (${bpsText(lag.perFlow as number)}): it fits only as several flows`;
    return out;
  });
  const n = (v: string): number => results.filter((x) => x.verdict === v).length;
  // (not carried: no path reaches, or it can't be traced at all, an end down)
  const lost = results.filter((x) => x.connectivity !== 'retained').length;
  const text = `${results.length} demand${results.length === 1 ? '' : 's'}: ${n('fits')} fit${n('exceeds') ? `, ${n('exceeds')} exceed${n('exceeds') === 1 ? 's' : ''} the capacity` : ''}${n('distribution') ? `, ${n('distribution')} depend${n('distribution') === 1 ? 's' : ''} on the distribution` : ''}${n('unknown') ? `, ${n('unknown')} with insufficient information` : ''}${lost ? `, ${lost} not carried` : ''}`;
  return { evaluated: true, demands: results, loads: Array.from(loads.values()).sort((a, b) => rank.indexOf(a.verdict) - rank.indexOf(b.verdict) || (a.resource.id < b.resource.id ? -1 : 1)), text, assumptions };
}

/** How a failure changes the capacity: what overloads although it is still carried, what is no longer carried. */
export interface CapacityChange {
  demand: CapDemand;
  before: DemandResult;
  after: DemandResult;
  change: 'overload' | 'lost' | 'distribution' | 'relieved' | 'unknown' | 'unchanged';
}

export function compareCapacity(before: CapacityResult, after: CapacityResult): CapacityChange[] {
  const out: CapacityChange[] = [];
  for (const a of after.demands) {
    const b = before.demands.find((x) => x.demand.id === a.demand.id);
    if (!b) continue;
    let change: CapacityChange['change'] = 'unchanged';
    if (a.connectivity !== 'retained' && b.connectivity === 'retained') change = 'lost';
    else if (a.verdict === 'exceeds' && b.verdict !== 'exceeds') change = 'overload';
    else if (a.verdict === 'distribution' && b.verdict === 'fits') change = 'distribution';
    else if (a.verdict === 'unknown' && b.verdict !== 'unknown') change = 'unknown';
    else if (b.verdict === 'exceeds' && a.verdict === 'fits') change = 'relieved';
    out.push({ demand: a.demand, before: b, after: a, change });
  }
  const rank = ['overload', 'lost', 'distribution', 'unknown', 'relieved', 'unchanged'];
  return out.sort((x, y) => rank.indexOf(x.change) - rank.indexOf(y.change) || (x.demand.id < y.demand.id ? -1 : 1));
}

