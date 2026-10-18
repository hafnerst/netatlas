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
 *   DHCP          a DHCP client interface (IPv4, and DHCPv6 on its link) and
 *                 the servers with a scope for a network of its segment: it
 *                 gets new leases while one of them serves it. A server
 *                 serves it on the client's broadcast domain (the segment,
 *                 VLAN by VLAN) with a scope for the network of the
 *                 interface the request arrives at, or through a relay on
 *                 that domain (`dhcp_relay:`) whose address (giaddr) is in
 *                 one of the server's scopes, when the relay's unicast to the
 *                 server passes the path, the modeled policy and the
 *                 server's listener (UDP 67), and the answer's path back to
 *                 the relay passes too. Every server, relay and target is
 *                 tried before it is unavailable; a server reachable without
 *                 a relevant scope is no provider. DHCPv6 has no relay in
 *                 the supported model: on the client's link only. Losing
 *                 them stops new assignments and renewals; leases already
 *                 given last until they end (the scope's lease time);
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
import { CommCheck, CommRequest, LAYER_LABEL, checkCommunication } from './communication';
import { addressOwner, resolversOf } from './names';
import { Verdict } from './result';
import { RoutingCtx } from './routing';
import { segmentInfo, segmentOf } from './scope';
import { IpAddr, IpPrefix, parseAddress, parsePrefix } from '../model/ip';
import { formatAddr, inPrefix } from './ipmath';
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
  /** DHCP: the address family (4: DHCP, 6: DHCPv6) */
  family?: 4 | 6;
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
      for (const fam of [4, 6] as Array<4 | 6>) {
        if (fam === 4 ? !i.dhcp : i.ipv6 !== 'dhcpv6' && i.ipv6 !== 'slaac_dhcpv6') continue;
        const servers = dhcpServers(model, d.id, i.id, fam);
        if (!servers.length) continue;
        const proto = fam === 4 ? 'DHCP' : 'DHCPv6';
        out.push({ key: `${fam === 4 ? 'dhcp' : 'dhcp6'}:${d.id}:${i.id}`, kind: 'dhcp', consumer: d.id, consumerRef: `iface:${d.id}:${i.id}`, family: fam, text: `${d.id}:${i.id} gets its ${fam === 4 ? 'IPv4' : 'IPv6'} address by ${proto} from ${servers.map((x) => x.server).join(' or ')}`, options: servers.map((x) => ({ provider: x.server, text: `${x.server} (scope${x.networks.length === 1 ? '' : 's'} of ${x.networks.join(', ')}${x.lease ? ', lease ' + x.lease : ''})` })), consequence: `new ${proto} assignments and renewals for ${d.id}:${i.id} are unavailable; an address already leased stays until its lease ends${servers[0].lease ? ' (' + servers[0].lease + ')' : ''}` });
      }
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

/** A DHCP server's scopes of one family: their networks (prefix, id) and lease time. */
function scopesOf(model: Model, srv: string, fam: 4 | 6): Array<{ id: string; net: IpPrefix; lease?: number }> {
  const d = model.index.devices.get(srv);
  const dh = d && d.netServices ? d.netServices.dhcp : undefined;
  const out: Array<{ id: string; net: IpPrefix; lease?: number }> = [];
  for (const sc of dh ? dh.scopes : []) {
    const n = sc.network ? model.index.networks.get(sc.network) : undefined;
    const p = n && n.cidr ? parsePrefix(n.cidr) : null;
    if (p && p.version === fam) out.push({ id: n ? n.id : '', net: p, lease: sc.lease });
  }
  return out;
}

const leaseText = (ms: number): string => (ms >= 86400000 && ms % 86400000 === 0 ? `${ms / 86400000} d` : ms >= 3600000 ? `${Math.round(ms / 3600000)} h` : `${Math.round(ms / 60000)} min`);

/** The addresses of a family on an interface, as written. */
function addrsOf(model: Model, dev: string, iface: string, fam: 4 | 6): IpAddr[] {
  const i = model.index.interfaces.get(dev + ':' + iface);
  const out: IpAddr[] = [];
  for (const t of i ? i.addresses : []) {
    const a = parseAddress(t.split('/')[0]);
    if (a && a.version === fam) out.push(a);
  }
  return out;
}

/**
 * The DHCP servers that may serve a client interface: those with a scope
 * of the family for a network of its segment (an address of the segment's
 * interfaces in it: a local server's, a relay's), or of the networks its
 * cable carries. A server with no such scope is no candidate, however
 * reachable it is.
 */
function dhcpServers(model: Model, dev: string, iface: string, fam: 4 | 6): Array<{ server: string; networks: string[]; lease?: string }> {
  const seg = segmentOf(model, dev, iface);
  const lid = model.index.ifaceLink.get(dev + ':' + iface);
  const l = lid ? model.index.links.get(lid) : undefined;
  const nets = new Set<string>(l ? linkNetworks(model, l) : []);
  const segAddrs: IpAddr[] = [];
  for (const k of seg ? Array.from(seg) : []) {
    const [d, i] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    segAddrs.push(...addrsOf(model, d, i, fam));
  }
  const out: Array<{ server: string; networks: string[]; lease?: string }> = [];
  for (const srv of model.devices) {
    const scopes = scopesOf(model, srv.id, fam).filter((x) => nets.has(x.id) || segAddrs.some((a) => inPrefix(x.net, a)));
    if (!scopes.length) continue;
    const x: { server: string; networks: string[]; lease?: string } = { server: srv.id, networks: Array.from(new Set(scopes.map((c) => c.id))) };
    if (scopes[0].lease) x.lease = leaseText(scopes[0].lease);
    out.push(x);
  }
  return out.sort((p, q) => cmp(p.server, q.server));
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

/**
 * Does a DHCP server serve a client interface (see the module comment):
 * on the client's broadcast domain with a scope for the receiving
 * interface's network, or through any relay there. Every way is tried;
 * what each failed one lacks is kept as evidence.
 */
function dhcpReach(model: Model, dep: ServiceDependency, o: DepOption, ctx: RoutingCtx, devDown: (d: string) => boolean): { verdict: Verdict; text: string; refs: Set<string>; way?: string } {
  const refs = new Set<string>();
  const srv = o.provider as string;
  const fam = dep.family || 4;
  if (devDown(srv)) return { verdict: 'violated', text: `${srv} is down`, refs };
  const ifaceRef = dep.consumerRef.slice('iface:'.length);
  const dev = ifaceRef.slice(0, ifaceRef.indexOf(':'));
  const iface = ifaceRef.slice(ifaceRef.indexOf(':') + 1);
  if (ctx.up && !ctx.up(dev, iface)) return { verdict: 'violated', text: `${dev}:${iface} is down`, refs };
  const si = segmentInfo(model, dev, iface, undefined, ctx);
  if (!si.members) return { verdict: 'indeterminate', text: si.unknown || `the segment of ${dev}:${iface} is not known`, refs };
  const seg = si.members;
  seg.forEach((k) => refs.add('iface:' + k));
  const scopes = scopesOf(model, srv, fam);
  const scopeFor = (a: IpAddr): { id: string } | undefined => scopes.find((x) => inPrefix(x.net, a));
  const evidence: string[] = [];
  let unsure = '';
  // on the segment: an interface of the server there, up, with a scope for its network
  const sd = model.index.devices.get(srv);
  for (const i of sd ? deviceInterfaces(sd) : []) {
    if (!seg.has(srv + ':' + i.id) || (ctx.up && !ctx.up(srv, i.id))) continue;
    const at = addrsOf(model, srv, i.id, fam).find((a) => !!scopeFor(a));
    if (at) return { verdict: 'satisfied', text: `${srv}:${i.id} is on the broadcast domain of ${dev}:${iface}${si.vlan ? ' (VLAN ' + si.vlan + ')' : ''} with a scope for ${(scopeFor(at) as { id: string }).id}`, refs, way: 'segment ' + srv + ':' + i.id };
    evidence.push(`${srv}:${i.id} is on the broadcast domain but has no ${fam === 4 ? 'DHCP' : 'DHCPv6'} scope for its network`);
  }
  if (fam === 6) {
    evidence.push(`DHCPv6 relays are not part of the supported model: a server serves the clients on its own link only`);
    return { verdict: 'violated', text: `${srv} is not on the link of ${dev}:${iface} with a DHCPv6 scope for it. ${evidence.join('; ')}`, refs };
  }
  // a relay on the segment: every relay interface, every target of this server
  const srvAddrs = sd ? deviceInterfaces(sd).flatMap((i) => i.addresses.map((a) => a.split('/')[0])) : [];
  for (const k of Array.from(seg).sort()) {
    const rd = k.slice(0, k.indexOf(':'));
    const ri = k.slice(k.indexOf(':') + 1);
    const i = model.index.interfaces.get(k);
    if (!i || !i.dhcpRelay) continue;
    if (devDown(rd) || (ctx.up && !ctx.up(rd, ri))) {
      evidence.push(`the relay ${k} is down`);
      continue;
    }
    const giaddr = addrsOf(model, rd, ri, 4)[0];
    for (const target of i.dhcpRelay.filter((x) => srvAddrs.indexOf(x) >= 0)) {
      if (!giaddr) {
        evidence.push(`the relay ${k} has no IPv4 address to relay from`);
        continue;
      }
      const sc = scopeFor(giaddr);
      if (!sc) {
        evidence.push(`the relay ${k} forwards to ${srv} (${target}), which has no scope for the relay’s network (giaddr ${formatAddr(giaddr)})`);
        continue;
      }
      // the relay's unicast to the server: path, policy, the server's listener
      const fwd = checkCommunication(model, { from: k, to: target, service: 'udp/67' }, null, 'Service dependencies', 1, ctx);
      if (fwd.trace) for (const p of fwd.trace.paths) pathRefs(p).forEach((x) => refs.add(x));
      for (const l of fwd.layers) for (const r of l.refs) refs.add(r);
      if (fwd.verdict !== 'satisfied') {
        // (a policy that stops it is the reason, not the path it stops)
        const bad = fwd.layers.find((l) => l.id === 'policy' && l.verdict !== 'satisfied') || fwd.layers.find((l) => l.verdict !== 'satisfied' && l.id !== 'runtime');
        if (fwd.verdict === 'indeterminate' || fwd.verdict === 'beyond') unsure = unsure || `the relay ${k} to ${srv} (${target}): ${bad ? bad.text : fwd.headline}`;
        evidence.push(`the relay ${k} to ${srv} (${target}): ${bad ? `${LAYER_LABEL[bad.id]}: ${bad.text}` : fwd.headline}`);
        continue;
      }
      // the answer back to the relay (giaddr, UDP 67): path and policy (a relay is no listener of its own)
      const back = checkCommunication(model, { from: srv, to: formatAddr(giaddr), service: 'udp/67' }, null, 'Service dependencies', 1, ctx);
      if (back.trace) for (const p of back.trace.paths) pathRefs(p).forEach((x) => refs.add(x));
      const bad = back.layers.find((l) => l.id === 'policy' && l.verdict !== 'satisfied') || back.layers.find((l) => (l.id === 'path' || l.id === 'address') && l.verdict !== 'satisfied');
      if (bad) {
        if (bad.verdict === 'indeterminate' || bad.verdict === 'beyond') unsure = unsure || `${srv}’s answer to the relay ${k}: ${bad.text}`;
        evidence.push(`${srv}’s answer to the relay ${k} (${formatAddr(giaddr)}): ${LAYER_LABEL[bad.id]}: ${bad.text}`);
        continue;
      }
      return { verdict: 'satisfied', text: `the relay ${k} forwards to ${srv} (${target}, scope ${sc.id}): the path, the modeled policy and the listener pass both ways`, refs, way: 'relay ' + k + '>' + target };
    }
  }
  if (!evidence.length) evidence.push(`${srv} is not on the broadcast domain of ${dev}:${iface}${si.vlan ? ' (VLAN ' + si.vlan + ')' : ''}, and no relay there forwards to it`);
  return { verdict: unsure ? 'indeterminate' : 'violated', text: evidence.join('; '), refs };
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
