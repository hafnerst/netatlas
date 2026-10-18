/**
 * Service dependencies, and what a failure does to them. Only what the
 * model configures is a dependency; nothing is inferred about business
 * importance:
 *
 *   application   a client application's configured peer (tcp_client,
 *                 udp_client, udp_sender);
 *   MQTT broker   an MQTT client's configured broker;
 *   DNS           a device's resolvers (`dns_servers:`, or what its DHCP
 *                 scopes give out): it can resolve while one of them works;
 *   DHCP          a DHCP client interface and the servers of the scopes of
 *                 its network: it gets new leases while one is reachable
 *                 (on its segment, or through a relay on it). Losing them
 *                 stops new assignments and renewals; leases already given
 *                 last until they end (the scope's lease time);
 *   NTP, PTP      a device's timing source path (analysis/timing.ts);
 *   syslog, AAA   the senders of a syslog collector, the clients of an AAA
 *                 server (the services' own lists).
 *
 * A dependency is evaluated by communication checks (the source to the
 * provider's service): available, unavailable, or not determinable. Under a
 * failure, the comparison with the same baseline says what becomes
 * unavailable, what stays available through an alternative (another server,
 * another path), what is degraded (only some evaluated paths reach), and
 * what can't be determined. Static: no convergence or recovery time is
 * claimed. Pure and deterministic.
 */
import { appProfile } from '../model/applications';
import { Model, deviceInterfaces } from '../model/types';
import { linkNetworks } from '../model/derive';
import { CommCheck, CommRequest, checkCommunication } from './communication';
import { addressOwner, resolversOf } from './names';
import { Verdict } from './result';
import { RoutingCtx } from './routing';
import { segmentOf } from './scope';
import { timingSource } from './timing';
import { pathRefs } from './trace';

export type DepKind = 'application' | 'mqtt' | 'dns' | 'dhcp' | 'timing' | 'syslog' | 'aaa';

export const DEP_LABEL: { [k in DepKind]: string } = {
  application: 'Application peer',
  mqtt: 'MQTT broker',
  dns: 'Name resolution',
  dhcp: 'DHCP',
  timing: 'Timing source',
  syslog: 'Syslog collector',
  aaa: 'AAA server',
};

/** One way a dependency can be met (any one of them is enough). */
export interface DepOption {
  /** the providing device (none: outside the model) */
  provider?: string;
  /** the check of this option (a communication check); none for DHCP and timing, which have their own */
  request?: CommRequest;
  /** "srv-dns (10.0.0.53)" */
  text: string;
}

export interface ServiceDependency {
  /** stable: kind, consumer and what it depends on */
  key: string;
  kind: DepKind;
  /** the device that depends */
  consumer: string;
  /** the object of the consumer (its application, its interface) */
  consumerRef: string;
  /** "hmi/poll → plc/registers" */
  text: string;
  options: DepOption[];
  /** what it means when the dependency is unavailable */
  consequence: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every dependency the model configures, sorted by kind and consumer. */
export function serviceDependencies(model: Model): ServiceDependency[] {
  const out: ServiceDependency[] = [];
  for (const d of model.devices) {
    // applications: a client's peer, an MQTT client's broker
    for (const a of d.applications || []) {
      const p = appProfile(a.profile);
      if (!p || !p.client) continue;
      if (p.id === 'mqtt_client') {
        if (!a.broker) continue;
        out.push({ key: `mqtt:${d.id}/${a.id}`, kind: 'mqtt', consumer: d.id, consumerRef: 'device:' + d.id, text: `${d.id}/${a.id} → broker ${a.broker}`, options: [{ provider: a.broker, request: { from: `${d.id}/${a.id}` }, text: a.broker }], consequence: `${d.id}/${a.id} can’t publish or subscribe: no connection to its broker ${a.broker}` });
      } else if (a.peer) {
        out.push({ key: `app:${d.id}/${a.id}`, kind: 'application', consumer: d.id, consumerRef: 'device:' + d.id, text: `${d.id}/${a.id} → ${a.peer}`, options: [{ provider: a.peer.indexOf('/') > 0 ? a.peer.slice(0, a.peer.indexOf('/')) : addressOwner(model, a.peer) || (model.index.devices.has(a.peer) ? a.peer : undefined), request: { from: `${d.id}/${a.id}` }, text: a.peer }], consequence: `${d.id}/${a.id} can’t reach its peer ${a.peer}` });
      }
    }
    // name resolution: any of its resolvers
    const rs = resolversOf(model, d.id);
    if (rs.length) {
      const opts: DepOption[] = rs.map((r) => {
        const o = addressOwner(model, r.address);
        return o ? { provider: o, request: { from: d.id, to: r.address, service: 'udp/53' }, text: `${o} (${r.address})` } : { text: `${r.address} (outside the model)` };
      });
      out.push({ key: `dns:${d.id}`, kind: 'dns', consumer: d.id, consumerRef: 'device:' + d.id, text: `${d.id} resolves names with ${opts.map((o) => o.text).join(' or ')}`, options: opts, consequence: `${d.id} can’t resolve host names (applications that use names fail before they connect)` });
    }
    // DHCP: each client interface and the servers of its network's scopes
    for (const i of deviceInterfaces(d)) {
      if (!i.dhcp) continue;
      const servers = dhcpServers(model, d.id, i.id);
      if (!servers.length) continue;
      out.push({ key: `dhcp:${d.id}:${i.id}`, kind: 'dhcp', consumer: d.id, consumerRef: `iface:${d.id}:${i.id}`, text: `${d.id}:${i.id} gets its address from ${servers.map((s) => s.server).join(' or ')}`, options: servers.map((s) => ({ provider: s.server, text: `${s.server} (scope of ${s.network}${s.lease ? ', lease ' + s.lease : ''})` })), consequence: `new DHCP assignments and renewals for ${d.id}:${i.id} are unavailable; an address already leased stays until its lease ends${servers[0].lease ? ' (' + servers[0].lease + ')' : ''}` });
    }
    // timing: a PTP clock's or an NTP client's source path
    const svc = d.appServices;
    const ptp = svc ? svc.get('ptp') : undefined;
    const ntp = svc ? svc.get('ntp') : undefined;
    // (a clock that may become the grandmaster is a source, not a dependant: only receivers and boundary clocks depend)
    const ptpOrdinary = !!ptp && (ptp.values.clock === 'boundary' || (ptp.values.clock === 'ordinary' && ptp.values.role === 'receiver_only'));
    const ntpUp = !!ntp && Array.isArray(ntp.values.upstreams) && (ntp.values.upstreams as string[]).length > 0;
    if (ptpOrdinary || ntpUp) out.push({ key: `timing:${d.id}`, kind: 'timing', consumer: d.id, consumerRef: 'device:' + d.id, text: `${d.id} takes its time by ${ptpOrdinary ? 'PTP' : 'NTP'}`, options: [{ text: ptpOrdinary ? 'a compatible PTP source' : 'its NTP upstreams' }], consequence: `${d.id} has no compatible timing-source path: its clock is not disciplined (holdover is not modeled)` });
    // syslog senders, AAA clients (the services' own lists)
    const log = svc ? svc.get('syslog') : undefined;
    for (const s of log && Array.isArray(log.values.senders) ? (log.values.senders as string[]) : []) {
      if (!model.index.devices.has(s)) continue;
      out.push({ key: `syslog:${s}>${d.id}`, kind: 'syslog', consumer: s, consumerRef: 'device:' + s, text: `${s} logs to ${d.id}`, options: [{ provider: d.id, request: { from: s, to: `${d.id}/syslog` }, text: d.id }], consequence: `${s}’s log messages to ${d.id} are lost` });
    }
    const aaa = svc ? svc.get('aaa') : undefined;
    for (const s of aaa && Array.isArray(aaa.values.clients) ? (aaa.values.clients as string[]) : []) {
      if (!model.index.devices.has(s)) continue;
      out.push({ key: `aaa:${s}>${d.id}`, kind: 'aaa', consumer: s, consumerRef: 'device:' + s, text: `${s} authenticates against ${d.id}`, options: [{ provider: d.id, request: { from: s, to: `${d.id}/aaa` }, text: d.id }], consequence: `${s} can’t authenticate against ${d.id} (logins that need it fail)` });
    }
  }
  const order: DepKind[] = ['application', 'mqtt', 'dns', 'dhcp', 'timing', 'syslog', 'aaa'];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || cmp(a.consumer, b.consumer) || cmp(a.key, b.key));
}

/** The DHCP servers whose scopes serve the network a client interface's cable carries, with the lease time. */
function dhcpServers(model: Model, dev: string, iface: string): Array<{ server: string; network: string; lease?: string }> {
  const lid = model.index.ifaceLink.get(dev + ':' + iface);
  const l = lid ? model.index.links.get(lid) : undefined;
  const nets = l ? linkNetworks(model, l) : [];
  const out: Array<{ server: string; network: string; lease?: string }> = [];
  for (const srv of model.devices) {
    const dh = srv.netServices ? srv.netServices.dhcp : undefined;
    for (const s of dh ? dh.scopes : []) {
      if (!s.network || nets.indexOf(s.network) < 0 || out.some((x) => x.server === srv.id)) continue;
      const x: { server: string; network: string; lease?: string } = { server: srv.id, network: s.network };
      if (s.lease) x.lease = s.lease >= 86400000 && s.lease % 86400000 === 0 ? `${s.lease / 86400000} d` : s.lease >= 3600000 ? `${Math.round(s.lease / 3600000)} h` : `${Math.round(s.lease / 60000)} min`;
      out.push(x);
    }
  }
  return out.sort((a, b) => cmp(a.server, b.server));
}

/** The state of a dependency in one state of the model. */
export interface DepState {
  verdict: Verdict;
  /** the option that meets it (its index), when one does */
  via?: number;
  text: string;
  /** what its evaluation touched (devices, cables, relations …): a failure that touches none of it leaves it as it is */
  refs: Set<string>;
  /** the way it is met, as a signature (the option, the devices of its path): another way under a failure is an alternative */
  way?: string;
  /** the consumer itself is down in this state */
  consumerDown?: boolean;
}

/**
 * Evaluate a dependency: the first option that is available (in the
 * options' order); else partial, indeterminate or unavailable, in that order
 * of the options' outcomes. `down` is the failure's set of down devices.
 */
export function evaluateDependency(model: Model, dep: ServiceDependency, ctx: RoutingCtx = {}, devDown: (d: string) => boolean = () => false): DepState {
  const refs = new Set<string>();
  if (devDown(dep.consumer)) return { verdict: 'indeterminate', text: `${dep.consumer} itself is down`, refs, consumerDown: true };
  const outcomes: Array<{ v: Verdict; text: string }> = [];
  if (dep.kind === 'timing') {
    const t = timingSource(model, dep.consumer, ctx);
    if (t) t.refs.forEach((r) => refs.add(r));
    for (const d of t ? t.chain : []) refs.add('device:' + d);
    return { verdict: t ? t.verdict : 'unsupported', via: t && t.verdict === 'satisfied' ? 0 : undefined, text: t ? t.text : 'no timing configuration', refs, way: t ? t.chain.join('<') : undefined };
  }
  for (let k = 0; k < dep.options.length; k++) {
    const o = dep.options[k];
    if (o.provider) refs.add('device:' + o.provider);
    if (dep.kind === 'dhcp') {
      const r = dhcpReach(model, dep, o, ctx, devDown);
      r.refs.forEach((x) => refs.add(x));
      if (r.verdict === 'satisfied') return { verdict: 'satisfied', via: k, text: r.text, refs, way: `${k}|${r.way}` };
      outcomes.push({ v: r.verdict, text: r.text });
      continue;
    }
    if (!o.request) {
      outcomes.push({ v: 'beyond', text: `${o.text}: outside the model` });
      continue;
    }
    if (o.provider && devDown(o.provider)) {
      outcomes.push({ v: 'violated', text: `${o.provider} is down` });
      continue;
    }
    // (depth 0: a host name's DNS query is checked too, under the same failure)
    const c: CommCheck = checkCommunication(model, o.request, null, 'Service dependencies', 0, ctx);
    if (c.trace) for (const p of c.trace.paths) pathRefs(p).forEach((x) => refs.add(x));
    // (what it needs first: a host name's DNS query, and the objects of every layer)
    for (const g of c.legs) if (g.check.trace) for (const p of g.check.trace.paths) pathRefs(p).forEach((x) => refs.add(x));
    for (const l of c.layers) for (const r of l.refs) refs.add(r);
    if (c.verdict === 'satisfied') return { verdict: 'satisfied', via: k, text: `${o.text}: ${c.headline}`, refs, way: `${k}|${c.trace && c.trace.paths[0] ? c.trace.paths[0].hops.map((h) => h.device + (h.l2.length ? '(' + h.l2.join(',') + ')' : '')).join('>') : ''}` };
    outcomes.push({ v: c.verdict, text: `${o.text}: ${c.headline}` });
  }
  const pick = (v: Verdict): { v: Verdict; text: string } | undefined => outcomes.find((x) => x.v === v);
  const best = pick('partial') || pick('indeterminate') || pick('beyond') || pick('unsupported') || outcomes[0];
  return { verdict: best ? best.v : 'indeterminate', text: outcomes.map((x) => x.text).join('; '), refs };
}

/** Can a DHCP client reach a server: the server on the client's segment, or a relay on the segment that reaches it on UDP 67? */
function dhcpReach(model: Model, dep: ServiceDependency, o: DepOption, ctx: RoutingCtx, devDown: (d: string) => boolean): { verdict: Verdict; text: string; refs: Set<string>; way?: string } {
  const refs = new Set<string>();
  const srv = o.provider as string;
  if (devDown(srv)) return { verdict: 'violated', text: `${srv} is down`, refs };
  const [, ifaceRef] = dep.consumerRef.split('iface:');
  const [dev, iface] = (ifaceRef || '').split(':');
  const seg = segmentOf(model, dev, iface, undefined, ctx);
  if (!seg) return { verdict: 'indeterminate', text: `${dep.consumer}:${iface} has no cable: its segment is not known`, refs };
  seg.forEach((k) => refs.add('iface:' + k));
  const sd = model.index.devices.get(srv);
  if (sd && deviceInterfaces(sd).some((i) => seg.has(srv + ':' + i.id) && (!ctx.up || ctx.up(srv, i.id)))) return { verdict: 'satisfied', text: `${srv} is on the segment of ${dev}:${iface}`, refs, way: 'segment' };
  // a relay on the segment that forwards to the server, and reaches it
  const srvAddrs = sd ? deviceInterfaces(sd).flatMap((i) => i.addresses.map((a) => a.split('/')[0])) : [];
  for (const k of Array.from(seg).sort()) {
    const [rd, ri] = k.split(':');
    const i = model.index.interfaces.get(k);
    if (!i || !i.dhcpRelay || devDown(rd) || (ctx.up && !ctx.up(rd, ri))) continue;
    const target = i.dhcpRelay.find((a) => srvAddrs.indexOf(a) >= 0);
    if (!target) continue;
    const c = checkCommunication(model, { from: rd, to: target, service: 'udp/67' }, null, 'Service dependencies', 1, ctx);
    if (c.trace) for (const p of c.trace.paths) pathRefs(p).forEach((x) => refs.add(x));
    if (c.verdict === 'satisfied' || (c.layers.find((l) => l.id === 'path') || { verdict: 'violated' }).verdict === 'satisfied') return { verdict: 'satisfied', text: `the relay ${k} forwards to ${srv} (${target}), which it reaches`, refs, way: 'relay ' + k };
    return { verdict: c.verdict === 'indeterminate' ? 'indeterminate' : 'violated', text: `the relay ${k} can’t reach ${srv} (${target}): ${c.headline}`, refs };
  }
  return { verdict: 'violated', text: `${srv} is not on the segment of ${dev}:${iface}, and no relay there forwards to it`, refs };
}

/** How a dependency fares under a failure, against the same baseline. */
export type DepChangeKind = 'unavailable' | 'alternative' | 'degraded' | 'unchanged' | 'indeterminate' | 'consumer-down' | 'not-before';

export const DEP_CHANGE_TEXT: { [k in DepChangeKind]: string } = {
  unavailable: 'Becomes unavailable',
  alternative: 'Available through an alternative',
  degraded: 'Degraded',
  unchanged: 'Unaffected',
  indeterminate: 'Cannot be determined',
  'consumer-down': 'Its consumer fails',
  'not-before': 'Not available before the failure',
};

export interface DepChange {
  dep: ServiceDependency;
  before: DepState;
  after: DepState;
  change: DepChangeKind;
  /** in words: why */
  text: string;
}

/** The baseline of the dependencies: each one's state in the configured model. */
export function dependencyBaseline(model: Model, deps: ServiceDependency[]): Map<string, DepState> {
  const out = new Map<string, DepState>();
  for (const d of deps) out.set(d.key, evaluateDependency(model, d));
  return out;
}

/**
 * Compare each dependency under a failure with its baseline. Only what the
 * failure can touch is evaluated again: a dependency whose evaluation
 * touched nothing that failed keeps its state (a failure only takes things
 * away). `hit` holds the refs the failure takes down or degrades.
 */
export function compareDependencies(model: Model, deps: ServiceDependency[], baseline: Map<string, DepState>, ctx: RoutingCtx, hit: Set<string>, devDown: (d: string) => boolean): DepChange[] {
  const out: DepChange[] = [];
  for (const d of deps) {
    const before = baseline.get(d.key) || evaluateDependency(model, d);
    // (a timing path runs over segments whose every cable is not in its evidence: always evaluated again)
    const touched = d.kind === 'timing' || devDown(d.consumer) || Array.from(before.refs).some((r) => hit.has(r)) || d.options.some((o) => !!o.provider && hit.has('device:' + o.provider));
    if (!touched) {
      out.push({ dep: d, before, after: before, change: before.verdict === 'satisfied' ? 'unchanged' : before.verdict === 'violated' ? 'not-before' : 'indeterminate', text: before.verdict === 'satisfied' || before.verdict === 'violated' ? before.text : 'not determinable, before the failure too: ' + before.text });
      continue;
    }
    const after = evaluateDependency(model, d, ctx, devDown);
    let change: DepChangeKind;
    if (after.consumerDown) change = 'consumer-down';
    else if (before.verdict === 'violated') change = 'not-before';
    // (not determinable before, but a provider that is gone makes it unavailable whatever the rest was)
    else if (before.verdict !== 'satisfied') change = after.verdict === 'violated' ? 'unavailable' : 'indeterminate';
    else if (after.verdict === 'satisfied') change = after.via !== before.via || after.way !== before.way ? 'alternative' : 'unchanged';
    else if (after.verdict === 'partial') change = 'degraded';
    else if (after.verdict === 'violated') change = 'unavailable';
    else change = 'indeterminate';
    const text = change === 'alternative' ? `still available: ${after.text}${after.via !== before.via ? ` (before: ${d.options[before.via as number] ? d.options[before.via as number].text : ''})` : ''}` : change === 'unavailable' ? `${d.consequence}. ${after.text}` : after.text;
    out.push({ dep: d, before, after, change, text });
  }
  const rank: DepChangeKind[] = ['unavailable', 'degraded', 'indeterminate', 'alternative', 'consumer-down', 'not-before', 'unchanged'];
  return out.sort((a, b) => rank.indexOf(a.change) - rank.indexOf(b.change) || cmp(a.dep.key, b.dep.key));
}
