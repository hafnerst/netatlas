/**
 * Capacity, bounded: does the traffic the model states fit the capacity it
 * states, in the configured model and under a failure? An architecture
 * check, not a performance simulation: no queues, delay, microbursts,
 * hardware forwarding limits or QoS.
 *
 *   demands     the model's \`demands:\` (a rate between two ends), and the
 *               applications that state a periodic rate: an interval
 *               written, with their sizes (written — 0 is a size —, else
 *               the profile's modelling defaults) (a UDP sender's payload,
 *               a client's request and the answer its peer's listener
 *               gives, an MQTT publisher's payload on each of its topics
 *               to its broker, and on to each subscriber each publication
 *               it matches — once, however many of its filters match it).
 *               Payload rates: headers are not added. No demand
 *               information means not evaluated, never zero load.
 *   resources   physical capacity, counted once: a cable (its speed; VLANs,
 *               subinterfaces and tunnels riding it share it), an
 *               aggregate (the speeds of its members that are up; a single
 *               flow is limited to one member that is up), a radio (its
 *               Wi-Fi associations share it). A cable without a speed has
 *               an unknown capacity. A full-duplex cable or aggregate has
 *               its speed each way: its two directions are evaluated
 *               apart; a half-duplex cable and a radio are one medium
 *               shared by both directions.
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
import { APP_DEFAULTS, AppInstance, appFamily, appProfile, parsePeer, topicMatches } from '../model/applications';
import { bpsText, parseSpeed } from '../model/speed';
import { Model } from '../model/types';
import { RoutingCtx } from './routing';
import { Path, Trace, TraceRequest, tracePath } from './trace';
import { appAddress, egressSource } from './communication';
import { parseAddress } from '../model/ip';

export interface CapDemand {
  id: string;
  label: string;
  from: string;
  to: string;
  bps: number;
  /** where it is stated */
  source: 'demand' | 'application';
  ref: string;
  /** what it assumes (an answer size its responder does not state) */
  note?: string;
  /**
   * an application's transfer: the ends as the application has them — its address family, the client device, and
   * the peer: an application or a listener (its bind interface's address), a device (its address of the family),
   * or an address — resolved when traced, in the state traced (communication.ts appAddress, as the simulation's
   * applications pick it); `answers`: the peer's way back to the client
   */
  app?: { family: 4 | 6; client: string; peer: { device?: string; bind?: string; address?: string }; answers?: boolean };
}

export interface CapResource {
  /** "link:l1", "lag:sw1:ae0", "radio:ap1:wlan0" */
  id: string;
  what: string;
  /** bits per second; null: not known (no speed written) */
  capacity: number | null;
  /** an aggregate: the most one flow can use (one member that is up; none: not known) */
  perFlow?: number;
  /** a full-duplex resource's direction this load is ("r1 → sw1"); none: one medium for both */
  direction?: string;
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
  /** the ends it was traced between ("cli 10.0.1.1 → srv:mgmt 10.9.9.2") */
  ends?: string;
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
      // (a size written is that size, 0 included; empty: the profile's modelling default)
      const size = (v: number | undefined, dflt: number): number => (v !== undefined ? v : dflt);
      // (the ends as the application has them: its family, its peer's listener and that listener's bind interface)
      const fam = appFamily(a);
      const peerOf = (): NonNullable<CapDemand['app']>['peer'] => {
        const r = responder(model, a, p.transport);
        if (r.app) {
          const owner = (model.devices.find((x) => (x.applications || []).indexOf(r.app as AppInstance) >= 0) as { id: string }).id;
          return { device: owner, bind: r.app.bind };
        }
        const pa = a.peer ? parseAddress(a.peer) : null;
        return pa ? { address: a.peer } : { device: a.peer };
      };
      if (p.id === 'udp_sender' && a.peer) out.push({ id: ref, label: `${dev.id}/${a.id}`, from: dev.id, to: a.peer.indexOf('/') > 0 ? a.peer.slice(0, a.peer.indexOf('/')) : a.peer, bps: size(a.requestSize, APP_DEFAULTS.udpRequest) * per, source: 'application', ref, app: { family: fam, client: dev.id, peer: peerOf() } });
      else if ((p.id === 'tcp_client' || p.id === 'udp_client') && a.peer) {
        const to = a.peer.indexOf('/') > 0 ? a.peer.slice(0, a.peer.indexOf('/')) : a.peer;
        const peer = peerOf();
        out.push({ id: ref + '>', label: `${dev.id}/${a.id} (requests)`, from: dev.id, to, bps: size(a.requestSize, p.id === 'tcp_client' ? APP_DEFAULTS.tcpRequest : APP_DEFAULTS.udpRequest) * per, source: 'application', ref, app: { family: fam, client: dev.id, peer } });
        // the answer is the responder's: its listener's response size (a client has none of its own)
        const dflt = p.id === 'tcp_client' ? APP_DEFAULTS.tcpResponse : APP_DEFAULTS.udpResponse;
        const r = responder(model, a, p.transport);
        const ans: CapDemand = { id: ref + '<', label: `${dev.id}/${a.id} (answers)`, from: to, to: dev.id, bps: size(r.app ? r.app.responseSize : undefined, dflt) * per, source: 'application', ref, app: { family: fam, client: dev.id, peer, answers: true } };
        if (!r.app) ans.note = `${r.why}: its answers are assumed ${dflt} bytes (the modelling default)`;
        else if (r.app.responseSize === undefined) ans.note = `${r.text} states no response size: ${dflt} bytes (the modelling default)`;
        out.push(ans);
      } else if (p.id === 'mqtt_client' && a.broker && a.publish.length) {
        // one publication per topic every interval; each subscriber gets each publication it matches once (overlapping filters or not)
        const payload = size(a.payloadSize, APP_DEFAULTS.mqttPayload);
        const topics = a.publish.filter((t, k) => a.publish.indexOf(t) === k);
        out.push({ id: ref + '>', label: `${dev.id}/${a.id} (publish${topics.length > 1 ? `, ${topics.length} topics` : ''})`, from: dev.id, to: a.broker, bps: payload * topics.length * per, source: 'application', ref, app: { family: fam, client: dev.id, peer: { device: a.broker } } });
        for (const sd of model.devices) {
          for (const sa of sd.applications || []) {
            if (sa.profile !== 'mqtt_client' || sa.broker !== a.broker || (sd.id === dev.id && sa.id === a.id)) continue;
            const matched = topics.filter((t) => sa.subscribe.some((f) => topicMatches(f, t)));
            if (!matched.length) continue;
            out.push({ id: `${ref}>${sd.id}/${sa.id}`, label: `${dev.id}/${a.id} → ${sd.id}/${sa.id} (via ${a.broker}${matched.length > 1 ? `, ${matched.length} topics` : ''})`, from: a.broker, to: sd.id, bps: payload * matched.length * per, source: 'application', ref, app: { family: appFamily(sa), client: sd.id, peer: { device: a.broker }, answers: true } });
          }
        }
      }
    }
  }
  return out.filter((d) => d.bps > 0).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * The listener that answers a client: its peer application ("srv/web"), or
 * the one listener of the peer device on the client's port and transport;
 * none when the peer is an address or a name, or several listen there.
 */
function responder(model: Model, a: AppInstance, transport: string): { app?: AppInstance; text: string; why: string } {
  const peer = a.peer || '';
  const pr = parsePeer(peer);
  if (pr.device !== undefined) {
    const d = model.index.devices.get(pr.device);
    const app = d && d.applications ? d.applications.find((x) => x.id === pr.app) : undefined;
    return app ? { app, text: peer, why: '' } : { text: peer, why: `its peer ${peer} is not in the model` };
  }
  const d = model.index.devices.get(peer);
  if (!d) return { text: peer, why: `its peer ${peer} is an address or a name: its responder is not known` };
  const ls = (d.applications || []).filter((x) => {
    const q = appProfile(x.profile);
    return !!q && q.listener && q.transport === transport && x.port === a.port;
  });
  if (ls.length === 1) return { app: ls[0], text: `${d.id}/${ls[0].id}`, why: '' };
  return { text: peer, why: ls.length ? `${ls.length} applications of ${peer} listen on ${transport}/${a.port}: its responder is ambiguous` : `no application of ${peer} listens on ${transport}/${a.port}` };
}

/**
 * What to trace for a demand: a demand's ends as written; an application's as the application has them (its
 * family; the peer listener's bind interface's address, else the peer device's address of the family, as the
 * simulation's applications pick it — communication.ts appAddress; the client's address the one it sends from
 * towards that address — communication.ts egressSource, the simulation's choice, so its answers come back to the
 * address the requests left from), in the state traced.
 */
function demandRequest(model: Model, d: CapDemand, ctx: RoutingCtx): TraceRequest {
  if (!d.app) return { from: d.from, to: d.to };
  const x = d.app;
  // (a listener bound to an interface without an address of the family now — down under a failure: that interface, which the
  // tracer then says has none; never the device's other address)
  const fallback = x.peer.device !== undefined ? (x.peer.bind !== undefined ? `${x.peer.device}:${x.peer.bind}` : x.peer.device) : d.to;
  const peer = x.peer.address !== undefined ? x.peer.address : x.peer.device !== undefined ? (appAddress(model, x.peer.device, x.family, x.peer.bind, ctx) || { address: fallback }).address : d.to;
  const src = parseAddress(peer) ? egressSource(model, x.client, peer, ctx) : null;
  const client = src ? `${x.client}:${src.iface}` : x.client;
  return x.answers ? { from: peer, to: client, family: x.family } : { from: client, to: peer, family: x.family };
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
    // (one flow: at most one member that is up — a failed one carries nothing; a member without a speed leaves it unknown)
    const res: CapResource = { id: `lag:${d.id}:${agg.id}`, what: `${d.id}:${agg.id} (${up.length} of ${members.length} member${members.length === 1 ? '' : 's'} up)`, capacity: known ? (speeds as number[]).reduce((s, x) => s + x, 0) : null, members: { up: up.length, total: members.length }, refs: [`iface:${d.id}:${agg.id}`].concat(members.map((x) => 'link:' + x.id)) };
    if (known && speeds.length) res.perFlow = Math.max(...(speeds as number[]));
    return res;
  }
  return { id: 'link:' + linkId, what: linkId, capacity: linkSpeed(model, linkId), refs: ['link:' + linkId] };
}

/** The cables a path crosses, a tunnel's underlay included, each with the device it leaves (its direction; null: not known). */
function pathLinks(model: Model, p: Path, depth = 0): Array<{ link: string; from: string | null }> {
  const out: Array<{ link: string; from: string | null }> = [];
  const add = (link: string, from: string | null): void => {
    if (!out.some((x) => x.link === link && x.from === from)) out.push({ link, from });
  };
  for (const h of p.hops) {
    // (the cables to the next hop in order, from this device, through the layer-2 devices; an aggregate's other members as their sibling)
    let at: string | null = h.device;
    let prev: { a: string; b: string; from: string } | null = null;
    for (const id of h.links) {
      const l = model.index.links.get(id);
      if (!l) continue;
      // (an aggregate's other member between the same two devices first: the same way as the member before it, not back)
      if (prev && ((l.a.device === prev.a && l.b.device === prev.b) || (l.a.device === prev.b && l.b.device === prev.a))) add(id, prev.from);
      else if (at !== null && (l.a.device === at || l.b.device === at)) {
        const to: string = l.a.device === at ? l.b.device : l.a.device;
        add(id, at);
        prev = { a: at, b: to, from: at };
        at = to;
      } else add(id, null);
    }
    if (h.underlay && depth < 4) for (const x of pathLinks(model, h.underlay, depth + 1)) add(x.link, x.from);
  }
  return out;
}

/**
 * A resource's load key and direction: a full-duplex cable or aggregate per direction (its speed each way), a
 * half-duplex cable or a radio one medium for both (and a direction not known counts on both ways).
 */
function directed(model: Model, r: CapResource, link: string, from: string | null): Array<{ key: string; direction?: string }> {
  if (r.id.indexOf('radio:') === 0) return [{ key: r.id }];
  const l = model.index.links.get(link);
  if (!l || l.a.duplex === 'half' || l.b.duplex === 'half') return [{ key: r.id }];
  const ab = { key: r.id + '|' + l.a.device + '>' + l.b.device, direction: `${l.a.device} → ${l.b.device}` };
  const ba = { key: r.id + '|' + l.b.device + '>' + l.a.device, direction: `${l.b.device} → ${l.a.device}` };
  return from === l.a.device ? [ab] : from === l.b.device ? [ba] : [ab, ba];
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
    'A cable’s capacity is its speed; an aggregate’s the speeds of its members that are up, a single flow at most one member’s (that is up); a radio is shared by its associations.',
    'A full-duplex cable or aggregate carries its speed each way: its two directions are evaluated apart; a half-duplex cable and a radio are one medium for both.',
  ];
  if (!demands.length) return { evaluated: false, demands: [], loads: [], text: 'Capacity is not evaluated: the model states no traffic (no demands, no application with an interval)', assumptions };
  const linkUp = (id: string): boolean => !ctx.linkUp || ctx.linkUp(id);
  const loads = new Map<string, ResourceLoad>();
  const perDemand: Array<{ d: CapDemand; trace: Trace; reached: Path[]; resources: CapResource[]; keys: string[] }> = [];
  for (const d of demands) {
    const t = tracePath(model, demandRequest(model, d, ctx), ctx);
    const reached = t.error ? [] : t.paths.filter((p) => p.end.kind === 'reached' || p.end.kind === 'delivered');
    const seenAny = new Map<string, CapResource>();
    reached.forEach((p) => {
      const rs = new Map<string, CapResource>();
      for (const x of pathLinks(model, p)) {
        const r = resourceOf(model, x.link, linkUp);
        // (an aggregate's members share its key per direction: the way of the member crossed)
        for (const k of directed(model, r, x.link, x.from)) rs.set(k.key, k.direction ? { ...r, direction: k.direction } : r);
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
    perDemand.push({ d, trace: t, reached, resources: Array.from(seenAny.values()), keys: Array.from(seenAny.keys()) });
  }
  for (const ld of loads.values()) {
    const c = ld.resource.capacity;
    ld.verdict = c === null ? 'unknown' : ld.worst <= c ? 'fits' : ld.equal > c ? 'exceeds' : 'distribution';
  }
  const rank: CapVerdict[] = ['exceeds', 'distribution', 'unknown', 'fits'];
  const results: DemandResult[] = perDemand.map(({ d, trace, reached, resources, keys }) => {
    if (trace.error || !reached.length) {
      const stopped = trace.paths.some((p) => p.end.kind === 'stopped');
      return { demand: d, connectivity: trace.error && !stopped ? 'unknown' : 'lost', verdict: 'not-applicable', text: trace.error ? trace.error : 'no evaluated path reaches the destination: the demand is not carried', paths: 0 };
    }
    const own = keys.map((k) => loads.get(k) as ResourceLoad);
    own.sort((a, b) => rank.indexOf(a.verdict) - rank.indexOf(b.verdict) || (b.worst / (b.resource.capacity || Infinity)) - (a.worst / (a.resource.capacity || Infinity)));
    const top = own[0];
    const out: DemandResult = { demand: d, connectivity: 'retained', verdict: top ? top.verdict : 'fits', text: '', paths: reached.length };
    if (trace.source && trace.dest) out.ends = `${trace.source.device}${trace.source.iface ? ':' + trace.source.iface : ''} ${trace.source.address || ''} → ${trace.dest.device ? trace.dest.device + (trace.dest.iface ? ':' + trace.dest.iface : '') + ' ' : ''}${trace.dest.address}`;
    const r = top ? top.resource : null;
    const where = (x: CapResource): string => x.what + (x.direction ? `, ${x.direction}` : '');
    out.text = !top ? 'fits (no cable on its way)' : top.verdict === 'unknown' ? `insufficient information: ${r!.what} has no speed written` : `${top.verdict === 'fits' ? 'fits' : top.verdict === 'exceeds' ? 'exceeds' : 'depends on the distribution at'} ${where(r!)}: ${bpsText(top.equal)} split equally, ${bpsText(top.worst)} on one path, of ${bpsText(r!.capacity as number)}`;
    const lag = resources.find((x) => x.perFlow !== undefined && d.bps > (x.perFlow as number));
    if (lag) out.perFlow = `${bpsText(d.bps)} is more than one member of ${lag.what} carries (${bpsText(lag.perFlow as number)}): it fits only as several flows`;
    else {
      const unk = resources.find((x) => x.members !== undefined && x.perFlow === undefined && x.members.up > 0);
      if (unk) out.perFlow = `the most one flow can use on ${unk.what} is not known (a member that is up has no speed written)`;
    }
    if (d.note) out.text += ` (assumed: ${d.note})`;
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

