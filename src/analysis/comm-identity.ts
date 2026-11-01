/**
 * The identity of a communication, shared by Analyze and Simulate: the
 * source (device, interface, address), the destination (device,
 * interface, address, a host name, an application or service), the
 * address family, the transport and port, the routing context (VRF), the
 * client application and its profile, and the outcome the analysis found.
 * One communication check makes it (commIdentity), and everything that
 * carries the communication on reads it instead of choosing again:
 *
 *   * the simulation handoff (handoffOf): Network events prefilled with the
 *     same source interface, family, destination and port, never sent; what
 *     can't be carried over faithfully is said, field by field;
 *   * a stale reference (staleProblem): an end that is gone from the model
 *     the simulation runs stops the handoff before anything can be sent;
 *   * the comparison of the static result with what the simulation did
 *     (compareRun), explained from recorded state only;
 *   * a saved expectation (expectationFields), without entering the fields
 *     again.
 *
 * How each end is bound is explicit (Binding): an address written as an
 * address is that exact address; a device, an interface, an application
 * or a service follows the interface's effective address when the message
 * is sent (its configured one, or a DHCP lease); a host name is resolved
 * when it is sent; a client application uses its own configuration when it
 * is started. Pure and deterministic.
 */
import { appProfile } from '../model/applications';
import { parseAddress } from '../model/ip';
import { formatAddr } from './ipmath';
import { autoIpv6 } from '../model/ipv6';
import { Model, deviceInterfaces } from '../model/types';
import { CommCheck, LAYER_LABEL, checkCommunication, parseCommEnd } from './communication';
import { Verdict, verdictText } from './result';
import { AnalysisSnapshot, ADDR_METHOD_TEXT, snapAddrsOf } from './snapshot';
import { TraceService } from './trace';
import type { TestPlan } from './sim/test-plan';
import type { SendRun } from './sim/actions';
import type { Test } from './sim/transport';

/** How an end is bound (see the module comment). */
export type Binding = 'address' | 'interface' | 'name' | 'application';

export const BINDING_TEXT: { [b in Binding]: string } = {
  address: 'this exact address',
  interface: 'the interface’s effective address when sent (configured, or its lease)',
  name: 'resolved by the simulation’s DNS when sent',
  application: 'the application’s own configuration when it is started',
};

export interface CommEndIdentity {
  device?: string;
  iface?: string;
  address?: string;
  /** a host name the destination was given as */
  name?: string;
  /** an application ("device/app") or a service ("device/service") it was given as */
  app?: string;
  binding: Binding;
  /** "eth0 takes its address by DHCP: its lease when the message is sent" */
  note?: string;
}

export interface CommIdentity {
  /** the request as entered (the communication's own fields) */
  request: CommCheck['request'];
  source: CommEndIdentity;
  destination: CommEndIdentity;
  family?: 4 | 6;
  service?: TraceService;
  /** the routing context the analysis used: given, or the source interface's VRF ('' the default table) */
  vrf?: string;
  /** a client application's profile ("tcp_client", "mqtt_client") */
  profile?: string;
  /** the static outcome */
  expected: Verdict;
}

const famOf = (a: string | undefined): 4 | 6 | undefined => {
  const p = a ? parseAddress(a) : null;
  return p ? p.version : undefined;
};

/** Does an interface take its address of a family at runtime (DHCP, SLAAC, DHCPv6)? */
function runtimeAddressed(model: Model, dev: string, iface: string | undefined, v: 4 | 6 | undefined): boolean {
  if (iface === undefined) return false;
  const i = model.index.interfaces.get(dev + ':' + iface);
  if (!i) return false;
  return v === 6 ? autoIpv6(i.ipv6) : v === 4 ? i.dhcp : i.dhcp || autoIpv6(i.ipv6);
}

/**
 * The interface an end stands for when the check did not resolve one (it
 * stopped before tracing, an address only DHCP or SLAAC gives): the
 * interface named, else the device's only interface of the IP stack that
 * has or takes an address (none when it has several: the simulation's
 * routes choose then, and the handoff says so).
 */
function endIface(model: Model, dev: string, named: string | undefined, v: 4 | 6 | undefined): { iface?: string; address?: string } {
  const d = model.index.devices.get(dev);
  if (!d) return {};
  const usable = deviceInterfaces(d).filter((i) => i.type !== 'loopback' && i.type !== 'tunnel' && (i.addresses.length > 0 || i.dhcp || autoIpv6(i.ipv6)));
  const i = named !== undefined ? usable.find((x) => x.id === named) : usable.length === 1 ? usable[0] : undefined;
  if (!i) return named !== undefined ? { iface: named } : {};
  const a = i.addresses.map((x) => x.split('/')[0]).find((x) => !v || famOf(x) === v);
  return a ? { iface: i.id, address: a } : { iface: i.id };
}

/** A device's one interface of the IP stack that has or takes an address (none: several or none). */
function onlyIface(model: Model, dev: string): string | undefined {
  const d = model.index.devices.get(dev);
  const usable = d ? deviceInterfaces(d).filter((i) => i.type !== 'loopback' && i.type !== 'tunnel' && (i.addresses.length > 0 || i.dhcp || autoIpv6(i.ipv6))) : [];
  return usable.length === 1 ? usable[0].id : undefined;
}

/** The identity a communication check resolved (null when it named nothing it could check). */
export function commIdentity(model: Model, c: CommCheck): CommIdentity | null {
  if (c.error || !c.from) return null;
  const from = parseCommEnd(model, c.request.from);
  if (typeof from === 'string') return null;
  // (the family asked for decides; else the one the check's addresses have)
  const fam = c.request.family || famOf(c.from.address) || famOf(c.to ? c.to.address : undefined);
  // (the ends the check resolved; where it stopped first, what the request names)
  const sAt = c.from.iface ? { iface: c.from.iface, address: c.from.address } : endIface(model, c.from.device, from.kind === 'end' && from.end.kind === 'iface' ? from.end.iface : from.kind === 'app' ? from.app.bind : undefined, fam);
  const srcRuntime = runtimeAddressed(model, c.from.device, sAt.iface, fam);
  const source: CommEndIdentity = { device: c.from.device, iface: sAt.iface, address: c.from.address || sAt.address, binding: from.kind === 'app' ? 'application' : from.kind === 'end' && from.end.kind === 'address' ? 'address' : 'interface' };
  if (from.kind === 'app') source.app = from.text;
  if (srcRuntime) source.note = `${c.from.device}:${sAt.iface} takes its address at runtime: the simulation sends from its lease${c.from.address ? ` (the analysis used ${c.from.address})` : ''}`;
  const toText = c.request.to !== undefined && c.request.to.trim() ? c.request.to.trim() : '';
  const to = toText ? parseCommEnd(model, toText) : null;
  const d = c.to || { text: '' };
  const destination: CommEndIdentity = { device: d.device, iface: d.iface, address: d.address, binding: 'interface' };
  // (not resolved by the check: the device or interface the request names)
  if (to && typeof to !== 'string' && to.kind === 'end' && to.end.kind !== 'address' && !destination.iface) {
    const at = endIface(model, to.end.device, to.end.kind === 'iface' ? to.end.iface : undefined, fam);
    destination.device = to.end.device;
    destination.iface = at.iface;
    destination.address = destination.address || at.address;
  }
  if (!to) {
    // a client application's configured peer or broker
    destination.binding = 'application';
  } else if (typeof to !== 'string') {
    if (to.kind === 'name') {
      destination.binding = 'name';
      destination.name = to.name;
    } else if (to.kind === 'end' && to.end.kind === 'address') destination.binding = 'address';
    else if (to.kind === 'app' || to.kind === 'service') destination.app = to.text;
  }
  if (destination.binding === 'interface' && destination.device && runtimeAddressed(model, destination.device, destination.iface, fam)) destination.note = `${destination.device}:${destination.iface} takes its address at runtime: the simulation sends to its lease when the message is sent`;
  const out: CommIdentity = { request: { ...c.request }, source, destination, expected: c.verdict };
  if (fam) out.family = fam;
  if (c.service) out.service = { ...c.service };
  const si = c.from.iface ? model.index.interfaces.get(c.from.device + ':' + c.from.iface) : undefined;
  out.vrf = c.request.vrf !== undefined ? c.request.vrf : si ? si.vrf || '' : undefined;
  if (from.kind === 'app' && from.profile.client) out.profile = from.profile.id;
  return out;
}

/** Send network packets, prefilled from an identity. */
export interface SendPrefill {
  from: string;
  via?: string;
  kind: 'icmp' | 'tcp' | 'udp';
  port?: number;
  /** a device's interface (its effective address when sent: 'dhcp' a lease) */
  to?: string;
  toIface?: string;
  toAddr?: string;
  /** an exact address, or a host name */
  target?: string;
  /** a host name's family (6: its AAAA record) */
  family?: 4 | 6;
  /** the data size (bytes) and Don't fragment: a path MTU test */
  size?: number;
  df?: boolean;
}

/** What preparing a communication in the simulation does. */
export interface Handoff {
  kind: 'send' | 'app';
  /** send: the form's fields */
  prefill?: SendPrefill;
  /** app: the client application to start */
  device: string;
  app?: string;
  /** one line for the button's title and the toast */
  text: string;
  /** what is carried over as it is, and what can't be ("VRF: …") */
  carried: string[];
  notTransferred: string[];
}

/** The simulation handoff of an identity (see the module comment): the same choices, nothing picked again, nothing sent. */
export function handoffOf(model: Model, id: CommIdentity): Handoff | null {
  const s = id.source;
  if (!s.device) return null;
  const svc = id.service;
  // (no service in the question: the send proposes an ICMP echo — a test choice, said as one, not what was asked)
  const svcText = svc ? (svc.proto === 'icmp' ? 'ICMP' : `${svc.proto.toUpperCase()} ${svc.port}`) : 'ICMP (ping)';
  const carried: string[] = [];
  const not: string[] = [];
  if (s.binding === 'application' && id.profile && s.app) {
    const app = s.app.slice(s.app.indexOf('/') + 1);
    const p = appProfile(id.profile);
    carried.push(`Start ${s.app}: its ${p ? p.short : 'application'} uses its own configured ${id.profile === 'mqtt_client' ? 'broker' : 'peer'}, transport and port`);
    if (id.request.to) not.push(`Destination: ${s.app} sends to its configured ${id.profile === 'mqtt_client' ? 'broker' : 'peer'}; the destination given here (${id.request.to}) is not part of starting it`);
    return { kind: 'app', device: s.device, app, text: `Start ${s.app} in the simulation (Network events → Start application)`, carried, notTransferred: not };
  }
  const t = id.destination;
  const pre: SendPrefill = { from: s.device, kind: svc ? svc.proto : 'icmp' };
  if (s.iface) pre.via = s.iface;
  else not.push(`Source interface: the check resolved none (${s.device} has several): the simulation’s routes choose it`);
  // an exact source address: a send names the interface, which sends from an address of its own choosing (its first usable
  // one of the family) — said when the interface has others, and a run counts as this check's only if it was sent from it
  if (s.binding === 'address' && s.address && s.iface) {
    const i = model.index.interfaces.get(s.device + ':' + s.iface);
    const fam = famOf(s.address);
    const same = i ? i.addresses.map((x) => x.split('/')[0]).filter((x) => famOf(x) === fam) : [];
    if (same.length > 1) not.push(`Source address: a send names ${s.device}:${s.iface}, which has ${same.length} IPv${fam} addresses (${same.join(', ')}), not the address ${s.address}: it sends from the one it chooses — only a run actually sent from ${s.address} is compared with this check`);
  }
  if (svc && svc.proto !== 'icmp') pre.port = svc.port;
  carried.push(`Source: ${s.device}${s.iface ? ':' + s.iface : ''}${s.address ? ` (${s.binding === 'address' ? s.address : s.note ? 'its lease when sent' : s.address})` : ''}`);
  if (t.binding === 'name' && t.name) {
    pre.target = t.name;
    if (id.family) pre.family = id.family;
    carried.push(`Destination: ${t.name}, ${BINDING_TEXT.name}${id.family === 6 ? ' (its AAAA record)' : ''}`);
  } else if (t.binding === 'address' && t.address) {
    pre.target = t.address;
    carried.push(`Destination: ${t.address}, ${BINDING_TEXT.address}`);
  } else if (t.device && t.iface && (t.address || t.note)) {
    pre.to = t.device;
    pre.toIface = t.iface;
    pre.toAddr = t.note ? 'dhcp' : (t.address as string);
    carried.push(`Destination: ${t.device}:${t.iface}, ${t.note ? 'its lease when sent' : t.address}${t.app ? ` (${t.app})` : ''}`);
    if (t.note && id.family === 6) not.push(`Destination: ${t.device}:${t.iface} takes its IPv6 address by SLAAC or DHCPv6; the simulation offers its configured addresses only: choose the address under To`);
  } else if (t.address) {
    pre.target = t.address;
    carried.push(`Destination: ${t.address}`);
  } else return null;
  carried.push(`Protocol: ${svcText}${id.family ? `, IPv${id.family}` : ''}${svc ? '' : ' — proposed: the question gives no service'}`);
  // the routing context: the simulation sends in the source interface's VRF
  const si = s.iface ? model.index.interfaces.get(s.device + ':' + s.iface) : undefined;
  if (id.request.vrf !== undefined && si && (si.vrf || '') !== id.request.vrf) not.push(`VRF: the simulation sends in the VRF of ${s.device}:${s.iface} (${si.vrf || 'the default table'}); the VRF chosen here (${id.request.vrf || 'the default table'}) can't be set for a send`);
  not.push('Expected outcome: a send has none of its own; compare the result after it ran (Compare matching observation)');
  return { kind: 'send', device: s.device, prefill: pre, text: `Send ${svcText} from ${s.device} to ${pre.target || `${pre.to}:${pre.toIface}`} in the simulation (Network events → Send network packets)`, carried, notTransferred: not };
}

/**
 * Why a handoff can't be prepared in the model the simulation runs (an end
 * gone, renamed or without the interface or application): null when every
 * reference resolves.
 */
export function staleProblem(simModel: Model, id: CommIdentity): string | null {
  const ends: Array<[string, CommEndIdentity]> = [['source', id.source], ['destination', id.destination]];
  for (const [what, e] of ends) {
    if (e.device && !simModel.index.devices.has(e.device)) return `The ${what} ${e.device} is not in the model the simulation runs: refresh the check, or start the simulation again`;
    if (e.device && e.iface && !simModel.index.interfaces.has(e.device + ':' + e.iface)) return `${e.device} has no interface ${e.iface} in the model the simulation runs: refresh the check`;
    if (e.app) {
      const x = parseCommEnd(simModel, e.app);
      if (typeof x === 'string') return `${e.app}: ${x} (in the model the simulation runs): refresh the check`;
    }
  }
  return null;
}

/**
 * Does a send's plan carry this identity — every field a send can carry,
 * by its binding: the source device and its interface (the one the check
 * resolved; none: as the routes choose, never another one), the
 * destination (a host name that name, in IPv4 only: a send resolves an A
 * record; an exact address that address; a device's interface that
 * interface and its address, or its lease when it takes one at runtime),
 * the family, the transport and port, and the routing context (a send's is
 * its source interface's VRF). A send that differs in any of them is no
 * evidence for the check.
 */
export function planMatches(id: CommIdentity, p: TestPlan, model?: Model): boolean {
  if (p.delivery !== 'unicast' || !id.source.device || p.from !== id.source.device) return false;
  const svc = id.service;
  if ((svc ? svc.proto : 'icmp') !== p.kind) return false;
  if (svc && svc.proto !== 'icmp' && p.port !== svc.port) return false;
  // (a device with one interface of the IP stack: a send that names none goes from it all the same — the form leaves it out)
  if ((p.via || undefined) !== (id.source.iface || undefined) && !(p.via === undefined && model && onlyIface(model, id.source.device) === id.source.iface)) return false;
  const t = id.destination;
  if (t.binding === 'application') return false;
  if (t.binding === 'name') {
    // the name, and the record its family asks for: AAAA for IPv6, A otherwise (a plan without a family resolves A)
    if (p.target !== t.name || (p.family || 4) !== (id.family || 4)) return false;
  } else if (t.binding === 'address') {
    // (that exact address: typed, or a device's interface sent to with it — not its lease)
    if (p.target !== t.address && !(p.target === undefined && p.toAddr === t.address)) return false;
  } else if (p.target !== undefined) {
    // (a device's address typed as an address: the same only when it is no lease that may change)
    if (t.note || p.target !== t.address) return false;
  } else if (p.to !== t.device || p.toIface !== t.iface || p.toAddr !== (t.note ? 'dhcp' : t.address)) return false;
  const sent = famOf(p.toAddr && p.toAddr !== 'dhcp' ? p.toAddr : p.target);
  if (id.family && sent && sent !== id.family) return false;
  if (p.toAddr === 'dhcp' && id.family === 6) return false;
  if (model && id.vrf !== undefined && id.source.iface) {
    const si = model.index.interfaces.get(id.source.device + ':' + id.source.iface);
    if (si && (si.vrf || '') !== id.vrf) return false;
  }
  return true;
}

/**
 * Does a send carry this identity, as it was sent: its plan (planMatches) and, for a check bound to an exact
 * source address, every message of it sent from that address (Test.srcAddr, as the transport chose it) — an
 * interface carried is not an address carried.
 */
export function runMatches(id: CommIdentity, run: SendRun, model?: Model): boolean {
  if (!planMatches(id, run.plan, model)) return false;
  // as sent: each message's effective destination of the family asked for (a host name resolved when it was sent: its
  // address may change from one message to the next — never its family); an unresolved name's placeholder is no identity
  if (id.family && run.tests.some((t) => sentTo(t) && t.dst.version !== id.family)) return false;
  const s = id.source;
  if (s.binding !== 'address' || !s.address) return true;
  const sent = run.tests.filter((t) => t.srcAddr !== undefined);
  return sent.length > 0 && sent.every((t) => t.srcAddr === s.address);
}

/** Did a message get an effective destination of its own (a host name resolved, or an address given)? */
function sentTo(t: Test): boolean {
  return !(t.target && parseAddress(t.target) === null && t.resolved === undefined);
}

const svcWords = (x: TraceService | undefined): string => (x ? (x.proto === 'icmp' ? 'ICMP' : `${x.proto.toUpperCase()} ${x.port}`) : 'no service');

/**
 * Does a client application's run answer a question — null — or why not, said: the question's destination, service,
 * family and routing context against the application's own communication (its configured peer or broker, transport and
 * port, as the static check of the application resolves them) and against what its messages did as sent (each one's
 * destination family, transport and port). A question from the application without a destination of its own asks its
 * configured communication. A handoff's warning never makes a different communication this one's. Shared by every
 * comparison of an application's run (TCP and UDP clients, MQTT clients).
 */
export function appRunProblem(model: Model, id: CommIdentity, run: { tests: readonly Test[] }): string | null {
  const app = id.source.app;
  if (id.source.binding !== 'application' || !app) return 'the question is not asked from a client application';
  const own = commIdentity(model, checkCommunication(model, { from: app }));
  if (!own) return `${app}’s own communication can’t be resolved`;
  const t = id.destination;
  const o = own.destination;
  if (id.request.to) {
    const theirs = o.device ? `${o.device}${o.address ? ` (${o.address})` : ''}` : o.address || 'its configured peer';
    const asked = t.name || (t.device ? `${t.device}${t.address ? ` (${t.address})` : ''}` : t.address || id.request.to);
    if ((t.device && o.device && t.device !== o.device) || (t.address && o.address && t.address !== o.address && !t.note)) return `destination: ${app} sends to ${theirs}, the question asks about ${asked}`;
  }
  if (id.service && own.service && (id.service.proto !== own.service.proto || (id.service.proto !== 'icmp' && id.service.port !== own.service.port))) return `service: ${app} uses ${svcWords(own.service)}, the question asks about ${svcWords(id.service)}`;
  if (id.family && own.family && id.family !== own.family) return `family: ${app} uses IPv${own.family}, the question asks about IPv${id.family}`;
  if (id.vrf !== undefined && own.vrf !== undefined && id.vrf !== own.vrf) return `routing context: ${app} sends in ${own.vrf || 'the default table'}, the question asks about ${id.vrf || 'the default table'}`;
  // as sent (a name resolved when sent, a lease when sent: only what its messages show)
  for (const m of run.tests) {
    if (id.service && id.service.proto !== 'icmp' && (m.kind !== id.service.proto || m.port !== id.service.port)) return `service: its message ${m.msg || 1} went as ${svcWords({ proto: m.kind, port: m.port } as TraceService)}, the question asks about ${svcWords(id.service)}`;
    if (id.family && sentTo(m) && m.dst.version !== id.family) return `family: its message ${m.msg || 1} went over IPv${m.dst.version}, the question asks about IPv${id.family}`;
  }
  return null;
}

/** The static result beside what the simulation did, and why they differ. */
export interface RunComparison {
  /** the static verdict, and what the simulation's messages did so far (delivered, failed — not sent at all included —, both, nothing yet) */
  expected: Verdict;
  runtime: 'delivered' | 'failed' | 'mixed' | 'pending';
  /**
   * the run is settled: every message sent (or the rest cancelled by Stop) and each delivered or failed; until then
   * the comparison is provisional — the evidence so far, never a final agreement
   */
  final: boolean;
  /** its messages: delivered, failed (not sent at all included), on their way, still to be sent, cancelled by Stop */
  counts: { delivered: number; failed: number; pending: number; unsent: number; cancelled: number };
  /** final, and they agree (never while provisional) */
  agree: boolean;
  /** the evidence for a difference (empty when they agree, or when nothing recorded explains it: then `unexplained`) */
  lines: string[];
  unexplained?: string;
  /** the run's results, message by message (at most 5) */
  results: string[];
}

/**
 * A run compared with a static result: a send, or a client application's run (its messages by their last attempt, apps.ts
 * lastAttempts; `count` null: until stopped).
 */
export interface RunRecord {
  tests: Test[];
  skipped: Array<{ n: number; t: number; why: string }>;
  count: number | null;
  sent: number;
  stopped: boolean;
}

/**
 * Compare a communication's static result with a run of the simulation
 * that carries it. A difference is explained from recorded state only:
 * the snapshot taken now (the address a lease gave, a route or adjacency
 * that is or is not there, an end that is off), the run's structured
 * outcomes (each distinct one, as its sender recorded it), and the layers
 * the static analysis did not evaluate. Nothing is inferred from the
 * outcome alone, and a state seen later explains nothing about the send:
 * only the difference is said.
 */
export function compareRun(model: Model, check: CommCheck, run: SendRun | RunRecord, snap: AnalysisSnapshot): RunComparison {
  const tests = run.tests;
  const done = tests.filter((t) => t.done);
  const ok = done.filter((t) => t.ok);
  // (a message that could not be sent at all is a failure of the run; what Stop cancelled is no result either way)
  const failed = done.length - ok.length + run.skipped.length;
  const ongoing = run.count === null && !run.stopped;
  const left = run.count === null ? 0 : Math.max(0, run.count - run.sent);
  const counts = { delivered: ok.length, failed, pending: tests.length - done.length, unsent: run.stopped ? 0 : left, cancelled: run.stopped ? left : 0 };
  const final = counts.pending === 0 && counts.unsent === 0 && !ongoing;
  const runtime: RunComparison['runtime'] = !ok.length && !failed ? 'pending' : !failed ? 'delivered' : ok.length ? 'mixed' : 'failed';
  const results = tests.slice(0, 5).map((t) => `#${t.msg || 1}: ${t.done ? t.result : 'on its way'}`).concat(run.skipped.slice(0, 2).map((x) => `#${x.n}: ${x.why}`));
  if (counts.cancelled) results.push(`${counts.cancelled} message${counts.cancelled === 1 ? '' : 's'} not sent: stopped`);
  const expected = check.verdict;
  const consistent = (expected === 'satisfied' && runtime === 'delivered') || (expected === 'violated' && runtime === 'failed') || (expected === 'partial' && runtime !== 'pending');
  const agree = final && consistent;
  const out: RunComparison = { expected, runtime, final, counts, agree, lines: [], results };
  if (agree) return out;
  // provisional: explained only where the evidence so far already differs (a failure where it should pass, a delivery where it should not)
  const differsSoFar = (expected === 'satisfied' && failed > 0) || (expected === 'violated' && ok.length > 0);
  if (!final && !differsSoFar) return out;
  if (final && runtime === 'pending') {
    out.unexplained = 'Nothing was sent: the run was stopped before its first message.';
    return out;
  }
  // the same check on the simulation's state now: which layer differs
  const now = checkCommunication(model, check.request, snap, 'Selected endpoints', 0);
  const layer = (c: CommCheck, id: string) => c.layers.find((l) => l.id === id);
  const at = `t = ${(snap.at / 1000).toFixed(1)} s`;
  for (const id of ['address', 'name', 'path', 'policy', 'listener'] as const) {
    const a = layer(check, id);
    const b = layer(now, id);
    // (a layer the configured model could not evaluate is said by the layer that stopped it)
    if (!a || !b || a.verdict === b.verdict || /^Not traced/.test(a.text)) continue;
    if (id === 'address') {
      if (a.verdict === 'indeterminate' && b.verdict === 'satisfied') {
        const acq = check.from ? snapAddrsOf(snap, check.from.device).concat(check.to && check.to.device ? snapAddrsOf(snap, check.to.device) : []) : [];
        out.lines.push(`Address acquired at runtime: the configured model has none to check with; at ${at} ${acq.length ? acq.map((x) => `${x.device}:${x.iface} has ${x.text} (${ADDR_METHOD_TEXT[x.method]}, ${x.state})`).join(', ') : 'the ends have their addresses'}`);
      } else out.lines.push(`Address not yet acquired at ${at}: ${b.detail[0] || b.text}`);
    } else if (id === 'path') {
      const rel = (now.outcome ? now.outcome.groups : []).find((g) => g.kind === 'stopped');
      const down = (check.trace && check.trace.paths[0] ? check.trace.paths[0].hops : []).flatMap((h) => h.relations || []).filter((r) => snap.ctx.relUp && !snap.ctx.relUp(r));
      if (down.length) out.lines.push(`Adjacency not established at ${at}: ${down.join(', ')} ${down.length === 1 ? 'is' : 'are'} not up, so the route the static path uses is not learned yet`);
      else if (rel) out.lines.push(`At ${at} the route is not there: the path stops at ${rel.device} (${rel.detail || rel.reason}); the configured model routes it`);
      else out.lines.push(`${LAYER_LABEL.path} at ${at}: ${b.text} (the configured model: ${a.text})`);
    } else out.lines.push(`${LAYER_LABEL[id]} at ${at}: ${b.text} (the configured model: ${a.text})`);
  }
  // an end that is unavailable at runtime
  for (const dev of [check.from ? check.from.device : undefined, check.to ? check.to.device : undefined]) {
    if (dev && snap.down.indexOf('device:' + dev) >= 0) out.lines.push(`Runtime endpoint unavailable: ${dev} is down at ${at}`);
  }
  // the run's own record: each distinct structured outcome once (its first message), never the result's words
  const nowOk = now.verdict === 'satisfied';
  const later = nowOk ? `; the simulation’s state at ${at} routes it — what changed between the send and then is not established by this comparison` : '';
  const seen = new Set<string>();
  for (const t of done.filter((x) => !x.ok)) {
    const sent = `t = ${(t.started / 1000).toFixed(1)} s`;
    const o = t.outcome;
    // (the drop that decided it: one of its own attempts, the last recorded)
    const ds = o ? (o.drops || (o.drop ? [o.drop] : [])).filter((x) => x.attempt) : [];
    const d = ds.length ? ds[ds.length - 1] : null;
    const c = d && d.cause ? d.cause : null;
    const key = `${o ? o.kind : ''}|${o ? o.by || '' : ''}|${o ? o.reason || '' : ''}|${c ? c.kind + ':' + (c.policy ? c.policy.device + ':' + (c.policy.rule || '') : '') : ''}`;
    if (seen.has(key) || seen.size >= 3) continue;
    seen.add(key);
    if (o && o.kind === 'unreachable' && o.reason === 'policy' && o.cause && o.cause.policy) {
      out.lines.push(`Policy at runtime (${sent}): ${o.cause.policy.device} rejected it (${o.cause.policy.rule ? 'rule ' + o.cause.policy.rule : o.cause.policy.byDefault ? 'its default action' : o.cause.policy.ruleText || 'its policy'}) and answered ${o.icmp}`);
    } else if (o && o.kind === 'unreachable' && (o.icmp === 'Net Unreachable' || o.icmp === 'No Route')) {
      out.lines.push(`Route not there when sent (${sent}): ${o.by || 'a router'} had no route to ${formatAddr(t.dst)} and answered ${o.icmp}; the configured model routes it${later}`);
    } else if (o && o.kind === 'unreachable' && (o.icmp === 'Host Unreachable' || o.icmp === 'Address Unreachable')) {
      out.lines.push(`Next hop not resolved when sent (${sent}): ${o.by || 'a router'} answered ${o.icmp} — it had a route, the destination or next hop did not answer ARP / NDP${nowOk ? ` (at ${at} the state routes it; what changed is not established)` : ''}`);
    } else if (o && o.kind === 'not-sent' && o.down) {
      out.lines.push(`Interface down when sent (${sent}): ${o.down} was not up (a link coming up, shut, or failed); the configured model routes from it${nowOk ? `; at ${at} the state routes it` : ''}`);
    } else if (c && c.kind === 'neighbor') {
      out.lines.push(`Next hop not resolved when sent (${sent}): ${d ? d.device : ''} had a route, but ${c.neighbor || 'its next hop'} did not answer ${t.dst.version === 6 ? 'NDP' : 'ARP'}${c.iface ? ' on ' + c.iface : ''}; that is no missing route${nowOk ? ` (at ${at} the state routes it; what changed is not established)` : ''}`);
    } else if (c && (c.kind === 'no-route' || c.kind === 'blackhole')) {
      out.lines.push(`Route not there when sent (${sent}): ${d ? d.device : ''} had ${c.kind === 'blackhole' ? 'a blackhole route' : 'no route'} for it${c.vrf ? ' in VRF ' + c.vrf : ''}; the configured model routes it${later}`);
    } else if ((o && o.kind === 'too-big') || (c && c.kind === 'too-big')) {
      out.lines.push(`Packet too big when sent (${sent}): ${o && o.mtu ? `the path takes ${o.mtu} bytes` : c && c.mtu ? `${d ? d.device : ''}${c.iface ? ':' + c.iface : ''} takes ${c.mtu} bytes` : 'larger than the path takes'}. The static path MTU is in the Path MTU section: a packet larger than it, with Don’t fragment (or IPv6), is dropped with Fragmentation Needed / Packet Too Big, and the sender learns the path MTU (PMTUD)`);
    } else if (c && (c.kind === 'iface-down' || c.kind === 'cable' || c.kind === 'tunnel-down' || c.kind === 'relation-failed')) {
      out.lines.push(`Unavailable when sent (${sent}): at ${d ? d.device : ''} ${c.kind === 'cable' ? 'cable ' + c.link + ' was down' : c.kind === 'tunnel-down' ? 'tunnel ' + c.iface + ' was down' : c.kind === 'relation-failed' ? (c.relation || 'a relation') + ' had failed' : (c.iface || 'an interface') + ' was down'}`);
    } else if (c && c.kind === 'policy' && c.policy) {
      out.lines.push(`Policy at runtime (${sent}): ${c.policy.device} ${c.policy.action === 'undecided' ? 'could not decide on' : 'denied'} it (${c.policy.rule ? 'rule ' + c.policy.rule : c.policy.byDefault ? 'its default action' : c.policy.ruleText || 'its policy'})`);
    } else if (o && (o.kind === 'refused' || o.kind === 'lost') && o.reason === 'policy' && o.cause && o.cause.policy) {
      out.lines.push(`Policy at runtime (${sent}): ${o.cause.policy.device} rejected the connection (${o.cause.policy.rule ? 'rule ' + o.cause.policy.rule : o.cause.policy.byDefault ? 'its default action' : o.cause.policy.ruleText || 'its policy'}) with a RST carrying the destination’s address`);
    } else if (o && (o.kind === 'refused' || (o.kind === 'unreachable' && o.icmp === 'Port Unreachable') || o.kind === 'lost')) {
      const lis = layer(check, 'listener');
      const said = o.reason === 'closed' ? `${o.by || 'the destination'} recorded the port as closed` : o.reason === 'no-connection' ? `${o.by || 'the destination'} had no connection for it` : o.kind === 'lost' ? 'the connection was lost' : `${o.by || 'a device'} answered without recording why`;
      out.lines.push(`The destination answered “${t.result}” (${sent}): ${said}. ${lis && lis.verdict === 'satisfied' ? 'Static analysis found a configured listener; whether the application accepts the connection is runtime behaviour it does not evaluate.' : 'Static analysis did not establish a listener there.'}`);
    } else if (!out.lines.length && o && o.kind === 'timeout') {
      out.lines.push(`No answer (${sent}): ${t.result}. Static analysis did not evaluate that behavior: the answer and its way back are runtime behaviour.`);
    }
  }
  if (runtime === 'delivered' && expected !== 'satisfied' && !out.lines.length) {
    const why = check.layers.filter((l) => l.id !== 'runtime' && l.verdict !== 'satisfied');
    if (why.some((l) => l.verdict === 'indeterminate' || l.verdict === 'unsupported')) out.lines.push(`Static analysis did not establish it: ${why.map((l) => `${LAYER_LABEL[l.id]} ${verdictText(l.verdict, 'check').toLowerCase()} (${l.text})`).join('; ')}; the simulation exchanged it.`);
  }
  if (!out.lines.length && (final || differsSoFar)) out.unexplained = `The static result (${verdictText(expected, 'reach')}) and the simulation (${runtime}${final ? '' : ', so far'}) differ, and the recorded state at ${at} does not explain it: compare the hop evidence with the event log.`;
  return out;
}

/** The fields of a saved expectation for an identity: nothing entered again. */
export function expectationFields(id: CommIdentity): { from: string; to?: string; service?: string; vrf?: string; family?: 4 | 6; expect: 'available' | 'blocked' } {
  const r = id.request;
  const out: { from: string; to?: string; service?: string; vrf?: string; family?: 4 | 6; expect: 'available' | 'blocked' } = { from: r.from, expect: id.expected === 'violated' ? 'blocked' : 'available' };
  if (r.to) out.to = r.to;
  if (r.service) out.service = r.service;
  else if (id.service && id.service.proto !== 'icmp' && id.destination.binding !== 'application') out.service = `${id.service.proto}/${id.service.port}`;
  if (r.vrf !== undefined) out.vrf = r.vrf;
  if (r.family) out.family = r.family;
  return out;
}
