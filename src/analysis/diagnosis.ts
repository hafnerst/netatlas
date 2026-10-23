/**
 * Diagnosis: the answer to one communication question, built from the
 * evidence the analysis and the simulation recorded — never from a log
 * line's words, never from the current state passed off as the past.
 *
 *   static     the communication check (communication.ts) of the configured
 *              model or a snapshot: what the architecture establishes, and
 *              what prevents or limits it, layer by layer, with the refs of
 *              the hops, rules and interfaces that decided;
 *   runtime    a recorded send of the same communication (comm-identity.ts
 *              runMatches): each message's structured outcome, the drop
 *              recorded when it happened (its cause: the kind, the packet,
 *              the rule), what it waited for, its retransmissions, its DNS
 *              queries, the equal-cost branch it took.
 *
 * Each link of the evidence chain says how it relates to the question:
 *
 *   cause         recorded as what decided it (a drop's cause, an ICMP error,
 *                 a RST, a layer that is violated);
 *   prerequisite  something it needs or waited for (an address, a lease, a
 *                 neighbour, a tunnel), established or not;
 *   related       a recorded observation about the same exchange that does
 *                 not by itself decide it (a later state, a static layer);
 *   coincidence   something that happened near it in time, not linked to it
 *                 by any record — shown only as such, never as a cause;
 *   hypothesis    what the evidence cannot establish, said as a question.
 *
 * No single root cause is claimed where several independent blockers or
 * alternatives exist. Unknown or unsupported is never success, a later
 * working state never explains an earlier send, a publication reaching the
 * broker is not a subscriber's receipt, and a timed-out operation stays
 * timed out whatever arrives later. Pure and deterministic.
 */
import { CommCheck, CommLayer, LAYER_LABEL } from './communication';
import { RunComparison } from './comm-identity';
import { PathMtu } from './mtu';
import { AnalysisContext, Verdict, contextText, verdictText } from './result';
import type { SendRun } from './sim/actions';
import type { Test } from './sim/transport';
import type { SimEvent } from './sim/types';
import { formatAddr } from './ipmath';

export type LinkKind = 'cause' | 'prerequisite' | 'related' | 'coincidence' | 'hypothesis';

/** A piece of recorded evidence to navigate to: a diagram object, a recorded event, a packet, a rule. */
export interface EvidenceRef {
  /** "device:r1", "iface:r1:wan", "relation:gre1", "policy:fw:3", "event:1234", "test:7", "layer:policy", "mtu" */
  ref: string;
  label: string;
}

export interface ChainLink {
  rel: LinkKind;
  /** where it was recorded: the static check (configured or snapshot), a runtime message */
  source: 'static' | 'runtime';
  text: string;
  refs: EvidenceRef[];
  /** recorded at (simulated ms) */
  t?: number;
}

/** What the diagnosis says of the question as a whole. */
export type DiagnosisState =
  | 'established' // the evidence establishes it (statically; at run time when a send was compared)
  | 'blocked' // a recorded cause prevents it
  | 'waiting' // a prerequisite is pending (boot, address, neighbour, route, tunnel): not a failure (yet)
  | 'recovered' // it completed after a loss (a retransmission, a DNS fallback)
  | 'partial' // alternatives or messages differ
  | 'cancelled'
  | 'indeterminate' // the evidence does not establish it either way
  | 'unsupported';

export interface NextAction {
  /** the existing action it is: refresh, handoff, compare, mtu-test, save-exp, experiment, goto */
  id: 'refresh' | 'handoff' | 'compare' | 'mtu-test' | 'save-exp' | 'experiment' | 'goto';
  label: string;
  /** why it is offered, from the evidence */
  why: string;
  ref?: string;
}

/** A leg of the question answered on its own (MQTT: the publisher to the broker, the broker to each subscriber). */
export interface DiagnosisLeg {
  label: string;
  verdict: Verdict;
  state: DiagnosisState;
  text: string;
  refs: EvidenceRef[];
}

export interface Diagnosis {
  question: {
    from: string;
    to: string;
    family: string;
    service: string;
    vrf: string;
    context: string;
    /** the recorded send compared, when one is: "send #3 (pc → srv), 2 messages" */
    run?: string;
    /** exact choices and what is still open ("Source address: the route's egress when sent") */
    exact: string[];
    unresolved: string[];
  };
  /** the static verdict (result.ts), the question's answer as the configured model / snapshot gives it */
  verdict: Verdict;
  state: DiagnosisState;
  /** one line */
  summary: string;
  established: string[];
  /** the independent blockers, waiting conditions or limitations (each with its evidence) */
  blockers: ChainLink[];
  /** the evidence chain, in order: what happened and why, as far as the records go */
  chain: ChainLink[];
  legs: DiagnosisLeg[];
  next: NextAction[];
  limits: string[];
  outdated: boolean;
  /** a send still running: the runtime part is provisional */
  provisional: boolean;
  /** evidence it would need is no longer retained (the log was trimmed, the test aged out) */
  evidenceLimited: boolean;
}

/** The runtime record of the send compared (Simulation: the run, its events, what its messages waited for). */
export interface RuntimeEvidence {
  run: SendRun;
  /** the events of the run's messages (by test id or packet id), in log order */
  events: SimEvent[];
  waits: (test: number) => Array<{ cond: string; why: string; since: number; until?: number }>;
  /** the log's retention: the oldest event still kept, and how many were dropped */
  log: { first: number; dropped: number };
  now: number;
  comparison?: RunComparison;
}

/** An MQTT leg's runtime counters (what the simulation recorded for the client applications). */
export interface MqttEvidence {
  publisher?: { dev: string; app: string; published: number; acked: number; qos: number; state: string };
  subscribers: Array<{ dev: string; app: string; received: number; state: string }>;
}

export interface DiagnosisInput {
  check: CommCheck;
  context: AnalysisContext;
  mtu?: PathMtu | null;
  runtime?: RuntimeEvidence | null;
  mqtt?: MqttEvidence | null;
  outdated?: boolean;
  /** a send can be prepared (a simulation runs the model) */
  canPrepare?: boolean;
}

const sec = (ms: number): string => `t = ${(ms / 1000).toFixed(1)} s`;
const dur = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The refs of a static layer, as evidence. */
function layerRefs(l: CommLayer): EvidenceRef[] {
  return [{ ref: 'layer:' + l.id, label: LAYER_LABEL[l.id] }].concat(l.refs.slice(0, 6).map((r) => ({ ref: r, label: r.replace(/^[a-z]+:/, '') })));
}

/** Waiting for what: a condition's words. */
function waitWords(cond: string): string {
  if (cond === 'lease') return 'an address (DHCP lease)';
  if (cond === 'dns') return 'name resolution';
  if (cond === 'neighbor') return 'neighbour resolution';
  if (cond === 'rel') return 'a tunnel or session to come up';
  if (cond === 'route') return 'a route';
  if (cond === 'll') return 'a link-local address';
  return cond;
}

/** What a recorded drop cause is, in words, and the refs it names. */
function dropLink(ev: { seq: number; t: number; device: string; cause?: SimEvent['cause']; text: string }, testId: number): ChainLink {
  const c = ev.cause;
  const refs: EvidenceRef[] = [{ ref: 'event:' + ev.seq, label: 'event at ' + sec(ev.t) }, { ref: 'device:' + ev.device, label: ev.device }];
  let text = `its packet was dropped at ${ev.device} (${sec(ev.t)}): ${ev.text.replace(/^dropped at [^:]+: /, '')}`;
  if (c) {
    if (c.pkt !== undefined) refs.push({ ref: `packet:${testId}:${c.pkt}`, label: c.flow ? c.flow : 'packet ' + c.pkt });
    if (c.iface) refs.push({ ref: `iface:${ev.device}:${c.iface}`, label: `${ev.device}:${c.iface}` });
    if (c.link) refs.push({ ref: 'link:' + c.link, label: c.link });
    if (c.relation) refs.push({ ref: 'relation:' + c.relation, label: c.relation });
    if (c.policy) {
      refs.push({ ref: `policy:${c.policy.device}${c.policy.rule ? ':' + c.policy.rule : ''}`, label: c.policy.rule ? `${c.policy.device} rule ${c.policy.rule}` : `${c.policy.device} ${c.policy.byDefault ? 'default action' : c.policy.ruleText || 'policy'}` });
      const by = c.policy.rule ? `rule ${c.policy.rule}${c.policy.ruleText ? ' (' + c.policy.ruleText + ')' : ''}` : c.policy.byDefault ? 'the default action' : c.policy.ruleText || 'its policy';
      text = `${c.policy.device} ${c.policy.action === 'reject' ? 'rejected' : c.policy.action === 'undecided' ? 'could not decide on' : 'denied'} its packet${c.flow ? ' ' + c.flow : ''} (${sec(ev.t)}): ${by}${c.policy.text && c.policy.text !== by ? ' — ' + c.policy.text : ''}`;
    } else if (c.kind === 'no-route' || c.kind === 'blackhole') text = `${ev.device} had ${c.kind === 'blackhole' ? 'a blackhole route' : 'no route'} for it when it arrived (${sec(ev.t)})${c.vrf ? ' in VRF ' + c.vrf : ''}`;
    else if (c.kind === 'too-big') text = `its packet was larger than ${ev.device}${c.iface ? ':' + c.iface : ''} takes, ${c.mtu} bytes (${sec(ev.t)})`;
  }
  return { rel: 'cause', source: 'runtime', text, refs, t: ev.t };
}

/** One message's chain: its outcome and what the records say about it. */
function messageChain(t: Test, rt: RuntimeEvidence): { state: DiagnosisState; links: ChainLink[]; summary: string } {
  const links: ChainLink[] = [];
  const testRef: EvidenceRef = { ref: 'test:' + t.id, label: `message ${t.msg || 1}` };
  // what it waited for (the transport's own and the engine's): prerequisites, established once they ended
  const waits = (t.waits || []).concat(rt.waits(t.id));
  for (const w of waits) {
    const open = w.until === undefined;
    links.push({ rel: 'prerequisite', source: 'runtime', text: open ? `it waits for ${waitWords(w.cond)}: ${w.why} (since ${sec(w.since)})` : `it waited ${dur((w.until as number) - w.since)} for ${waitWords(w.cond)}: ${w.why}`, refs: [testRef], t: w.since });
  }
  // the DNS queries before the answer
  const dns = t.dns || [];
  const lostDns = dns.filter((x) => x.outcome === 'lost' || x.outcome === 'refused');
  if (!t.done) {
    const pending = waits.filter((w) => w.until === undefined);
    return { state: pending.length ? 'waiting' : 'indeterminate', links, summary: pending.length ? `Waiting: message ${t.msg || 1} waits for ${pending.map((w) => waitWords(w.cond)).join(', ')} — not a failure` : `Message ${t.msg || 1} is on its way: no outcome yet` };
  }
  const o = t.outcome;
  if (t.ok) {
    const rec: string[] = [];
    if (t.retx) rec.push(`${t.retx} TCP retransmission${t.retx === 1 ? '' : 's'}`);
    if (lostDns.length && dns.some((x) => x.outcome === 'answered')) {
      const ans = dns.find((x) => x.outcome === 'answered') as NonNullable<Test['dns']>[number];
      rec.push(`DNS: ${lostDns.map((x) => `the query to ${x.server} ${x.outcome === 'lost' ? 'was lost' : 'was refused'}`).join(', ')}; ${ans.server} answered`);
    }
    links.push({ rel: 'related', source: 'runtime', text: `answered (${sec(t.ended || t.started)})${t.resolved ? '; ' + t.resolved : ''}${rec.length ? ' after ' + rec.join('; ') : ''}`, refs: [testRef], t: t.ended });
    return { state: rec.length ? 'recovered' : 'established', links, summary: rec.length ? `Recovered: answered after ${rec.join('; ')}` : 'Answered in the simulation' };
  }
  if (o && o.kind === 'cancelled') return { state: 'cancelled', links, summary: 'Cancelled before it was sent (Stop)' };
  const first = { rel: 'cause' as LinkKind, source: 'runtime' as const, refs: [testRef], t: t.ended };
  if (o && o.kind === 'refused') links.push({ ...first, text: `${o.by || 'the destination'} refused the connection with a RST (${sec(t.ended || 0)}): nothing listens there on port ${t.port}` });
  else if (o && o.kind === 'unreachable') links.push({ ...first, text: `${o.by || 'a device'} answered ${o.icmp || 'an ICMP error'} (${sec(t.ended || 0)})` });
  else if (o && o.kind === 'too-big') links.push({ ...first, text: `${o.by ? o.by + ' answered ' + (o.icmp || 'Fragmentation Needed') : 'its own interface refused it'}: the packet is larger than the path takes${o.mtu ? ' (' + o.mtu + ' bytes)' : ''}` });
  else if (o && o.kind === 'not-sent') links.push({ ...first, text: o.down ? `not sent: ${o.down} was down when it was to be sent (${sec(t.started)})` : `not sent: ${t.result.replace(/^not sent: /, '')}` });
  else if (o && o.kind === 'no-address') links.push({ ...first, rel: 'prerequisite', text: `no address: ${t.result.replace(/^not sent: /, '')}` });
  else if (o && o.kind === 'name') links.push({ ...first, text: `the name did not resolve: ${t.result}${dns.length ? ` (${dns.map((x) => `${x.server}: ${x.outcome}`).join(', ')})` : ''}` });
  else if (o && o.kind === 'lost') links.push({ ...first, text: `the connection was lost: ${t.result}` });
  else if (o && o.kind === 'timeout') links.push({ ...first, rel: 'related', text: `no answer: it timed out (${sec(t.ended || 0)})${t.retx ? ` after ${t.retx} retransmission${t.retx === 1 ? '' : 's'}` : ''}` });
  // the recorded drop of its own packet (the cause of a timeout, when there is one)
  if (o && o.drop) links.push(dropLink(o.drop, t.id));
  else if (o && o.kind === 'timeout') {
    // was the evidence still kept? (the log keeps the latest events only)
    const trimmed = rt.log.dropped > 0 && rt.log.first > t.started;
    links.push({ rel: 'hypothesis', source: 'runtime', text: trimmed ? `the events of ${sec(t.started)} are no longer kept (the event log keeps the latest ones): what happened to its packets is not available` : 'the recorded evidence does not establish why it was not answered: no drop of its packets was recorded (the answer, or its way back, may be what is missing)', refs: [testRef] });
  }
  const kindText = o ? o.kind : 'failed';
  return { state: 'blocked', links, summary: `Not completed in the simulation: ${kindText === 'timeout' ? 'timed out' : kindText.replace('-', ' ')}` };
}

/** The equal-cost branches a run's packets took, as recorded (route events): "r1: 2 of 2 (out c)". */
function branchesOf(rt: RuntimeEvidence): string[] {
  const out: string[] = [];
  for (const t of rt.run.tests) {
    for (const ev of rt.events) {
      if (!ev.route || t.pktIds.indexOf(ev.route.pkt) < 0) continue;
      const s = `message ${t.msg || 1}: at ${ev.device} branch ${ev.route.index + 1} of ${ev.route.of} (out ${ev.route.iface}${ev.route.gateway ? ' via ' + ev.route.gateway : ''})`;
      if (out.indexOf(s) < 0) out.push(s);
    }
  }
  return out;
}

/**
 * Diagnose a communication (see the module comment): the static answer,
 * then — when a recorded send of the same communication is given — what
 * happened to it and why, as far as the records go.
 */
export function diagnose(input: DiagnosisInput): Diagnosis {
  const c = input.check;
  const svc = c.service ? (c.service.proto === 'icmp' ? 'ICMP' : `${c.service.proto.toUpperCase()} ${c.service.port}`) : 'ICMP (no service given)';
  const exact: string[] = [];
  const unresolved: string[] = [];
  if (c.from && c.from.address) exact.push(`Source ${c.from.text}`);
  else unresolved.push('Source address: none resolved');
  if (c.to && c.to.address) exact.push(`Destination ${c.to.text}`);
  else unresolved.push('Destination address: none resolved');
  const fam = c.request.family ? `IPv${c.request.family}` : c.from && c.from.address ? (c.from.address.indexOf(':') >= 0 ? 'IPv6' : 'IPv4') + ' (of the ends)' : 'not decided';
  const d: Diagnosis = {
    question: {
      from: c.from ? c.from.text : c.request.from,
      to: c.to ? c.to.text : c.request.to || '',
      family: fam,
      service: svc + (c.serviceSource ? ` (${c.serviceSource})` : ''),
      vrf: c.request.vrf !== undefined ? c.request.vrf || 'the default table' : c.trace && c.trace.source ? c.trace.source.vrf || 'the default table' : 'the source interface’s',
      context: contextText(input.context),
      exact,
      unresolved,
    },
    verdict: c.verdict,
    state: 'indeterminate',
    summary: '',
    established: [],
    blockers: [],
    chain: [],
    legs: [],
    next: [],
    limits: [],
    outdated: !!input.outdated,
    provisional: false,
    evidenceLimited: false,
  };
  if (c.error) {
    d.summary = c.error;
    d.limits.push('The question can’t be checked as asked: ' + c.error);
    return d;
  }
  // ---- static: what is established, what prevents or limits it
  for (const l of c.layers) {
    if (l.id === 'runtime') continue;
    if (l.verdict === 'satisfied') d.established.push(`${LAYER_LABEL[l.id]}: ${l.text}`);
    else {
      const rel: LinkKind = l.verdict === 'violated' ? 'cause' : l.verdict === 'partial' ? 'related' : 'prerequisite';
      d.blockers.push({ rel, source: 'static', text: `${LAYER_LABEL[l.id]} — ${verdictText(l.verdict, 'check')}: ${l.text}`, refs: layerRefs(l) });
    }
  }
  if (c.outcome && c.outcome.verdict === 'partial') {
    const g = c.outcome.groups.map((x) => `${x.count} of ${c.outcome ? c.outcome.total : 0} path${x.count === 1 ? '' : 's'} ${x.text}`);
    d.blockers.push({ rel: 'related', source: 'static', text: `Equal-cost alternatives differ: ${g.join('; ')} — which one a flow takes is the simulation’s forwarding choice`, refs: [{ ref: 'layer:path', label: 'Network path' }] });
  }
  if (input.mtu && input.mtu.verdict !== 'unsupported') {
    if (input.mtu.verdict === 'indeterminate') d.limits.push(`Path MTU: ${input.mtu.text}`);
    else d.established.push(`Path MTU: ${input.mtu.text}`);
  }
  // the runtime layer is never a conclusion: said as a limit
  const rtl = c.layers.find((l) => l.id === 'runtime');
  if (rtl) d.limits.push(rtl.text);
  // ---- legs answered on their own (MQTT subscribers, a DNS query)
  for (const leg of c.legs) {
    d.legs.push({ label: leg.label, verdict: leg.check.verdict, state: leg.check.verdict === 'satisfied' ? 'established' : leg.check.verdict === 'violated' ? 'blocked' : leg.check.verdict === 'partial' ? 'partial' : 'indeterminate', text: leg.check.headline, refs: [] });
  }
  // ---- static state and summary
  const blockedStatic = d.blockers.some((b) => b.rel === 'cause');
  d.state = c.verdict === 'satisfied' ? 'established' : c.verdict === 'violated' ? 'blocked' : c.verdict === 'partial' ? 'partial' : c.verdict === 'unsupported' ? 'unsupported' : 'indeterminate';
  const causes = d.blockers.filter((b) => b.rel === 'cause');
  d.summary = c.verdict === 'satisfied' ? `${c.headline}. Static analysis establishes the path and policy, not the exchange itself.` : causes.length > 1 ? `${causes.length} independent blockers: ${causes.map((b) => b.text.split(' — ')[0]).join(', ')} (no single cause)` : c.headline;
  // ---- runtime: a recorded send of the same communication
  const rt = input.runtime;
  if (rt) {
    const tests = rt.run.tests;
    d.question.run = `send #${rt.run.id} (${rt.run.series || 'this communication'}), ${tests.length} message${tests.length === 1 ? '' : 's'} so far${rt.run.stopped ? ', stopped' : ''}`;
    const per = tests.map((t) => ({ t, m: messageChain(t, rt) }));
    const states = per.map((x) => x.m.state);
    d.provisional = states.some((s) => s === 'waiting' || s === 'indeterminate') || (!rt.run.stopped && rt.run.sent < rt.run.count);
    const failedOnes = per.filter((x) => x.m.state === 'blocked');
    const okOnes = per.filter((x) => x.m.state === 'established' || x.m.state === 'recovered');
    // the representative messages: the first that failed, and the first that recovered (never the first branch for its own sake)
    const shown = [failedOnes[0], per.find((x) => x.m.state === 'recovered'), per.find((x) => x.m.state === 'waiting'), okOnes[0]].filter((x, k, a): x is (typeof per)[number] => !!x && a.indexOf(x) === k).slice(0, 2);
    for (const x of shown) {
      d.chain.push({ rel: 'related', source: 'runtime', text: `Message ${x.t.msg || 1} (sent ${sec(x.t.started)}${x.t.srcAddr ? ' from ' + x.t.srcAddr : ''} to ${formatAddr(x.t.dst)}): ${x.m.summary}`, refs: [{ ref: 'test:' + x.t.id, label: `message ${x.t.msg || 1}` }], t: x.t.started });
      for (const l of x.m.links) d.chain.push(l);
    }
    if (rt.log.dropped > 0 && tests.some((t) => rt.log.first > t.started)) d.evidenceLimited = true;
    if (d.chain.some((l) => l.rel === 'hypothesis' && /no longer kept/.test(l.text))) d.evidenceLimited = true;
    const br = branchesOf(rt);
    if (br.length) d.chain.push({ rel: 'related', source: 'runtime', text: `Equal-cost branches taken (as recorded): ${br.join('; ')}`, refs: [] });
    // the run's state: never a pending prerequisite called a failure, never a later success over an earlier failure
    let rs: DiagnosisState;
    if (!tests.length) rs = rt.run.stopped ? 'cancelled' : 'indeterminate';
    else if (failedOnes.length && okOnes.length) rs = 'partial';
    else if (failedOnes.length) rs = 'blocked';
    else if (states.every((s) => s === 'cancelled')) rs = 'cancelled';
    else if (states.some((s) => s === 'waiting')) rs = 'waiting';
    else if (states.some((s) => s === 'indeterminate')) rs = 'indeterminate';
    else if (states.some((s) => s === 'recovered')) rs = 'recovered';
    else rs = 'established';
    d.state = rs;
    const n = (k: DiagnosisState): number => states.filter((s) => s === k).length;
    const counts = [n('established') ? `${n('established')} answered` : '', n('recovered') ? `${n('recovered')} answered after recovering` : '', n('blocked') ? `${n('blocked')} not completed` : '', n('waiting') ? `${n('waiting')} waiting` : '', n('cancelled') ? `${n('cancelled')} cancelled` : '', n('indeterminate') ? `${n('indeterminate')} on their way` : ''].filter((x) => !!x);
    const runText = `In the simulation: ${counts.join(', ') || 'nothing sent yet'}`;
    if (rs === 'waiting') d.summary = `Waiting, not failed: ${(per.find((x) => x.m.state === 'waiting') as (typeof per)[number]).m.summary.replace(/^Waiting: /, '')}. ${runText}.`;
    else if (rs === 'blocked' || rs === 'partial') {
      const f = failedOnes[0];
      const cause = f.m.links.find((l) => l.rel === 'cause');
      d.summary = `${runText}. ${cause ? cause.text.charAt(0).toUpperCase() + cause.text.slice(1) : 'The recorded evidence does not establish why the exchange failed.'}`;
      d.blockers.unshift({ rel: cause ? 'cause' : 'hypothesis', source: 'runtime', text: cause ? cause.text : 'The recorded evidence does not establish why the exchange failed.', refs: cause ? cause.refs : [{ ref: 'test:' + f.t.id, label: `message ${f.t.msg || 1}` }], t: f.t.started });
    } else if (rs === 'recovered') d.summary = `${runText}. ${(per.find((x) => x.m.state === 'recovered') as (typeof per)[number]).m.summary}.`;
    else d.summary = `${runText}.${rs === 'established' ? ' The modeled exchange completed; it establishes only what this run observed.' : ''}`;
    // the comparison's explanations of a difference with the static result (recorded state at the snapshot: related, with its time)
    if (rt.comparison) for (const line of rt.comparison.lines) d.chain.push({ rel: 'related', source: 'runtime', text: line, refs: [] });
    if (rt.comparison && rt.comparison.unexplained) d.chain.push({ rel: 'hypothesis', source: 'runtime', text: rt.comparison.unexplained, refs: [] });
  }
  // ---- MQTT: each leg its own (a publication at the broker is no subscriber's receipt)
  const mq = input.mqtt;
  if (mq) {
    if (mq.publisher) {
      const p = mq.publisher;
      d.legs.unshift({ label: `Publisher ${p.dev}/${p.app} → broker (runtime)`, verdict: p.qos >= 1 ? (p.acked > 0 ? 'satisfied' : p.published > 0 ? 'violated' : 'indeterminate') : 'indeterminate', state: p.qos >= 1 ? (p.acked > 0 ? 'established' : p.published > 0 ? 'blocked' : 'indeterminate') : 'indeterminate', text: p.qos >= 1 ? `${p.published} published, ${p.acked} acknowledged by the broker (QoS 1: PUBACK); ${p.state}` : `${p.published} published at QoS 0: the broker’s receipt is not acknowledged, so not established; ${p.state}`, refs: [{ ref: 'device:' + p.dev, label: p.dev }] });
    }
    for (const s of mq.subscribers) d.legs.push({ label: `Broker → subscriber ${s.dev}/${s.app} (runtime)`, verdict: s.received > 0 ? 'satisfied' : 'indeterminate', state: s.received > 0 ? 'established' : 'indeterminate', text: s.received > 0 ? `${s.received} publication${s.received === 1 ? '' : 's'} received; ${s.state}` : `nothing received so far (${s.state}): its receipt is not established — a publication the broker acknowledged is not proof a subscriber got it`, refs: [{ ref: 'device:' + s.dev, label: s.dev }] });
  }
  // ---- next actions (existing ones; preparing never submits)
  if (d.outdated) d.next.push({ id: 'refresh', label: 'Refresh', why: 'The model changed after this result: it belongs to the earlier model' });
  // (the most specific object a blocker names: a policy rule, then an interface, a relation, a cable, a device)
  const rank = ['policy:', 'iface:', 'relation:', 'link:', 'device:'];
  for (const b of d.blockers) {
    const r = b.refs.filter((x) => rank.some((p) => x.ref.indexOf(p) === 0)).sort((x, y) => rank.findIndex((p) => x.ref.indexOf(p) === 0) - rank.findIndex((p) => y.ref.indexOf(p) === 0))[0];
    if (r && !d.next.some((x) => x.ref === r.ref)) d.next.push({ id: 'goto', label: `Inspect ${r.label}`, why: b.text, ref: r.ref });
  }
  if (input.canPrepare && !rt) d.next.push({ id: 'handoff', label: 'Prepare in simulation', why: 'A static result does not establish the exchange: the same send, prefilled, not sent' });
  if (input.canPrepare) d.next.push({ id: 'compare', label: 'Compare with simulation', why: 'The newest recorded send of this communication, compared with this result' });
  if (input.mtu && input.mtu.mtu !== null && input.canPrepare) d.next.push({ id: 'mtu-test', label: 'Test the limit in simulation', why: `The static path MTU is ${input.mtu.mtu} bytes: a send one byte over it, with Don’t fragment, prefilled` });
  d.next.push({ id: 'save-exp', label: 'Save as expectation…', why: 'Keep the question and its expected answer with the model' });
  if (!blockedStatic && c.verdict !== 'satisfied' && !rt) d.limits.push('The recorded evidence does not establish why: a simulation can exchange it (Prepare in simulation)');
  return d;
}

const REL_TEXT: { [k in LinkKind]: string } = { cause: 'cause', prerequisite: 'prerequisite', related: 'related', coincidence: 'coincidence (not linked)', hypothesis: 'not established' };

/** The diagnosis as plain text (Copy, Save as text): the question, the answer, the evidence and its limits. */
export function diagnosisText(d: Diagnosis): string[] {
  const out: string[] = [];
  out.push(`Question: ${d.question.from} → ${d.question.to}, ${d.question.service}, ${d.question.family}, ${d.question.vrf}`);
  out.push(`Context: ${d.question.context}${d.question.run ? ' · runtime: ' + d.question.run : ''}`);
  for (const x of d.question.exact) out.push(`  exact: ${x}`);
  for (const x of d.question.unresolved) out.push(`  open: ${x}`);
  out.push(`Diagnosis: ${d.state}${d.outdated ? ' (outdated: the model changed after it)' : ''}${d.provisional ? ' (provisional: the send is not finished)' : ''}${d.evidenceLimited ? ' (evidence-limited: some records are no longer kept)' : ''}`);
  out.push(`  ${d.summary}`);
  if (d.established.length) {
    out.push('Established:');
    for (const x of d.established) out.push('  ' + x);
  }
  if (d.blockers.length) {
    out.push('Prevents or limits it:');
    for (const b of d.blockers) out.push(`  [${REL_TEXT[b.rel]}, ${b.source}] ${b.text}${b.refs.length ? ' {' + b.refs.map((r) => r.ref).join(', ') + '}' : ''}`);
  }
  if (d.chain.length) {
    out.push('Evidence chain:');
    for (const l of d.chain) out.push(`  [${REL_TEXT[l.rel]}, ${l.source}] ${l.text}${l.refs.length ? ' {' + l.refs.map((r) => r.ref).join(', ') + '}' : ''}`);
  }
  if (d.legs.length) {
    out.push('Legs:');
    for (const g of d.legs) out.push(`  ${g.label}: ${g.state} — ${g.text}`);
  }
  if (d.limits.length) {
    out.push('Limits:');
    for (const x of d.limits) out.push('  ' + x);
  }
  return out;
}
