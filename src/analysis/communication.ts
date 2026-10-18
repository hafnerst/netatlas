/**
 * Communication checks: can a source use a destination application or
 * service, as far as the model establishes it? Trace path answers where
 * packets go; this answers the question an architect asks, layer by layer,
 * without folding them into one "reachable":
 *
 *   address     the source and the destination have an address of the
 *               family (configured, or acquired in a simulation snapshot;
 *               an address only DHCP or SLAAC assigns at runtime is not
 *               known to a static analysis: indeterminate);
 *   name        a host name the source uses resolves within the modeled
 *               DNS (its resolvers, their zones and forwarders);
 *   path        the path tracer's outcome over every evaluated path
 *               (routing and layer 2; a policy stop is not a routing
 *               failure);
 *   policy      what the filtering devices on the way decide (firewalls,
 *               Security gateways, VPN gateways) for this service;
 *   listener    something listens on the destination port, on the address
 *               the traffic arrives at (an application bound to another
 *               interface does not take it);
 *   runtime     what no static analysis establishes: that the application
 *               accepts it, authentication, protocol behaviour, health and
 *               completion. Always said, never claimed.
 *
 * Ends may name applications ("plc/registers"), whose transport, port and
 * bind interface the check takes, a client application ("hmi/poll"), whose
 * configured peer or broker it checks, or a device's service ("core/dns",
 * "ntp1/ntp"). An MQTT client's leg ends at the broker; what the broker
 * passes on to subscribers is a separate leg each (over the subscriber's own
 * connection), reported apart. The return direction is reverse routing only:
 * a TCP session or a stateful return decision is not evaluated (said so, and
 * the simulation is offered for it, never started). Pure and deterministic.
 */
import { AppInstance, AppProfile, appProfile, topicMatches } from '../model/applications';
import { parseAddress } from '../model/ip';
import { capabilities } from '../model/capabilities';
import { autoIpv6 } from '../model/ipv6';
import { dnsNameProblem } from '../model/dns';
import { Device, Model, deviceInterfaces, ifaceKey } from '../model/types';
import { NamedService, appListeners, namedServices, serviceListeners } from './listeners';
import { answerAt, addressOwner, resolversOf } from './names';
import { AnalysisContext, ResultInfo, Verdict, allOf, configuredContext, resultInfo } from './result';
import { RoutingCtx, connectedIn } from './routing';
import { AnalysisSnapshot, ADDR_METHOD_TEXT, methodOf } from './snapshot';
import { Trace, TraceEnd, TraceOutcome, TraceService, endpointChoices, isAsymmetric, outcomeLines, parseService, parseTraceEnd, returnRequest, traceOutcome, tracePath } from './trace';
import { boundInterfaces, deviceListening, writtenListening } from './sim/transport';
import { portsMatch } from './sim/params';
import { compareAddr, formatAddr } from './ipmath';

// ------------------------------------------------------------ ends

/** An end of a communication check. */
export type CommEnd =
  | { kind: 'end'; text: string; end: TraceEnd }
  | { kind: 'app'; text: string; device: string; app: AppInstance; profile: AppProfile }
  | { kind: 'service'; text: string; device: string; service: NamedService }
  | { kind: 'name'; text: string; name: string };

/**
 * Read an end: a device, an interface (device:interface), an address, an
 * application ("device/application"), a service ("device/dns", "ntp1/ntp";
 * an application of that id first), or a host name. An error message when
 * it names nothing.
 */
export function parseCommEnd(model: Model, text: string): CommEnd | string {
  const t = text.trim();
  if (!t) return 'Enter a device, an interface, an address, an application (device/application) or a service (device/service)';
  const slash = t.lastIndexOf('/');
  if (slash > 0 && !parseAddress(t.replace(/\/[0-9]+$/, '')) && t.indexOf(':') < 0) {
    const dev = t.slice(0, slash);
    const id = t.slice(slash + 1);
    const d = model.index.devices.get(dev);
    if (!d) return `“${dev}” is no device of the model`;
    const app = (d.applications || []).find((a) => a.id === id);
    if (app) {
      const p = appProfile(app.profile);
      if (p) return { kind: 'app', text: t, device: dev, app, profile: p };
    }
    const svc = namedServices(d).find((s) => s.id === id);
    if (svc) return { kind: 'service', text: t, device: dev, service: svc };
    const ids = (d.applications || []).map((a) => a.id).concat(namedServices(d).map((s) => s.id));
    return `${dev} has no application or service “${id}”${ids.length ? ` (it has ${ids.join(', ')})` : ''}`;
  }
  const e = parseTraceEnd(model, t);
  if (typeof e !== 'string') return { kind: 'end', text: t, end: e };
  if (!dnsNameProblem(t) && /[a-z]/i.test(t) && t.indexOf('.') > 0) return { kind: 'name', text: t, name: t };
  return e;
}

/** The device an end is on (none for an address outside the model or a host name). */
function endDevice(model: Model, e: CommEnd, ctx: RoutingCtx): string | undefined {
  if (e.kind === 'app' || e.kind === 'service') return e.device;
  if (e.kind === 'name') return undefined;
  if (e.end.kind !== 'address') return e.end.device;
  const c = endpointChoices(model, e.end, ctx);
  return c.length ? c[0].device : undefined;
}

// ------------------------------------------------------------ results

export type LayerId = 'address' | 'name' | 'path' | 'policy' | 'listener' | 'runtime';

export const LAYER_LABEL: { [k in LayerId]: string } = {
  address: 'Addresses',
  name: 'Name resolution',
  path: 'Network path',
  policy: 'Policy',
  listener: 'Destination listener',
  runtime: 'Runtime behaviour',
};

export interface CommLayer {
  id: LayerId;
  verdict: Verdict;
  /** one line */
  text: string;
  /** the evidence (shown on demand) */
  detail: string[];
  /** objects it is about (refs), for navigation */
  refs: string[];
}

export interface CommRequest {
  from: string;
  /** none: a client application's configured peer or broker */
  to?: string;
  /** "tcp/443", "udp/53", "icmp"; none: from the applications, else not given */
  service?: string;
  vrf?: string;
  /** also the reverse direction (reverse routing and symmetry) */
  back?: boolean;
}

/** A prefilled simulation action (offered, never run by the check). */
export interface Handoff {
  kind: 'send' | 'app';
  device: string;
  iface?: string;
  /** the destination address (send) */
  target?: string;
  proto?: 'tcp' | 'udp' | 'icmp';
  port?: number;
  /** the application to start (app) */
  app?: string;
  text: string;
}

export interface CommCheck {
  /** set when the request can't be checked at all (an end names nothing) */
  error?: string;
  request: CommRequest;
  verdict: Verdict;
  /** "Reachable within scope", "Blocked by policy at fw1" … */
  headline: string;
  /** the effective ends */
  from?: { device: string; iface?: string; address?: string; text: string };
  to?: { device?: string; iface?: string; address?: string; text: string };
  service?: TraceService;
  /** how the service was found ("from plc/registers", "given") */
  serviceSource?: string;
  layers: CommLayer[];
  trace?: Trace;
  outcome?: TraceOutcome;
  /** the reverse direction: reverse routing, path symmetry, and what is not established */
  reverse?: { trace: Trace; outcome: TraceOutcome; symmetry: 'symmetric' | 'asymmetric' | 'not comparable'; lines: string[] };
  /** separate legs: a broker's subscribers (each over its own connection), a host name's DNS query */
  legs: Array<{ label: string; check: CommCheck }>;
  handoff?: Handoff;
  info: ResultInfo;
}

const svcText = (s: TraceService): string => (s.proto === 'icmp' ? 'ICMP' : `${s.proto.toUpperCase()} ${s.port}`);

function failed(req: CommRequest, error: string, context: AnalysisContext): CommCheck {
  return { error, request: req, verdict: 'indeterminate', headline: error, layers: [], legs: [], info: resultInfo(context) };
}

/** The address an application's clients use for a device (as the simulation's applications pick it): the bind interface's, else the first interface's of the family, loopbacks last. */
export function appAddress(model: Model, dev: string, v: 4 | 6, bind: string | undefined, ctx: RoutingCtx): { iface: string; address: string } | null {
  const d = model.index.devices.get(dev);
  if (!d) return null;
  const conn = connectedIn(model, dev, ctx).filter((c) => c.addr.version === v && (!ctx.up || ctx.up(dev, c.iface)));
  if (bind !== undefined) {
    const c = conn.find((x) => x.iface === bind);
    return c ? { iface: c.iface, address: formatAddr(c.addr) } : null;
  }
  const kindOf = (i: string): number => {
    const x = model.index.interfaces.get(ifaceKey(dev, i));
    return x && x.type === 'loopback' ? 1 : 0;
  };
  const cands = conn.filter((c) => {
    const x = model.index.interfaces.get(ifaceKey(dev, c.iface));
    return !!x && x.type !== 'tunnel';
  });
  cands.sort((a, b) => kindOf(a.iface) - kindOf(b.iface) || (a.iface < b.iface ? -1 : a.iface > b.iface ? 1 : 0) || compareAddr(a.addr, b.addr));
  return cands.length ? { iface: cands[0].iface, address: formatAddr(cands[0].addr) } : null;
}

/** The interfaces of a device that take an address of a family at runtime (DHCP, SLAAC, DHCPv6). */
function autoAddressed(d: Device | undefined, v: 4 | 6): string[] {
  if (!d) return [];
  return deviceInterfaces(d)
    .filter((i) => (v === 4 ? i.dhcp : autoIpv6(i.ipv6)))
    .map((i) => i.id);
}

/**
 * Check a communication (see the module comment). `snap` is the simulation
 * snapshot the context is (null: the configured model): its routing state
 * and acquired addresses.
 */
export function checkCommunication(model: Model, req: CommRequest, snap: AnalysisSnapshot | null = null, scope = 'Selected endpoints', depth = 0, failCtx?: RoutingCtx): CommCheck {
  // (a failure condition of the configured model: its routing context; a snapshot has its own)
  const ctx: RoutingCtx = snap ? snap.ctx : failCtx || {};
  const context: AnalysisContext = snap ? { kind: 'snapshot', at: snap.at, scope } : configuredContext(scope);
  const from = parseCommEnd(model, req.from);
  if (typeof from === 'string') return failed(req, 'Source: ' + from, context);
  if (from.kind === 'name') return failed(req, 'Source: a host name is no source; give the device', context);
  if (from.kind === 'service') return failed(req, `Source: ${from.text} is a service; give the device or a client application`, context);
  const fromDev = endDevice(model, from, ctx);
  if (!fromDev) return failed(req, `Source: no device of the model has ${from.text}`, context);
  // ---- where to: given, or the client application's configured peer / broker
  let toText = req.to !== undefined ? req.to.trim() : '';
  let peerNote = '';
  const clientApp = from.kind === 'app' && from.profile.client ? from : null;
  if (!toText && clientApp) {
    const a = clientApp.app;
    if (clientApp.profile.id === 'mqtt_client') {
      if (!a.broker) return failed(req, `Destination: ${from.text} names no broker`, context);
      toText = `${a.broker}/mqtt_broker`;
      peerNote = `its broker ${a.broker}`;
    } else if (a.peer) {

      toText = a.peer;
      peerNote = `its peer ${a.peer}`;
    } else return failed(req, `Destination: ${from.text} has no peer`, context);
  }
  if (!toText) return failed(req, 'Destination: enter a device, an interface, an address, an application or a service', context);
  const to = parseCommEnd(model, toText);
  if (typeof to === 'string') {
    // a broker without the service: say so precisely
    if (clientApp && clientApp.profile.id === 'mqtt_client') return failed(req, `Destination: ${clientApp.app.broker} runs no MQTT broker service`, context);
    return failed(req, 'Destination: ' + to, context);
  }
  // ---- the service: given, else the destination's listener, else the client's peer port
  let svc: TraceService | null = null;
  let serviceSource = '';
  const given = parseService(req.service);
  if (typeof given === 'string') return failed(req, 'Service: ' + given, context);
  if (given) {
    svc = given;
    serviceSource = 'given';
  } else if (to.kind === 'app' && to.profile.listener && to.app.port !== undefined) {
    svc = { proto: to.profile.transport, port: to.app.port };
    serviceSource = `the listener ${to.text}`;
  } else if (to.kind === 'service') {
    svc = { proto: to.service.proto, port: to.service.port };
    serviceSource = `the ${to.service.label} of ${to.device}`;
  } else if (clientApp && clientApp.app.port !== undefined) {
    svc = { proto: clientApp.profile.transport, port: clientApp.app.port };
    serviceSource = `the port of ${clientApp.text}`;
  }
  if (to.kind === 'app' && !to.profile.listener) return failed(req, `Destination: ${to.text} is a ${to.profile.short}, not a listener: nothing connects to it`, context);
  // ---- the address family: the client's (ip_version, an address peer), else what the ends have
  const famOf = (): 4 | 6 | undefined => {
    if (clientApp) {
      const pa = clientApp.app.peer ? parseAddress(clientApp.app.peer) : null;
      return pa ? pa.version : clientApp.app.ipVersion || 4;
    }
    if (to && typeof to !== 'string' && to.kind === 'end' && to.end.kind === 'address') {
      const a = parseAddress(to.end.address);
      return a ? a.version : undefined;
    }
    return undefined;
  };
  const fam = famOf();
  const layers: CommLayer[] = [];
  const legs: CommCheck['legs'] = [];
  const out: CommCheck = { request: req, verdict: 'indeterminate', headline: '', layers, legs, info: resultInfo(context) };
  if (svc) {
    out.service = svc;
    out.serviceSource = serviceSource;
  }
  // ---- name resolution (a host name the client uses, or one given as the destination)
  let toAddr: string | undefined;
  let toDev: string | undefined;
  let toIface: string | undefined;

  const hostName = to.kind === 'name' ? to.name : '';
  if (hostName) {
    const name = hostName;
    const qtype = (fam || 4) === 6 ? 'AAAA' : 'A';
    const nl = nameLayer(model, fromDev, name, qtype, snap, depth, failCtx);
    layers.push(nl.layer);
    for (const l of nl.legs) legs.push(l);
    if (nl.address) {
      toAddr = nl.address;
      toDev = addressOwner(model, nl.address);
    }
  }
  // ---- the destination of an application or service: its bind interface's (or listen) address; a plain end is the tracer's choice
  if (to.kind === 'app' || to.kind === 'service') {
    toDev = to.device;
    const bind = to.kind === 'app' ? to.app.bind : undefined;
    const listenAddr = to.kind === 'service' ? to.service.address : undefined;
    if (listenAddr) {
      toAddr = listenAddr;
      const own = connectedIn(model, to.device, ctx).find((c) => formatAddr(c.addr) === listenAddr);
      if (own) toIface = own.iface;
    } else {
      const pick = appAddress(model, to.device, fam || 4, bind, ctx);
      if (pick) {
        toAddr = pick.address;
        toIface = pick.iface;
      }
    }
  }
  // ---- the addresses the ends have (before anything is traced)

  const srcEnd: TraceEnd = from.kind === 'end' ? from.end : { kind: 'device', device: fromDev };
  const srcChoices = endpointChoices(model, srcEnd, ctx).filter((c) => fam === undefined || c.version === fam);
  const addr: CommLayer = { id: 'address', verdict: 'satisfied', text: '', detail: [], refs: ['device:' + fromDev] };
  layers.unshift(addr);
  const famText = fam ? `IPv${fam}` : 'an';
  /** an end without an address: indeterminate where one is assigned at runtime (the configured model), else violated */
  const noAddress = (dev: string, what: string, bind?: string): void => {
    // (in a failure: the interfaces that have an address may be down)
    const down = connectedIn(model, dev, ctx).filter((c) => (fam === undefined || c.addr.version === fam) && (bind === undefined || c.iface === bind) && !!ctx.up && !ctx.up(dev, c.iface));
    if (down.length) {
      addr.verdict = 'violated';
      addr.detail.push(`${dev}:${down.map((c) => c.iface).filter((x, k, a) => a.indexOf(x) === k).join(', ')} ${down.length === 1 ? 'is' : 'are'} down: ${dev} has no ${famText} address that is up`);
      addr.refs.push(`iface:${dev}:${down[0].iface}`);
      return;
    }
    const auto = autoAddressed(model.index.devices.get(dev), fam || 4).filter((i) => bind === undefined || i === bind);
    if (auto.length && !snap) {
      if (addr.verdict !== 'violated') addr.verdict = 'indeterminate';
      addr.detail.push(`${dev}:${auto[0]} takes its ${fam === 6 ? 'IPv6' : 'IPv4'} address ${fam === 6 ? 'by SLAAC or DHCPv6' : 'by DHCP'} at runtime: the configured model has no ${what} address. Analyze a simulation snapshot to use the address it acquired.`);
      addr.refs.push(`iface:${dev}:${auto[0]}`);
    } else {
      addr.verdict = 'violated';
      addr.detail.push(snap && auto.length ? `${dev}:${auto[0]} has no ${famText} address at the snapshot (not acquired yet)` : bind !== undefined ? `${dev}:${bind}, the bind interface of ${to.text}, has no ${famText} address` : `${dev} has no ${famText} address${what === 'source' && from.kind === 'end' && from.end.kind === 'iface' ? ' on ' + from.end.iface : ''}`);
    }
  };
  if (!srcChoices.length) noAddress(fromDev, 'source');
  if ((to.kind === 'app' || to.kind === 'service') && !toAddr) noAddress(to.device, 'destination', to.kind === 'app' ? to.app.bind : undefined);
  // ---- the path (and the policy on it)
  const runtimeLayer = (): CommLayer => ({
    id: 'runtime',
    verdict: 'unsupported',
    text: 'Not established by static analysis: that the application accepts the connection, authentication, protocol behaviour, service health and completion',
    detail: [svc && svc.proto === 'tcp' ? 'A TCP session (handshake, the answer, a stateful firewall’s return decision) is not evaluated.' : 'No packet is exchanged: a static analysis sends nothing.', 'A simulation can exchange it: the action is prefilled, not started.'],
    refs: [],
  });
  const nameFailed = layers.some((l) => l.id === 'name' && l.verdict !== 'satisfied');
  const blocked = addr.verdict !== 'satisfied' || (to.kind === 'name' && !toAddr);
  if (blocked || (nameFailed && !toAddr)) {
    layers.push({ id: 'path', verdict: addr.verdict === 'violated' ? 'violated' : 'indeterminate', text: 'Not traced: ' + (addr.verdict !== 'satisfied' ? 'an end has no address to trace with' : 'the name does not resolve'), detail: [], refs: [] });
  } else {
    const src = from.kind === 'end' ? from.text : fromDev;
    const dst = to.kind === 'end' ? to.text : (toAddr as string);
    const treq = { from: src, to: dst, service: svc ? (svc.proto === 'icmp' ? 'icmp' : `${svc.proto}/${svc.port}`) : undefined, vrf: req.vrf };
    const trace = tracePath(model, treq, ctx);
    out.trace = trace;
    if (trace.error) {
      if (/^Destination: .* has no address/.test(trace.error) && toDev === undefined && to.kind === 'end' && to.end.kind !== 'address') noAddress(to.end.device, 'destination');
      layers.push({ id: 'path', verdict: addr.verdict === 'violated' ? 'violated' : 'indeterminate', text: trace.error, detail: [], refs: [] });
    } else {
      const o = traceOutcome(trace);
      out.outcome = o;
      const s = trace.source;
      const d = trace.dest;
      if (s) {
        addr.text = `From ${s.device}${s.iface ? ':' + s.iface : ''} · ${s.address || 'no address'}${s.iface && s.address ? ` (${ADDR_METHOD_TEXT[methodOf(snap, s.device, s.iface, s.address)]})` : ''}`;
        if (s.iface) addr.refs.push(`iface:${s.device}:${s.iface}`);
        const same = srcChoices.filter((c) => !s.address || c.version === (parseAddress(s.address) as { version: 4 | 6 }).version);
        if (same.length > 1) addr.detail.push(`${fromDev} has ${same.length} addresses of this family that could be the source; the tracer uses ${s.address} (loopbacks first, then by interface)`);
      }
      if (d) {
        const how = d.device && d.iface ? ADDR_METHOD_TEXT[methodOf(snap, d.device, d.iface, d.address)] : 'no modeled device has it';
        addr.detail.unshift(`To ${d.device ? d.device + (d.iface ? ':' + d.iface : '') + ' · ' : ''}${d.address} (${how})${to.kind === 'app' && to.app.bind ? `: the bind interface of ${to.text}` : to.kind === 'app' ? ': the address the application’s clients use (first interface, loopbacks last)' : ''}`);
        if (d.device) addr.refs.push(d.iface ? `iface:${d.device}:${d.iface}` : 'device:' + d.device);
        if (toDev && d.device && d.device !== toDev) addr.detail.push(`${d.address} is also an address of ${d.device}: the trace follows ${d.device}`);
      }
      out.from = s ? { device: s.device, iface: s.iface, address: s.address, text: `${s.device}${s.iface ? ':' + s.iface : ''}${s.address ? ' · ' + s.address : ''}` } : { device: fromDev, text: fromDev };
      out.to = d ? { device: d.device, iface: d.iface, address: d.address, text: `${d.device ? d.device + (d.iface ? ':' + d.iface : '') + ' · ' : ''}${d.address}` } : { text: to.text };
      layers.push(pathLayer(trace, o));
      layers.push(policyLayer(model, trace, o, svc));
      // ---- the listener where it arrives
      if (svc && svc.proto !== 'icmp') layers.push(listenerLayer(model, trace, o, svc));
      if (req.back) out.reverse = reverseOf(model, trace, ctx);
    }
  }
  if (!addr.text) addr.text = addr.verdict === 'satisfied' ? 'The ends have addresses' : (addr.detail[0] || 'An end has no address').replace(/\. Analyze a simulation snapshot.*$/, '');
  if (!out.from) out.from = srcChoices.length ? { device: fromDev, iface: srcChoices[0].iface, address: srcChoices[0].address, text: `${fromDev}:${srcChoices[0].iface} · ${srcChoices[0].address}` } : { device: fromDev, text: fromDev };
  if (!out.to) out.to = toAddr ? { device: toDev, iface: toIface, address: toAddr, text: `${toDev ? toDev + (toIface ? ':' + toIface : '') + ' · ' : ''}${toAddr}` } : { device: toDev, text: to.text };
  if (peerNote) out.to.text += ` (${peerNote})`;

  layers.push(runtimeLayer());
  // ---- an MQTT publisher's subscribers: each over its own connection to the broker
  if (clientApp && clientApp.profile.id === 'mqtt_client' && clientApp.app.publish.length && depth === 0 && clientApp.app.broker) {
    const broker = clientApp.app.broker;
    for (const sd of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
      for (const sa of sd.applications || []) {
        if (sa.profile !== 'mqtt_client' || sa.broker !== broker || (sd.id === fromDev && sa.id === clientApp.app.id)) continue;
        const topics = clientApp.app.publish.filter((t) => sa.subscribe.some((f) => topicMatches(f, t)));
        if (!topics.length) continue;
        const sub = checkCommunication(model, { from: `${sd.id}/${sa.id}` }, snap, scope, depth + 1, failCtx);
        legs.push({ label: `Broker ${broker} → subscriber ${sd.id}/${sa.id} (${topics.join(', ')}), over the subscriber’s own connection`, check: sub });
      }
    }
  }
  // ---- the verdict: every evaluated layer (the runtime layer is never a conclusion)
  const evaluated = layers.filter((l) => l.id !== 'runtime');
  out.verdict = allOf(evaluated.map((l) => l.verdict));
  out.headline = headlineOf(out, evaluated);
  // ---- assumptions and limits
  out.info = resultInfo(
    context,
    ['Routing, layer 2 and the modeled policies decide as the path tracer does (a model-based approximation).'].concat(svc ? [`The service is ${svcText(svc)} (${serviceSource}).`] : []),
    ['Router ACLs are not modeled.', 'Runtime behaviour: authentication, protocol acceptance, service health and completion.'].concat(out.outcome && out.outcome.truncated ? ['Equal-cost paths beyond the evaluated ones.'] : []),
  );
  // ---- the handoff: the same exchange, prefilled in the simulation's Network events
  // (the destination address: the application's or service's, else the one the trace resolved)
  const target = toAddr || (out.to ? out.to.address : undefined);
  if (out.from && out.from.address && target) {
    if (clientApp) out.handoff = { kind: 'app', device: fromDev, app: clientApp.app.id, text: `Start ${clientApp.text} in the simulation (Network events → Start application)` };
    else out.handoff = { kind: 'send', device: fromDev, iface: out.from.iface, target, proto: svc ? svc.proto : 'icmp', port: svc ? svc.port : undefined, text: `Send ${svc ? svcText(svc) : 'a ping'} from ${fromDev} to ${target} in the simulation (Network events → Send network packets)` };
  }
  return out;
}

/** The path layer: the tracer's outcome over every path; a policy stop is the policy layer's, not a routing failure. */
function pathLayer(t: Trace, o: TraceOutcome): CommLayer {
  const refs: string[] = [];
  const routed = o.groups.filter((g) => g.reason !== 'denied');
  const denied = o.groups.filter((g) => g.reason === 'denied');
  const n = (k: string): number => routed.filter((g) => g.kind === k).reduce((s, g) => s + g.count, 0);
  const total = routed.reduce((s, g) => s + g.count, 0);
  let verdict: Verdict;
  if (!total) verdict = 'indeterminate';
  else if (n('reached') === total) verdict = 'satisfied';
  else if (n('stopped') === total) verdict = 'violated';
  else if (n('reached') === 0 && n('stopped') === 0) verdict = 'beyond';
  else verdict = 'partial';
  for (const g of o.groups) if (g.kind === 'stopped') refs.push('device:' + g.device);
  const lines = outcomeLines(o);
  let text = lines.join('; ');
  if (!total && denied.length) text = `Routing reaches ${denied.map((g) => g.device).join(', ')}, where a policy stops it: the rest of the path is not evaluated`;
  else if (denied.length) text += '; the denied paths are the policy’s';
  if (o.truncated && verdict === 'satisfied') text += ' (not every equal-cost path was evaluated)';
  const detail = o.groups.filter((g) => g.detail).map((g) => `${g.device}: ${g.detail}`);
  void t;
  return { id: 'path', verdict, text, detail, refs };
}

/** The policy layer: the decisions of the filtering devices on the evaluated paths. */
function policyLayer(model: Model, t: Trace, o: TraceOutcome, svc: TraceService | null): CommLayer {
  const denied = o.groups.filter((g) => g.reason === 'denied');
  if (denied.length) {
    const all = denied.reduce((s, g) => s + g.count, 0) === o.total;
    return {
      id: 'policy',
      verdict: all ? 'violated' : 'partial',
      text: `${all ? 'Denied' : 'Denied on some paths'} at ${denied.map((g) => g.device).join(', ')}: ${denied[0].detail || ''}`,
      detail: denied.map((g) => `${g.count} path${g.count === 1 ? '' : 's'} denied at ${g.device}: ${g.detail}`),
      refs: denied.map((g) => 'device:' + g.device),
    };
  }
  // the filtering devices passed, and what they said
  const said: string[] = [];
  const filters = new Set<string>();
  let unknown = false;
  for (const p of t.paths) {
    p.hops.forEach((h, k) => {
      const d = model.index.devices.get(h.device);
      if (!d || k === 0) return;
      const c = capabilities(d);
      if (!(c.firewallPolicy || c.securityGateway || c.vpnOnlyTransit)) return;
      filters.add(h.device);
      for (const x of h.why ? h.why.policy : []) {
        const line = `${h.device}: ${x}`;
        if (said.indexOf(line) < 0) said.push(line);
        if (/give a service/.test(x)) unknown = true;
      }
    });
    for (const h of p.hops) for (const l2 of h.l2) {
      const d = model.index.devices.get(l2);
      if (d && capabilities(d).securityGateway) filters.add(l2);
    }
  }
  if (!filters.size) return { id: 'policy', verdict: 'satisfied', text: 'No modeled policy on the path (router ACLs are not modeled)', detail: [], refs: [] };
  if (unknown || (!svc && filters.size)) return { id: 'policy', verdict: 'indeterminate', text: `${Array.from(filters).join(', ')} filter${filters.size === 1 ? 's' : ''} by service: give a service (or an application) to evaluate the decision`, detail: said, refs: Array.from(filters).map((x) => 'device:' + x) };
  return { id: 'policy', verdict: 'satisfied', text: `Permitted by ${Array.from(filters).join(', ')}`, detail: said, refs: Array.from(filters).map((x) => 'device:' + x) };
}

/** The listener layer: does the reached device take the port on the address the traffic arrives at? */
function listenerLayer(model: Model, t: Trace, o: TraceOutcome, svc: TraceService): CommLayer {
  const port = svc.port as number;
  const proto = svc.proto as 'tcp' | 'udp';
  const reached = t.paths.map((p) => p.end).filter((e) => e.kind === 'reached');
  if (!reached.length) {
    const v: Verdict = o.verdict === 'beyond' ? 'beyond' : 'indeterminate';
    return { id: 'listener', verdict: v, text: v === 'beyond' ? 'The destination is outside the model: its listener is not known' : 'Not evaluated: no path reaches the destination', detail: [], refs: [] };
  }
  const e = reached[0] as { kind: 'reached'; device: string; iface?: string };
  const d = model.index.devices.get(e.device);
  const arrives = `${e.device}${e.iface ? ':' + e.iface : ''}${t.dest ? ' (' + t.dest.address + ')' : ''}`;
  // the DNS and DHCP servers take their ports as services
  const ns = namedServices(d).find((s) => (s.id === 'dns' || s.id === 'dhcp') && s.proto === proto && s.port === port);
  if (ns) {
    if (ns.address && t.dest && ns.address !== t.dest.address) return { id: 'listener', verdict: 'violated', text: `The ${ns.label} of ${e.device} listens on ${ns.address} only; the traffic arrives at ${t.dest.address}`, detail: [], refs: ['device:' + e.device] };
    return { id: 'listener', verdict: 'satisfied', text: `The ${ns.label} of ${e.device} takes ${proto.toUpperCase()} ${port}`, detail: ['A configured listener establishes that the configuration is consistent, not that the service answers.'], refs: ['device:' + e.device] };
  }
  const L = deviceListening(model, e.device, writtenListening(d));
  if (!portsMatch(L.rules, proto, port)) return { id: 'listener', verdict: 'violated', text: `Nothing listens on ${proto.toUpperCase()} ${port} at ${e.device} (${L.text})`, detail: ['The address is reachable; the port is closed: a TCP RST or an ICMP port unreachable in the simulation.'], refs: ['device:' + e.device] };
  const bound = L.written ? null : boundInterfaces(model, e.device, proto, port);
  if (bound && (e.iface === undefined || bound.indexOf(e.iface) < 0)) {
    return { id: 'listener', verdict: 'violated', text: `${proto.toUpperCase()} ${port} at ${e.device} listens on ${bound.join(', ')} only; the traffic arrives at ${arrives}`, detail: ['A listener bound to an interface takes only what is addressed to that interface’s addresses.'], refs: bound.map((b) => `iface:${e.device}:${b}`) };
  }
  const app = appListeners(d).find((x) => x.proto === proto && x.port === port && (x.bind === undefined || x.bind === e.iface));
  const svcL = serviceListeners(d).find((x) => x.proto === proto && x.port === port);
  const who = app ? `the application ${e.device}/${app.app}` : svcL ? `its ${svcL.owner}` : L.written ? 'its listening attribute' : 'a relation it serves';
  return { id: 'listener', verdict: 'satisfied', text: `${proto.toUpperCase()} ${port} at ${arrives}: ${who} listens${app && app.bind ? ' on ' + app.bind : ''}`, detail: ['A configured listener establishes that the configuration is consistent, not that the application accepts or answers.'], refs: ['device:' + e.device] };
}

/** The name layer: the source's resolvers, the path to the first that answers, and its answer. */
function nameLayer(model: Model, dev: string, name: string, qtype: 'A' | 'AAAA', snap: AnalysisSnapshot | null, depth: number, failCtx?: RoutingCtx): { layer: CommLayer; address?: string; legs: Array<{ label: string; check: CommCheck }> } {
  const rs = resolversOf(model, dev);
  if (!rs.length) return { layer: { id: 'name', verdict: 'indeterminate', text: `${dev} has no DNS server configured (no dns_servers, and no DHCP scope that gives one): ${name} can’t be resolved within the model`, detail: [], refs: ['device:' + dev] }, legs: [] };
  const detail: string[] = [];
  const legs: Array<{ label: string; check: CommCheck }> = [];
  for (const r of rs) {
    const owner = addressOwner(model, r.address);
    if (!owner) {
      detail.push(`${r.address} (from ${r.source}) is not an address of the model: its answer is not known`);
      continue;
    }
    const a = answerAt(model, owner, name, qtype);
    detail.push(`${r.address} (${owner}, from ${r.source}): ${a.why}`);
    if (depth === 0) {
      const q = checkCommunication(model, { from: dev, to: owner + '/dns' }, snap, 'Selected endpoints', depth + 1, failCtx);
      legs.push({ label: `DNS query from ${dev} to ${owner} (${r.address})`, check: q });
      if (q.verdict !== 'satisfied' && a.rcode === 'NOERROR' && a.addresses.length) {
        return { layer: { id: 'name', verdict: q.verdict === 'violated' ? 'violated' : 'indeterminate', text: `${owner} would answer ${name} = ${a.addresses[0]}, but the query ${q.verdict === 'violated' ? 'does not get there' : 'is not established'}: ${q.headline}`, detail, refs: ['device:' + owner] }, address: a.addresses[0], legs };
      }
    }
    if (a.rcode === 'NOERROR' && a.addresses.length) return { layer: { id: 'name', verdict: 'satisfied', text: `${name} resolves to ${a.addresses.join(', ')} (${a.server}${a.forwarder ? ', via the forwarder ' + a.forwarder : ''}, zone ${a.zone})`, detail, refs: ['device:' + owner] }, address: a.addresses[0], legs };
    if (a.rcode === 'NXDOMAIN' || a.rcode === 'NOERROR') return { layer: { id: 'name', verdict: 'violated', text: a.why, detail, refs: ['device:' + owner] }, legs };
  }
  return { layer: { id: 'name', verdict: 'indeterminate', text: `No resolver of ${dev} in the model answers ${name}`, detail, refs: [] }, legs };
}

/** The reverse direction: reverse routing back to the source address, and whether it takes the same routers. */
function reverseOf(model: Model, t: Trace, ctx: RoutingCtx): CommCheck['reverse'] {
  const rq = returnRequest(t);
  const lines: string[] = [];
  if (!rq) {
    const tr: Trace = { request: { from: t.request.to, to: t.request.from }, paths: [], truncated: false, error: 'The destination is not a device of the model: there is no way back to trace' };
    return { trace: tr, outcome: traceOutcome(tr), symmetry: 'not comparable', lines: ['Reverse routing is not evaluated: the destination is outside the model.'] };
  }
  const back = tracePath(model, rq, ctx);
  const o = traceOutcome(back);
  const sym = !back.error && o.verdict === 'satisfied' && traceOutcome(t).verdict === 'satisfied' ? (isAsymmetric(t, back) ? 'asymmetric' : 'symmetric') : 'not comparable';
  lines.push(...outcomeLines(o));
  lines.push(sym === 'asymmetric' ? 'Asymmetric: the way back crosses other routers (a stateful device on one way sees only half of the exchange).' : sym === 'symmetric' ? 'Symmetric: the same routers in reverse.' : 'Symmetry is not compared: a direction does not reach.');
  lines.push('Reverse routing only, without a destination port: a TCP session and a stateful firewall’s return decision are not evaluated.');
  return { trace: back, outcome: o, symmetry: sym, lines };
}

function headlineOf(c: CommCheck, layers: CommLayer[]): string {
  const bad = layers.find((l) => l.verdict === 'violated');
  if (bad) {
    if (bad.id === 'policy') return `Blocked by policy: ${bad.text.replace(/^Denied( on some paths)? at /, 'at ')}`;
    if (bad.id === 'listener') return `Reachable, but ${bad.text.charAt(0).toLowerCase()}${bad.text.slice(1)}`;
    if (bad.id === 'path') return `Unreachable: ${bad.text}`;
    if (bad.id === 'name') return `Name resolution fails: ${bad.text}`;
    return bad.text;
  }
  const ind = layers.find((l) => l.verdict === 'indeterminate');
  if (ind) return `Indeterminate: ${ind.text}`;
  const part = layers.find((l) => l.verdict === 'partial');
  if (part) return `Partially reachable: ${part.text}`;
  const out = layers.find((l) => l.verdict === 'beyond');
  if (out) return `Beyond modeled scope: ${out.text}`;
  return c.service && c.service.proto !== 'icmp' ? 'Reachable within scope, and something listens there; runtime behaviour is not established' : 'Reachable within scope';
}

/** A communication check as text lines (exports, Copy as text). */
export function commText(c: CommCheck): string[] {
  const lines: string[] = [];
  lines.push(`Communication check: ${c.request.from} → ${c.request.to || '(its configured peer)'}${c.service ? ', ' + svcText(c.service) : ''}`);
  if (c.error) {
    lines.push(c.error);
    return lines;
  }
  lines.push(`Verdict: ${c.headline}`);
  if (c.from) lines.push(`From: ${c.from.text}`);
  if (c.to) lines.push(`To: ${c.to.text}`);
  for (const l of c.layers) {
    lines.push(`  ${LAYER_LABEL[l.id]}: ${l.verdict} — ${l.text}`);
    for (const d of l.detail) lines.push(`      ${d}`);
  }
  for (const g of c.legs) {
    lines.push(`  ${g.label}: ${g.check.headline}`);
  }
  if (c.reverse) for (const x of c.reverse.lines) lines.push(`  Reverse: ${x}`);
  return lines;
}
