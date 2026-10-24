/**
 * Diagnosis: the answer to one communication question, built from the
 * evidence the analysis and the simulation recorded — never from a log
 * line's words, never from the current state passed off as the past.
 *
 *   static     the communication check (communication.ts) of the configured
 *              model or a snapshot: what the architecture establishes, and
 *              what prevents or limits it, layer by layer, with the refs of
 *              the hops, rules and interfaces that decided;
 *   runtime    a recorded run of the same communication — a send
 *              (comm-identity.ts runMatches) or the client application's own
 *              run (its messages and their retries) — or an MQTT client's
 *              run (its own publications, mqtt.ts MqttPublication): each
 *              message's structured outcome, the drops recorded in its
 *              exchange (their causes: the kind, the packet, the rule), what
 *              it waited for, its retransmissions, its DNS queries, the
 *              equal-cost branch it took, and the recorded state changes its
 *              prerequisites went through.
 *
 * Three questions are answered apart, never one for another: has the
 * operation finished (`runtime.completed`); what was observed (`outcome`:
 * succeeded, failed, cancelled, mixed, none yet); is what decided it
 * established by the records (`cause`: established, partly, unknown). A
 * timeout is an observed outcome, not proof of a block; a finished timeout
 * whose cause the records don't establish is "failed", not "on its way",
 * and it does not keep the run provisional.
 *
 * Each link of the evidence chain says how it relates to the question:
 *
 *   cause         recorded as what decided it: the RST or ICMP error that
 *                 ended it (with the reason its sender recorded), the drop of
 *                 every attempt it made, a layer that is violated;
 *   contributing  recorded in its exchange — a lost attempt, a dropped answer
 *                 — but not established as what decided the outcome;
 *   prerequisite  something it needs (an address, a neighbour, a route, a
 *                 tunnel or session) and the recorded state change that
 *                 established it, met or not;
 *   related       a recorded observation that does not by itself decide it;
 *   coincidence   something near it in time that no record links to it;
 *   hypothesis    what the evidence cannot establish, said as such.
 *
 * Distinct established causes across a run's messages are grouped, each
 * with its count and its messages; no single cause is claimed where
 * several exist. Unknown is never success, a later working state never
 * explains an earlier send (only an observed difference is said), the last
 * recorded drop is not by itself the cause, a RST says what its sender
 * recorded and no more, a publication at the broker is no subscriber's
 * receipt, and a pending acknowledgment is no loss. Runtime references
 * name their execution (Simulation.exec), so a later simulation's reused
 * ids never answer them. Pure and deterministic.
 */
import { CommCheck, CommLayer, LAYER_LABEL } from './communication';
import { RunComparison } from './comm-identity';
import { PathMtu } from './mtu';
import { AnalysisContext, Verdict, contextText, verdictText } from './result';
import type { OutcomeDrop, Test } from './sim/transport';
import type { DropCause, SimEvent, WaitRecord } from './sim/types';
import type { MqttPublication } from './sim/mqtt';
import { formatAddr } from './ipmath';

export type LinkKind = 'cause' | 'contributing' | 'prerequisite' | 'related' | 'coincidence' | 'hypothesis';

/** A piece of recorded evidence to navigate to: a diagram object, a policy rule, a layer, or a runtime record of one execution. */
export interface EvidenceRef {
  /**
   * "device:r1", "iface:r1:wan", "relation:gre1", "link:c3", "policy:fw:3" (its rule 3; "policy:fw:default" the default
   * action, "policy:fw:implicit" a firewall's relations and allow list), "layer:policy", and runtime records with their
   * execution: "event:<exec>:<seq>", "test:<exec>:<id>", "packet:<exec>:<id>"
   */
  ref: string;
  label: string;
}

export interface ChainLink {
  rel: LinkKind;
  /** where it was recorded: the static check (configured or snapshot), a runtime record */
  source: 'static' | 'runtime';
  text: string;
  refs: EvidenceRef[];
  /** recorded at (simulated ms) */
  t?: number;
  /** a group: how many messages it stands for, and those messages (the first ones, by reference) */
  count?: number;
  messages?: EvidenceRef[];
}

/** What the diagnosis says of the question as a whole. */
export type DiagnosisState =
  | 'established' // the evidence establishes it (statically; at run time when a run was compared: every message answered)
  | 'blocked' // it did not complete, and the records establish what decided it (a violated layer statically)
  | 'failed' // it finished unsuccessfully, and the records do not establish why
  | 'waiting' // a prerequisite is pending (boot, address, neighbour, route, tunnel): not a failure (yet)
  | 'in-progress' // not finished, nothing pending a prerequisite: on its way
  | 'recovered' // it completed after a loss (a retransmission, a retry, a DNS fallback)
  | 'partial' // outcomes differ: some answered, some failed or cancelled (or alternatives differ statically)
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
  source: 'static' | 'runtime';
}

/** The runtime answer, apart from the static one: finished or not, what was observed, whether its cause is established. */
export interface RuntimePart {
  kind: 'send' | 'app' | 'mqtt';
  /** exactly what was examined: "send #3 (…)", "application run #4 of pc/poll (…)", "MQTT run #2 of s1/pub (…)" */
  subject: string;
  exec: number;
  completed: boolean;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'mixed' | 'none';
  cause: 'established' | 'partly' | 'unknown' | 'n/a';
  counts: { succeeded: number; recovered: number; failed: number; cancelled: number; waiting: number; inFlight: number; toSend: number | null };
  /** the distinct established causes and the failures whose cause is not established, grouped (each with its messages) */
  groups: ChainLink[];
  /** one line: "3 answered, 1 not completed (cause not established), 1 on its way" */
  text: string;
}

export interface Diagnosis {
  question: {
    from: string;
    to: string;
    family: string;
    service: string;
    vrf: string;
    context: string;
    /** the runtime record examined, when one is: "send #3 (pc → srv), 2 messages" */
    run?: string;
    /** exact choices and what is still open ("Source address: the route's egress when sent") */
    exact: string[];
    unresolved: string[];
  };
  /** the static verdict (result.ts), the question's answer as the configured model / snapshot gives it */
  verdict: Verdict;
  /** the static answer on its own: its state and its line */
  static: { state: DiagnosisState; text: string };
  /** the runtime answer on its own (a run compared) */
  runtime?: RuntimePart;
  /** the state shown: the runtime one when a run was compared, else the static one */
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
  /** the run is not finished: the runtime part is provisional (an unknown cause of a finished run is not) */
  provisional: boolean;
  /** evidence it would need is no longer retained (the log was trimmed, a record aged out) */
  evidenceLimited: boolean;
}

/** The record of a run examined (Simulation.runEvidence, appEvidence): which run, its messages, its events, what they waited for. */
export interface RuntimeEvidence {
  /** the execution its records belong to (Simulation.exec): every runtime reference names it */
  exec: number;
  subject: {
    kind: 'send' | 'app';
    id: number;
    label: string;
    t0: number;
    stopped: boolean;
    stoppedAt?: number;
    /** messages it is to send (null: until stopped), and sent so far (not counting retries) */
    count: number | null;
    sent: number;
    /** attempts that could not be sent at all (retry: which attempt of message n; none: its first) */
    skipped: Array<{ n: number; t: number; why: string; retry?: number }>;
  };
  /** its messages, retries included (each keeps its message number and retry) */
  tests: Test[];
  /** the events of its messages (by test id or packet id), in log order */
  events: SimEvent[];
  /** the whole log as it is now: the state changes and a session's own packets its prerequisites went through (read, never kept) */
  log: readonly SimEvent[];
  waits: (test: number) => WaitRecord[];
  /** the log's retention: the oldest event still kept (its time and sequence number), and how many were dropped */
  retained: { first: number; firstSeq: number; dropped: number };
  now: number;
  comparison?: RunComparison;
}

/** An MQTT client's run as recorded (Simulation.mqttEvidence): the run, its own publications, the subscribers' runs. */
export interface MqttEvidence {
  exec: number;
  run: { id: number; dev: string; app: string; clientId: string; broker: string; qos: 0 | 1; t0: number; stopped: boolean; stoppedAt?: number; state: string; connects: number; missed: number; published: number; lastClose?: string; how: string; earlier: number };
  pubs: MqttPublication[];
  /** its publications no longer kept (the records keep the latest) */
  evicted: number;
  subscribers: Array<{ dev: string; app: string; clientId: string; runs: Array<{ id: number; state: string; t0: number; stoppedAt?: number; granted: Array<[string, number]> }> }>;
  now: number;
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
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;

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

/** The ref of a policy decision: its written rule, the default action, or a firewall's implicit policy. */
function policyRef(p: NonNullable<DropCause['policy']>): EvidenceRef {
  if (p.rule) return { ref: `policy:${p.device}:${p.rule}`, label: `${p.device} rule ${p.rule}` };
  if (p.byDefault && p.ruleText !== 'implicit policy: relations and allow list') return { ref: `policy:${p.device}:default`, label: `${p.device} default action` };
  return { ref: `policy:${p.device}:implicit`, label: `${p.device} ${p.ruleText || 'policy'}` };
}

/** A policy decision in words: "rule 3 (deny tcp/22)", "the default action". */
function policyBy(p: NonNullable<DropCause['policy']>): string {
  return p.rule ? `rule ${p.rule}${p.ruleText ? ' (' + p.ruleText + ')' : ''}` : p.byDefault && p.ruleText !== 'implicit policy: relations and allow list' ? 'the default action' : p.ruleText || 'its policy';
}

/** The grouping key of a recorded drop: its structured cause only (never its words). */
function dropKey(d: { device: string; cause?: DropCause }): string {
  const c = d.cause;
  if (!c) return `drop:?:${d.device}`;
  const at = c.policy ? `${c.policy.device}:${c.policy.rule || (c.policy.byDefault ? 'default' : 'implicit')}` : c.iface || c.link || c.relation || '';
  return `drop:${c.kind}:${d.device}:${at}${c.neighbor ? ':' + c.neighbor : ''}${c.mtu ? ':' + c.mtu : ''}`;
}

/** What a recorded drop establishes, in words (from its structured cause; its log text only where no structure was recorded). */
function dropDesc(d: { device: string; cause?: DropCause; text: string; t: number }): string {
  const c = d.cause;
  const at = sec(d.t);
  if (!c) return `dropped at ${d.device || 'the network'} (${at}): ${d.text.replace(/^dropped at [^:]+: /, '')}`;
  const flow = c.flow ? ' ' + c.flow : '';
  switch (c.kind) {
    case 'policy':
      return c.policy ? `${c.policy.device} ${c.policy.action === 'reject' ? 'rejected' : c.policy.action === 'undecided' ? 'could not decide on' : 'denied'} it${flow} (${at}): ${policyBy(c.policy)}${c.policy.text && c.policy.text !== policyBy(c.policy) ? ' — ' + c.policy.text : ''}` : `denied by a policy at ${d.device} (${at})`;
    case 'no-route':
    case 'blackhole':
      return `${d.device} had ${c.kind === 'blackhole' ? 'a blackhole route' : 'no route'} for it when it arrived (${at})${c.vrf ? ' in VRF ' + c.vrf : ''}`;
    case 'neighbor':
      return `${d.device} had a route for it but could not resolve its next hop${c.neighbor ? ' ' + c.neighbor : ''}${c.iface ? ' on ' + c.iface : ''} (${at})`;
    case 'too-big':
      return `it was larger than ${d.device}${c.iface ? ':' + c.iface : ''} takes, ${c.mtu} bytes (${at})`;
    case 'tunnel-down':
      return `tunnel ${c.iface || ''} at ${d.device} was down (${at})`;
    case 'relation-failed':
      return `${c.relation || 'a relation it rides'} had failed (${at})`;
    case 'iface-down':
      return `${d.device}:${c.iface} was down (${at})`;
    case 'cable':
      return `cable ${c.link} was down (${at})`;
    case 'loss':
      return `it was lost on cable ${c.link} (${at})`;
    case 'closed-port':
      return `it reached ${d.device}, where the port is closed (${at})`;
    case 'no-answer':
      return `it reached ${d.device}, which does not answer it (${at})`;
    case 'gateway':
      return `the Security gateway ${d.device} denied it (${at})`;
    case 'ttl':
      return `its TTL expired at ${d.device} (${at})`;
    case 'not-associated':
      return `${d.device} no longer had its Wi-Fi client associated (silent past its idle timeout) (${at})`;
    case 'not-forwarded':
      return `${d.device} does not forward it, by its configuration (${at}): ${d.text.replace(/^dropped at [^:]+: /, '')}`;
    case 'unsupported':
      return `the simulation does not carry it past ${d.device}: not modelled there (${at})`;
    default:
      return `dropped at ${d.device || 'the network'} (${at}): ${d.text.replace(/^dropped at [^:]+: /, '')}`;
  }
}

/** The refs a recorded drop names: the event, the device, the packet (and its own packet inside an outer one), the object, the rule. */
function dropRefs(d: OutcomeDrop, exec: number, own: number[]): EvidenceRef[] {
  const c = d.cause;
  const refs: EvidenceRef[] = [{ ref: `event:${exec}:${d.seq}`, label: 'event at ' + sec(d.t) }];
  if (d.device) refs.push({ ref: 'device:' + d.device, label: d.device });
  if (c) {
    if (c.pkt !== undefined) refs.push({ ref: `packet:${exec}:${c.pkt}`, label: c.carried && c.carried.length ? 'outer packet' : 'packet' });
    const inner = c.carried ? c.carried.find((p) => own.indexOf(p) >= 0) : undefined;
    if (inner !== undefined) refs.push({ ref: `packet:${exec}:${inner}`, label: 'its packet inside' });
    if (c.iface) refs.push({ ref: `iface:${d.device}:${c.iface}`, label: `${d.device}:${c.iface}` });
    if (c.link) refs.push({ ref: 'link:' + c.link, label: c.link });
    if (c.relation) refs.push({ ref: 'relation:' + c.relation, label: c.relation });
    if (c.policy) refs.push(policyRef(c.policy));
  }
  return refs;
}

/** One attempt (a Test) explained: its state, and — when it failed — what decided it, as far as the records go. */
interface AttemptView {
  state: 'succeeded' | 'recovered' | 'failed' | 'cancelled' | 'waiting' | 'in-flight';
  /** a failure's group: its established cause, or "unknown:<kind>" */
  key: string;
  /** the terminal explanation's kind: established (cause, prerequisite) or not (hypothesis) */
  rel: LinkKind;
  head: string;
  refs: EvidenceRef[];
  links: ChainLink[];
  /** the recorded drop that decided it, for its prerequisites (no route, a tunnel down …) */
  decisive: OutcomeDrop[];
  evicted: boolean;
}

const KIND_WORD: { [k: string]: string } = { refused: 'refused', unreachable: 'unreachable', 'too-big': 'too big', timeout: 'timed out', lost: 'connection lost', 'not-sent': 'not sent', 'no-address': 'no address', name: 'name not resolved', cancelled: 'cancelled' };

function explainAttempt(t: Test, rt: RuntimeEvidence): AttemptView {
  const exec = rt.exec;
  const testRef: EvidenceRef = { ref: `test:${exec}:${t.id}`, label: `message ${t.msg || 1}${t.retry ? ` (retry ${t.retry})` : ''}` };
  const links: ChainLink[] = [];
  const waits = (t.waits || []).concat(rt.waits(t.id));
  for (const w of waits) {
    const open = w.until === undefined;
    const unmet = !open && !w.met && !t.ok;
    links.push({ rel: 'prerequisite', source: 'runtime', text: open ? `it waits for ${waitWords(w.cond)}: ${w.why} (since ${sec(w.since)})` : unmet ? `it still waited for ${waitWords(w.cond)} when it ended (${w.why}, from ${sec(w.since)})` : `it waited ${dur((w.until as number) - w.since)} for ${waitWords(w.cond)}: ${w.why}`, refs: [testRef], t: w.since });
  }
  const base = { key: '', rel: 'related' as LinkKind, head: '', refs: [testRef], links, decisive: [] as OutcomeDrop[], evicted: false };
  const dns = t.dns || [];
  const lostDns = dns.filter((x) => x.outcome === 'lost' || x.outcome === 'refused');
  if (!t.done) {
    const pending = waits.filter((w) => w.until === undefined);
    return { ...base, state: pending.length ? 'waiting' : 'in-flight', head: pending.length ? `message ${t.msg || 1} waits for ${pending.map((w) => waitWords(w.cond)).join(', ')} — not a failure` : `message ${t.msg || 1} is on its way: no outcome yet` };
  }
  if (t.ok) {
    const rec: string[] = [];
    if (t.retx) rec.push(plural(t.retx, 'TCP retransmission'));
    if (lostDns.length && dns.some((x) => x.outcome === 'answered')) {
      const ans = dns.find((x) => x.outcome === 'answered') as NonNullable<Test['dns']>[number];
      rec.push(`DNS: ${lostDns.map((x) => `the query to ${x.server} ${x.outcome === 'lost' ? 'was lost' : 'was refused'}`).join(', ')}; ${ans.server} answered`);
    }
    links.push({ rel: 'related', source: 'runtime', text: `answered (${sec(t.ended || t.started)})${t.resolved ? '; ' + t.resolved : ''}${rec.length ? ' after ' + rec.join('; ') : ''}`, refs: [testRef], t: t.ended });
    return { ...base, state: rec.length ? 'recovered' : 'succeeded', head: rec.length ? `answered after ${rec.join('; ')}` : 'answered' };
  }
  const o = t.outcome;
  if (o && o.kind === 'cancelled') return { ...base, state: 'cancelled', head: 'cancelled before it was sent (Stop)' };
  const end = t.ended || t.started;
  const own = t.pktIds;
  const out = (key: string, rel: LinkKind, head: string, refs: EvidenceRef[], decisive: OutcomeDrop[] = []): AttemptView => {
    links.push({ rel, source: 'runtime', text: head, refs, t: end });
    return { ...base, state: 'failed', key, rel, head, refs, decisive };
  };
  // (what the answer that ended it reports, as its sender recorded it: a policy's rejection, a closed port)
  const decision = (o && o.event !== undefined ? [{ ref: `event:${exec}:${o.event}`, label: 'its decision' }] : []) as EvidenceRef[];
  const byRefs = (by?: string): EvidenceRef[] => [testRef].concat(by ? [{ ref: 'device:' + by, label: by }] : []);
  const drops = o ? o.drops || (o.drop ? [o.drop] : []) : [];
  // (the drop the answer reports: its sender's own decision line — a policy's rejection, a missing route's ICMP error)
  const dec = drops.filter((x) => o && o.event !== undefined && x.seq === o.event);
  if (o && (o.kind === 'refused' || (o.kind === 'lost' && o.byAddr !== undefined))) {
    const verb = o.kind === 'refused' ? 'refused the connection' : 'reset the connection';
    const via = o.byAddr ? ` (from ${o.byAddr})` : '';
    if (o.reason === 'policy' && o.cause && o.cause.policy) {
      const p = o.cause.policy;
      return out(`rst:policy:${p.device}:${p.rule || (p.byDefault ? 'default' : 'implicit')}`, 'cause', `${p.device} ${verb}: its policy rejected it (${policyBy(p)}) and answered with a RST${via} (${sec(end)})`, byRefs(o.by).concat([policyRef(p)], decision));
    }
    if (o.reason === 'closed') return out(`rst:closed:${o.by}:${t.port}`, 'cause', `${o.by || 'the destination'} ${verb} with a RST${via}: TCP port ${t.port} is closed there — it recorded no listener on it (${sec(end)})`, byRefs(o.by).concat(decision));
    if (o.reason === 'no-connection') return out(`rst:noconn:${o.by}`, 'cause', `${o.by || 'a device'} answered with a RST${via}: it had no connection for the segment (${sec(end)})`, byRefs(o.by).concat(decision));
    return out(`rst:${o.by}`, 'cause', `${o.by || 'a device'} ${verb} with a RST${via} (${sec(end)}); why it sent the RST is not recorded`, byRefs(o.by));
  }
  if (o && o.kind === 'unreachable') {
    if (o.reason === 'policy' && o.cause && o.cause.policy) {
      const p = o.cause.policy;
      return out(`icmp:policy:${p.device}:${p.rule || (p.byDefault ? 'default' : 'implicit')}`, 'cause', `${p.device} rejected it by its policy (${policyBy(p)}) and answered ${o.icmp || 'an ICMP error'} (${sec(end)})`, byRefs(o.by).concat([policyRef(p)], decision), dec);
    }
    if (o.reason === 'closed') return out(`icmp:closed:${o.by}:${t.port}`, 'cause', `${o.by || 'the destination'} answered ${o.icmp || 'Port Unreachable'}: ${t.kind.toUpperCase()} port ${t.port} is closed there (${sec(end)})`, byRefs(o.by).concat(decision));
    // (what the router recorded when it sent it: no route, a neighbour that did not answer — its drop line)
    const why = dec.length ? ` — ${dropDesc(dec[0])}` : '';
    return out(`icmp:${o.by}:${o.icmp}`, 'cause', `${o.by || 'a device'} answered ${o.icmp || 'an ICMP error'}${o.byAddr ? ` (from ${o.byAddr})` : ''} (${sec(end)})${why}`, byRefs(o.by).concat(dec.length ? dropRefs(dec[0], exec, own) : []), dec);
  }
  if (o && o.kind === 'too-big') return out(`toobig:${o.by || 'self'}:${o.mtu || ''}`, 'cause', `${o.by ? o.by + ' answered ' + (o.icmp || 'Fragmentation Needed') : 'its own interface refused it'}: the packet is larger than the path takes${o.mtu ? ' (' + o.mtu + ' bytes)' : ''} (${sec(end)})`, byRefs(o.by).concat(dec.length ? dropRefs(dec[0], exec, own) : []), dec);
  if (o && o.kind === 'not-sent') return out(`notsent:${o.down || ''}`, 'cause', o.down ? `not sent: ${o.down} was down when it was to be sent (${sec(t.started)})` : `not sent: ${t.result.replace(/^not sent: /, '')}`, o.down ? [testRef, { ref: 'iface:' + o.down, label: o.down }] : [testRef]);
  if (o && o.kind === 'no-address') return out(`noaddr:${o.down || ''}`, 'prerequisite', `no address: ${o.down ? o.down + ' got no DHCP lease' : 'no lease'} before it was to be sent (${t.result.replace(/^not sent: [^(]*\(?/, '').replace(/\)$/, '')})`, [testRef].concat(o.down ? [{ ref: 'iface:' + o.down, label: o.down }] : [], decision));
  if (o && o.kind === 'name') return out(`name:${t.target}`, 'cause', `the name ${t.target} did not resolve${dns.length ? ` (${dns.map((x) => `${x.server}: ${x.outcome}`).join(', ')})` : ''}`, [testRef]);
  // a timeout, or a connection lost without a RST: what its recorded drops establish
  const attempts = o && o.attempts !== undefined ? o.attempts : own.length;
  const covered = new Set<number>();
  for (const d of drops) {
    if (!d.attempt || !d.cause) continue;
    if (d.cause.pkt !== undefined && own.indexOf(d.cause.pkt) >= 0) covered.add(d.cause.pkt);
    else for (const p of d.cause.carried || []) if (own.indexOf(p) >= 0) covered.add(p);
  }
  const unmet = waits.filter((w) => w.until !== undefined && !w.met);
  const what = o && o.kind === 'lost' ? 'the connection was lost' : `it timed out${t.retx ? ` after ${plural(t.retx, 'retransmission')}` : ''}`;
  // (where the simulation itself stops — not modelled — nothing is established about the network: said as that)
  if (attempts > 0 && covered.size >= attempts && drops.filter((d) => d.attempt).every((d) => d.cause && d.cause.kind === 'unsupported')) {
    const u = drops.filter((d) => d.attempt)[0];
    const head = `${what}: ${dropDesc(u)} — the outcome establishes nothing about the network`;
    links.push({ rel: 'hypothesis', source: 'runtime', text: head, refs: dropRefs(u, exec, own), t: u.t });
    return { ...base, state: 'failed', key: 'unsupported:' + u.device, rel: 'hypothesis', head, refs: [testRef].concat(dropRefs(u, exec, own)), decisive: [], evicted: false };
  }
  if (attempts > 0 && covered.size >= attempts) {
    const att = drops.filter((d) => d.attempt);
    const keys = Array.from(new Set(att.map(dropKey))).sort();
    const descs = Array.from(new Set(att.map((d) => dropDesc(d))));
    for (const d of drops.filter((x) => !x.attempt)) links.push({ rel: 'contributing', source: 'runtime', text: `also recorded in its exchange: ${dropDesc(d)}`, refs: dropRefs(d, exec, own), t: d.t });
    const head = attempts === 1 ? `${what}: its packet was dropped — ${descs[0]}` : keys.length === 1 ? `${what}: each of its ${attempts} attempts was dropped — ${descs[0]}` : `${what}: each of its ${attempts} attempts was dropped — ${descs.join('; ')}`;
    const refs = [testRef].concat(...att.slice(-3).map((d) => dropRefs(d, exec, own)));
    return out('drops:' + keys.join('|'), 'cause', head, refs, att);
  }
  if (attempts === 0 && unmet.length) return out(`wait:${unmet.map((w) => w.cond).join(',')}`, 'prerequisite', `${what} before it was sent: it still waited for ${unmet.map((w) => waitWords(w.cond)).join(', ')} (${unmet.map((w) => w.why).join('; ')})`, [testRef]);
  for (const d of drops) links.push({ rel: 'contributing', source: 'runtime', text: `recorded in its exchange, not established as what decided it: ${dropDesc(d)}${d.attempt ? '' : ' (not one of its own attempts)'}`, refs: dropRefs(d, exec, own), t: d.t });
  // (were its records still kept when it ended? its outcome says how far back the log reached then)
  const evicted = o && o.logFrom !== undefined ? o.logFrom > t.started : rt.retained.dropped > 0 && rt.retained.first > t.started;
  const head = evicted
    ? `${what}; the events of ${sec(t.started)} are no longer kept (the event log keeps the latest ones): what happened to its packets is not available`
    : drops.length
      ? `${what}; ${covered.size} of its ${plural(attempts, 'attempt')} ${covered.size === 1 ? 'has' : 'have'} a recorded drop — the records do not establish what decided the outcome`
      : `${what}; no drop of its packets was recorded — the records do not establish why (the answer, or its way back, may be what is missing)`;
  links.push({ rel: 'hypothesis', source: 'runtime', text: head, refs: [testRef], t: end });
  return { ...base, state: 'failed', key: `unknown:${o ? o.kind : 'failed'}`, rel: 'hypothesis', head, refs: [testRef], decisive: [], evicted };
}

/** One logical message: its attempts (a send's one, an application's retries) or the attempt that could not be sent. */
interface MessageView {
  n: number;
  /** its last attempt's test, when one was sent */
  t?: Test;
  view: AttemptView;
  /** its first attempt's time */
  started: number;
}

function messagesOf(rt: RuntimeEvidence): MessageView[] {
  const by = new Map<number, { tests: Test[]; skips: Array<{ t: number; why: string; retry: number }> }>();
  const get = (n: number) => {
    let x = by.get(n);
    if (!x) by.set(n, (x = { tests: [], skips: [] }));
    return x;
  };
  for (const t of rt.tests) get(t.msg || 1).tests.push(t);
  for (const s of rt.subject.skipped) get(s.n).skips.push({ t: s.t, why: s.why, retry: s.retry || 0 });
  const out: MessageView[] = [];
  for (const n of Array.from(by.keys()).sort((a, b) => a - b)) {
    const x = by.get(n) as { tests: Test[]; skips: Array<{ t: number; why: string; retry: number }> };
    const tests = x.tests.slice().sort((a, b) => (a.retry || 0) - (b.retry || 0) || a.id - b.id);
    const lastT = tests[tests.length - 1];
    const lastS = x.skips.slice().sort((a, b) => a.retry - b.retry)[x.skips.length - 1];
    const started = Math.min(...tests.map((t) => t.started).concat(x.skips.map((s) => s.t)));
    // (its last attempt decides: a try sent, or one that could not be sent)
    if (lastS && (!lastT || lastS.retry >= (lastT.retry || 0))) {
      const head = `not sent${lastS.retry ? ` (retry ${lastS.retry})` : ''}: ${lastS.why.replace(/^not sent: /, '')} (${sec(lastS.t)})`;
      const view: AttemptView = { state: 'failed', key: 'notsent:skip', rel: 'cause', head, refs: [], links: [{ rel: 'cause', source: 'runtime', text: head, refs: [], t: lastS.t }], decisive: [], evicted: false };
      for (const t of tests) view.links.unshift({ rel: 'related', source: 'runtime', text: `attempt ${(t.retry || 0) + 1}: ${explainAttempt(t, rt).head}`, refs: [{ ref: `test:${rt.exec}:${t.id}`, label: `message ${n}${t.retry ? ` (retry ${t.retry})` : ''}` }], t: t.started });
      out.push({ n, view, started });
      continue;
    }
    const view = explainAttempt(lastT, rt);
    // (earlier attempts that failed: an answer after them is a recovery; a failure after them keeps them as related)
    const earlier = tests.slice(0, -1).map((t) => ({ t, v: explainAttempt(t, rt) }));
    if (earlier.length) {
      for (const e of earlier) view.links.unshift({ rel: view.state === 'succeeded' || view.state === 'recovered' ? 'contributing' : 'related', source: 'runtime', text: `attempt ${(e.t.retry || 0) + 1}: ${e.v.head}`, refs: e.v.refs, t: e.t.started });
      if (view.state === 'succeeded' || view.state === 'recovered') {
        view.state = 'recovered';
        view.head = `answered at attempt ${(lastT.retry || 0) + 1} after ${plural(earlier.length, 'retry', 'retries')} (${earlier.map((e) => KIND_WORD[e.t.outcome ? e.t.outcome.kind : ''] || 'failed').join(', ')})`;
      }
    }
    out.push({ n, t: lastT, view, started });
  }
  return out;
}

/** The latest recorded transition of a ref at or before t (null: none kept). */
function transitionBefore(log: readonly SimEvent[], ref: string, t: number, dev?: string): SimEvent | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const ev = log[i];
    if (ev.t > t) continue;
    if (ev.transition && ev.transition.ref === ref && (!dev || !ev.transition.device || ev.transition.device === dev)) return ev;
  }
  return null;
}

/**
 * The prerequisite chain behind a decisive drop: the route, tunnel or session, interface or cable it found missing, and
 * the recorded state change that made it so — for a session that heard nothing, the recorded fate of its own packets in
 * that interval. A missing record stays unknown (said), never a story made from timestamps.
 */
function prereqChain(d: OutcomeDrop, rt: RuntimeEvidence, check: CommCheck): ChainLink[] {
  const c = d.cause;
  if (!c) return [];
  const exec = rt.exec;
  const out: ChainLink[] = [];
  const refs: Array<{ ref: string; dev?: string; why: string; source: 'static' | 'runtime' }> = [];
  if ((c.kind === 'tunnel-down' || c.kind === 'relation-failed') && c.relation) refs.push({ ref: 'relation:' + c.relation, why: c.kind === 'tunnel-down' ? `the tunnel ${c.iface || ''} at ${d.device} is up while its relation ${c.relation} is` : `it rides ${c.relation}`, source: 'runtime' });
  if (c.kind === 'tunnel-down' && c.iface) refs.push({ ref: `iface:${d.device}:${c.iface}`, why: `the tunnel interface ${d.device}:${c.iface}`, source: 'runtime' });
  if (c.kind === 'iface-down' && c.iface) refs.push({ ref: `iface:${d.device}:${c.iface}`, why: `${d.device}:${c.iface}`, source: 'runtime' });
  if (c.kind === 'cable' && c.link) refs.push({ ref: 'link:' + c.link, why: `cable ${c.link}`, source: 'runtime' });
  if (c.kind === 'no-route' || c.kind === 'blackhole') {
    // (the configured model's route at that device: the relations its hop uses — a learned route's sessions, a tunnel)
    const hop = check.trace && check.trace.paths[0] ? check.trace.paths[0].hops.find((h) => h.device === d.device) : undefined;
    const rels = hop ? hop.relations : [];
    if (rels.length) for (const r of rels) refs.push({ ref: 'relation:' + r, dev: d.device, why: `the configured model's path at ${d.device} uses ${r}`, source: 'static' });
    else out.push({ rel: 'hypothesis', source: 'runtime', text: `What withdrew or never installed the route at ${d.device} is not recorded: the configured model's path there names no relation it is learned over`, refs: [{ ref: 'device:' + d.device, label: d.device }], t: d.t });
  }
  for (const r of refs) {
    const label = r.ref.replace(/^[a-z]+:/, '');
    const isRel = r.ref.indexOf('relation:') === 0;
    const at = r.dev || d.device;
    const tr = transitionBefore(rt.log, r.ref, d.t, isRel ? at : undefined);
    const whole = rt.retained.dropped === 0;
    if (!tr) {
      // (no state change kept: from the start, it never came up — said so only when the log reaches back to the start)
      if (isRel && whole) {
        out.push({ rel: 'prerequisite', source: 'runtime', text: `${label} had not come up at ${at} by ${sec(d.t)}: no state change of it is recorded since the simulation started — ${r.why}`, refs: [{ ref: r.ref, label }], t: d.t });
        out.push(...silence(label, at, -1, d.t, rt));
      } else out.push({ rel: 'hypothesis', source: r.source, text: `${cap(label)} (${r.why}): no state change of it is ${whole ? 'recorded' : 'kept'} before ${sec(d.t)}${whole ? '' : ' (the log keeps the latest events only)'} — what made it unavailable is not established`, refs: [{ ref: r.ref, label }], t: d.t });
      continue;
    }
    const x = tr.transition as NonNullable<SimEvent['transition']>;
    if (x.up) {
      out.push({ rel: 'related', source: 'runtime', text: `${label} was last recorded up (${sec(tr.t)}${x.reason ? ': ' + x.reason : ''}) before ${sec(d.t)}; what made it unavailable then is not recorded`, refs: [{ ref: `event:${exec}:${tr.seq}`, label: 'event at ' + sec(tr.t) }, { ref: r.ref, label }], t: tr.t });
      continue;
    }
    out.push({ rel: 'prerequisite', source: 'runtime', text: `${label} went down at ${sec(tr.t)}${x.device ? ' at ' + x.device : ''} (recorded: ${x.reason || 'down'}) — ${r.why}`, refs: [{ ref: `event:${exec}:${tr.seq}`, label: 'event at ' + sec(tr.t) }, { ref: r.ref, label }], t: tr.t });
    // a session that heard nothing: its peer's packets, and its own, in that interval as recorded
    if (isRel && x.lastHeard !== undefined) out.push(...silence(label, x.device || at, x.lastHeard, tr.t, rt));
  }
  return out;
}

/**
 * Why a session at `dev` heard nothing from `from` to `to` (-1: since the start), as recorded: its peer's messages to it
 * and their drops, else its own messages and theirs. Decisive only when every message of that direction has a recorded
 * drop, all of one cause; else contributing; with no drop recorded, said as not established.
 */
function silence(rel: string, dev: string, from: number, to: number, rt: RuntimeEvidence): ChainLink[] {
  const inWin = (e: SimEvent): boolean => e.t > from && e.t <= to;
  const msgs = rt.log.filter((e) => e.kind === 'message' && e.relation === rel && inWin(e));
  const drops = rt.log.filter((e) => e.kind === 'drop' && !!e.cause && e.cause.session === rel && inWin(e));
  const since = from >= 0 ? sec(from) : 'the start';
  if (rt.retained.first > Math.max(0, from) && rt.retained.dropped > 0) return [{ rel: 'hypothesis', source: 'runtime', text: `Why ${rel} heard nothing at ${dev} is not available: the events since ${since} are no longer kept`, refs: [{ ref: 'relation:' + rel, label: rel }], t: to }];
  const side = (mine: boolean): { sent: SimEvent[]; lost: SimEvent[] } => ({ sent: msgs.filter((e) => (e.device === dev) === mine), lost: drops.filter((e) => ((e.cause as DropCause).from === dev) === mine) });
  const peer = side(false);
  const own = side(true);
  const pick = peer.sent.length ? { s: peer, who: `the packets its peer sent to ${dev}` } : { s: own, who: `${dev}’s own packets to its peer (its peer sent nothing back)` };
  const lost = pick.s.lost;
  if (!lost.length) return [{ rel: 'hypothesis', source: 'runtime', text: `${rel} heard nothing at ${dev} from ${since} to ${sec(to)}; no drop of its own packets is recorded in that interval — why is not established`, refs: [{ ref: 'relation:' + rel, label: rel }], t: to }];
  const keys = Array.from(new Set(lost.map((e) => dropKey(e))));
  const all = lost.length >= pick.s.sent.length && keys.length === 1;
  const first = lost[lost.length - 1];
  const desc = dropDesc({ device: first.device, cause: first.cause, text: first.detail, t: first.t });
  return [{ rel: all ? 'cause' : 'contributing', source: 'runtime', text: `${all ? `It heard nothing because ${pick.who} were dropped` : `Some of ${pick.who} were dropped`} from ${since} to ${sec(to)} (${plural(lost.length, 'drop')} of ${plural(pick.s.sent.length, 'message')}): ${desc}${keys.length > 1 ? ` and ${keys.length - 1} other cause${keys.length === 2 ? '' : 's'}` : ''}`, refs: dropRefs({ seq: first.seq, t: first.t, device: first.device, cause: first.cause, text: first.detail }, rt.exec, []), t: first.t }];
}

/** The equal-cost branches a run's packets took, as recorded (route events): "message 2: at r1 branch 2 of 2 (out c)". */
function branchesOf(rt: RuntimeEvidence): string[] {
  const out: string[] = [];
  for (const t of rt.tests) {
    for (const ev of rt.events) {
      if (!ev.route || t.pktIds.indexOf(ev.route.pkt) < 0) continue;
      const s = `message ${t.msg || 1}: at ${ev.device} branch ${ev.route.index + 1} of ${ev.route.of} (out ${ev.route.iface}${ev.route.gateway ? ' via ' + ev.route.gateway : ''})`;
      if (out.indexOf(s) < 0) out.push(s);
    }
  }
  return out;
}

/** The runtime state from what was observed (see the module comment). */
function runtimeState(p: Omit<RuntimePart, 'text' | 'kind' | 'subject' | 'exec' | 'groups'> & { any: boolean; stopped: boolean }): DiagnosisState {
  const k = p.counts;
  if (!p.any) return p.stopped ? 'cancelled' : k.toSend ? 'in-progress' : 'indeterminate';
  if (p.completed) {
    if (p.outcome === 'succeeded') return k.recovered ? 'recovered' : 'established';
    if (p.outcome === 'failed') return p.cause === 'established' ? 'blocked' : 'failed';
    if (p.outcome === 'cancelled') return 'cancelled';
    return 'partial';
  }
  if (k.failed) return 'partial';
  if (k.waiting) return 'waiting';
  return 'in-progress';
}

function countsText(k: RuntimePart['counts'], causeUnknown: number, okWord = 'answered'): string {
  const parts = [k.succeeded ? `${k.succeeded} ${okWord}` : '', k.recovered ? `${k.recovered} ${okWord} after recovering` : '', k.failed ? `${k.failed} not completed${causeUnknown ? (causeUnknown === k.failed ? ' (cause not established)' : ` (${causeUnknown} of them: cause not established)`) : ''}` : '', k.waiting ? `${k.waiting} waiting` : '', k.inFlight ? `${k.inFlight} on ${k.inFlight === 1 ? 'its' : 'their'} way` : '', k.cancelled ? `${k.cancelled} cancelled` : '', k.toSend === null ? 'more until stopped' : k.toSend ? `${k.toSend} still to send` : ''].filter((x) => !!x);
  return parts.join(', ') || 'nothing sent yet';
}

/** The runtime part of a send or an application run, and its chain. */
function runtimeOf(rt: RuntimeEvidence, check: CommCheck): { part: RuntimePart; chain: ChainLink[]; evicted: boolean; heads: { groups: string[]; waiting?: string; recovered?: string } } {
  const msgs = messagesOf(rt);
  const exec = rt.exec;
  const k = { succeeded: 0, recovered: 0, failed: 0, cancelled: 0, waiting: 0, inFlight: 0, toSend: 0 as number | null };
  for (const m of msgs) {
    const s = m.view.state;
    if (s === 'succeeded') k.succeeded++;
    else if (s === 'recovered') k.recovered++;
    else if (s === 'failed') k.failed++;
    else if (s === 'cancelled') k.cancelled++;
    else if (s === 'waiting') k.waiting++;
    else k.inFlight++;
  }
  const sj = rt.subject;
  k.toSend = sj.stopped ? 0 : sj.count === null ? null : Math.max(0, sj.count - sj.sent);
  const completed = !k.waiting && !k.inFlight && k.toSend === 0;
  const ok = k.succeeded + k.recovered;
  const kinds = [ok > 0, k.failed > 0, k.cancelled > 0].filter((x) => x).length;
  const outcome: RuntimePart['outcome'] = kinds === 0 ? 'none' : kinds > 1 ? 'mixed' : ok ? 'succeeded' : k.failed ? 'failed' : 'cancelled';
  // the failures, grouped by what decided each (or by their kind, when that is not established)
  const groups = new Map<string, { view: AttemptView; msgs: MessageView[] }>();
  for (const m of msgs) {
    if (m.view.state !== 'failed') continue;
    const g = groups.get(m.view.key);
    if (g) g.msgs.push(m);
    else groups.set(m.view.key, { view: m.view, msgs: [m] });
  }
  const gl: ChainLink[] = [];
  const gh: string[] = [];
  for (const g of groups.values()) {
    gh.push(cap(g.view.head));
    const msgRefs = g.msgs.filter((m) => !!m.t).slice(0, 12).map((m) => ({ ref: `test:${exec}:${(m.t as Test).id}`, label: `message ${m.n}` }));
    const n = g.msgs.length;
    gl.push({ rel: g.view.rel === 'hypothesis' ? 'hypothesis' : g.view.rel, source: 'runtime', text: `${n > 1 ? `${n} messages — ` : ''}${cap(g.view.head)}`, refs: g.view.refs.filter((r) => r.ref.indexOf('test:') !== 0), t: g.msgs[0].started, count: n, messages: msgRefs });
  }
  const unknownMsgs = msgs.filter((m) => m.view.state === 'failed' && m.view.rel === 'hypothesis').length;
  const cause: RuntimePart['cause'] = !k.failed ? 'n/a' : unknownMsgs === 0 ? 'established' : unknownMsgs === k.failed ? 'unknown' : 'partly';
  const partBase = { completed, outcome, cause, counts: k };
  const text = `${countsText(k, unknownMsgs)}${completed ? '' : ' — not finished'}`;
  const part: RuntimePart = { kind: sj.kind, subject: sj.label, exec, ...partBase, groups: gl, text };
  // the chain: each distinct outcome's first message in full (its waits, drops, the decision, its prerequisites), the rest counted
  const chain: ChainLink[] = [];
  const shown = new Set<string>();
  for (const m of msgs) {
    const sig = m.view.state + '|' + m.view.key;
    if (shown.has(sig)) continue;
    shown.add(sig);
    const same = msgs.filter((x) => x.view.state + '|' + x.view.key === sig).length;
    const t = m.t;
    chain.push({ rel: 'related', source: 'runtime', text: `Message ${m.n}${t ? ` (sent ${sec(t.started)}${t.srcAddr ? `, source ${t.srcAddr}` : ''}, to ${formatAddr(t.dst)})` : ''}: ${m.view.head}${same > 1 ? ` — like ${same - 1} other message${same === 2 ? '' : 's'}` : ''}`, refs: t ? [{ ref: `test:${exec}:${t.id}`, label: `message ${m.n}` }] : [], t: m.started });
    for (const l of m.view.links) chain.push(l);
    for (const d of m.view.decisive.slice(-1)) for (const l of prereqChain(d, rt, check)) chain.push(l);
  }
  const br = branchesOf(rt);
  if (br.length) chain.push({ rel: 'related', source: 'runtime', text: `Equal-cost branches taken (as recorded): ${br.join('; ')}`, refs: [] });
  const evicted = msgs.some((m) => m.view.evicted);
  // (the summary's words come from the message views themselves, never from searching the chain's text)
  const head = (st: AttemptView['state']): string | undefined => {
    const m = msgs.find((x) => x.view.state === st);
    return m ? m.view.head : undefined;
  };
  return { part, chain, evicted, heads: { groups: gh, waiting: head('waiting'), recovered: head('recovered') } };
}

/** An MQTT client's run: the publisher's leg and each subscriber's, from its own publications' records. */
function mqttOf(mq: MqttEvidence, d: Diagnosis): RuntimePart {
  const exec = mq.exec;
  const r = mq.run;
  const pubs = mq.pubs;
  const pktRef = (p: number[], label: string): EvidenceRef[] => (p.length ? [{ ref: `packet:${exec}:${p[0]}`, label }] : []);
  const subject = `MQTT run #${r.id} of ${r.dev}/${r.app} (${r.how === 'event' ? 'started from Network events' : r.how === 'start' ? 'started with the simulation' : 'started by an experiment'} at ${sec(r.t0)}; ${plural(pubs.length + mq.evicted, 'publication')}${r.earlier ? `; ${plural(r.earlier, 'earlier run')} not counted` : ''})`;
  const running = !r.stopped;
  const legs: DiagnosisLeg[] = [];
  // ---- the publisher → the broker
  let pubState: DiagnosisState;
  let pubText: string;
  const acked = pubs.filter((p) => p.acked !== undefined);
  const lost = pubs.filter((p) => p.acked === undefined && p.lost !== undefined);
  const pending = pubs.filter((p) => p.acked === undefined && p.lost === undefined);
  const atBroker = pubs.filter((p) => p.brokerRx !== undefined);
  const dups = pubs.reduce((n, p) => n + p.dups, 0);
  if (!pubs.length) {
    pubState = mq.evicted ? 'indeterminate' : running ? (r.state === 'Connected' ? 'in-progress' : 'waiting') : 'cancelled';
    pubText = mq.evicted ? `its ${plural(mq.evicted, 'publication')} are no longer kept: not available` : running ? `nothing published yet (${r.state === 'Connected' ? 'connected' : 'its connection to the broker: ' + r.state.toLowerCase()})` : 'it stopped before publishing anything';
  } else if (r.qos === 1) {
    const parts = [`${plural(pubs.length, 'publication')}`, acked.length ? `${acked.length} acknowledged by the broker (PUBACK)` : '', pending.length ? `${pending.length} waiting for PUBACK${running ? '' : ' (the run is stopped)'}` : '', lost.length ? `${lost.length} lost before PUBACK: the connection closed (${lost[0].lostWhy || 'recorded'})` : '', dups ? `${plural(dups, 'DUP copy', 'DUP copies')} sent` : ''].filter((x) => !!x);
    const rxNoAck = pending.filter((p) => p.brokerRx !== undefined).length;
    pubText = parts.join(', ') + (rxNoAck ? `; the broker received ${rxNoAck} of those waiting — their PUBACK has not arrived` : '');
    pubState = !pending.length ? (lost.length ? (acked.length ? 'partial' : 'blocked') : 'established') : running ? (lost.length ? 'partial' : 'waiting') : lost.length || acked.length ? 'partial' : 'indeterminate';
  } else {
    const noRx = pubs.length - atBroker.length;
    pubText = `${plural(pubs.length, 'publication')} at QoS 0: ${atBroker.length} received by the broker (recorded at the broker)${noRx ? `, ${noRx} with no receipt at the broker recorded — QoS 0 has no PUBACK, and a missing one is no evidence of loss` : ''}`;
    pubState = !noRx ? 'established' : running && pubs.some((p) => p.brokerRx === undefined && mq.now - p.t < 5000) ? 'in-progress' : atBroker.length ? 'partial' : 'indeterminate';
  }
  const firstPub = pubs[0];
  legs.push({ label: `Publisher ${r.dev}/${r.app} → broker ${r.broker} (runtime, run #${r.id})`, verdict: pubState === 'established' ? 'satisfied' : pubState === 'blocked' ? 'violated' : pubState === 'partial' ? 'partial' : 'indeterminate', state: pubState, text: pubText, refs: [{ ref: 'device:' + r.dev, label: r.dev }].concat(firstPub ? pktRef(firstPub.pkts, 'its first publication') : []), source: 'runtime' });
  // ---- the broker → each subscriber (only this run's publications count: an earlier receipt proves nothing of them)
  for (const s of mq.subscribers) {
    const relevant = pubs.filter((p) => p.brokerRx !== undefined);
    const dls = relevant.map((p) => ({ p, dl: p.deliveries.find((x) => x.clientId === s.clientId) }));
    const got = dls.filter((x) => x.dl && x.dl.rx !== undefined);
    const enRoute = dls.filter((x) => x.dl && x.dl.rx === undefined);
    const notPassed = dls.filter((x) => !x.dl && x.p.matched !== undefined);
    const twice = got.filter((x) => (x.dl as NonNullable<typeof x.dl>).rxCount > 1).length;
    const sr = s.runs[0];
    // (its own run decides whether a receipt can still come: connected, the broker's copies may still arrive)
    const subOn = !!sr && sr.state !== 'Stopped' && sr.stoppedAt === undefined;
    const subNow = sr ? `its run #${sr.id} is ${sr.state.toLowerCase()} (started ${sec(sr.t0)}${sr.granted.length ? `; granted ${sr.granted.map(([f, q]) => `${f} → ${q === 0x80 ? 'refused' : 'QoS ' + q}`).join(', ')}` : ''})` : 'it was not started in this simulation';
    let st: DiagnosisState;
    let text: string;
    let rel: LinkKind | null = null;
    if (!relevant.length) {
      st = 'indeterminate';
      text = pubs.length ? `none of the run's publications reached the broker (see the publisher's leg): nothing to deliver to it` : `the run published nothing yet`;
    } else if (got.length === relevant.length) {
      st = 'established';
      text = `received ${got.length} of the ${plural(relevant.length, 'publication')} of run #${r.id} that reached the broker${twice ? ` (${twice} more than once: a QoS 1 DUP, as MQTT 3.1.1 allows)` : ''}; ${subNow}`;
    } else if (got.length) {
      st = enRoute.length && subOn ? 'in-progress' : 'partial';
      text = `received ${got.length} of ${relevant.length}${enRoute.length ? `; ${enRoute.length} delivered by the broker, their receipt not recorded yet` : ''}${notPassed.length ? `; ${notPassed.length} not passed to it by the broker (no session with a matching subscription then)` : ''}; ${subNow}`;
    } else if (notPassed.length === relevant.length) {
      st = 'blocked';
      rel = 'prerequisite';
      text = `the broker passed none of the ${plural(relevant.length, 'publication')} to it: when they arrived it had no session with a matching subscription (recorded at the broker); ${subNow}`;
    } else if (enRoute.length) {
      st = subOn ? 'waiting' : 'failed';
      text = `the broker sent ${enRoute.length} to it; ${subOn ? 'its receipt is not recorded yet' : 'no receipt is recorded — why is not established'}; ${subNow}`;
    } else {
      st = 'indeterminate';
      text = `no receipt recorded; ${subNow}`;
    }
    const ex = got[0] || enRoute[0];
    legs.push({ label: `Broker ${r.broker} → subscriber ${s.dev}/${s.app} (runtime, publications of run #${r.id})`, verdict: st === 'established' ? 'satisfied' : st === 'blocked' ? 'violated' : st === 'partial' ? 'partial' : 'indeterminate', state: st, text, refs: [{ ref: 'device:' + s.dev, label: s.dev }].concat(ex && ex.dl ? pktRef(ex.dl.pkts, 'its copy') : []), source: 'runtime' });
    if (rel) d.blockers.push({ rel, source: 'runtime', text: `Subscriber ${s.dev}/${s.app}: ${text}`, refs: [{ ref: 'device:' + s.dev, label: s.dev }] });
  }
  if (lost.length) d.blockers.push({ rel: 'cause', source: 'runtime', text: `Publisher ${r.dev}/${r.app}: ${plural(lost.length, 'publication')} lost before PUBACK — its connection to the broker closed (${lost[0].lostWhy || 'recorded'}, ${sec(lost[0].lost as number)})`, refs: [{ ref: 'device:' + r.dev, label: r.dev }].concat(pktRef(lost[0].pkts, 'that publication')), count: lost.length });
  if (r.missed) d.chain.push({ rel: 'related', source: 'runtime', text: `${plural(r.missed, 'round')} not published: not connected at ${r.missed === 1 ? 'its' : 'their'} time`, refs: [] });
  if (mq.evicted) {
    d.evidenceLimited = true;
    d.limits.push(`${plural(mq.evicted, 'publication')} of run #${r.id} ${mq.evicted === 1 ? 'is' : 'are'} no longer kept (the records keep the latest publications): ${mq.evicted === 1 ? 'it is' : 'they are'} not counted either way`);
  }
  d.legs = legs.concat(d.legs.filter((l) => l.source === 'static'));
  // the run's state: from its legs (a pending acknowledgment is waiting, never a failure)
  const states = legs.map((l) => l.state);
  const has = (x: DiagnosisState): boolean => states.indexOf(x) >= 0;
  const allOk = states.every((x) => x === 'established');
  const completed = !running && !has('waiting') && !has('in-progress');
  const counts = { succeeded: legs.filter((l) => l.state === 'established').length, recovered: 0, failed: legs.filter((l) => l.state === 'blocked' || l.state === 'failed').length, cancelled: legs.filter((l) => l.state === 'cancelled').length, waiting: legs.filter((l) => l.state === 'waiting').length, inFlight: legs.filter((l) => l.state === 'in-progress').length, toSend: running ? null : 0 };
  const outcome: RuntimePart['outcome'] = allOk ? 'succeeded' : counts.failed && counts.succeeded ? 'mixed' : counts.failed ? 'failed' : has('partial') ? 'mixed' : 'none';
  const cause: RuntimePart['cause'] = !counts.failed ? 'n/a' : legs.some((l) => l.state === 'failed') ? (legs.some((l) => l.state === 'blocked') ? 'partly' : 'unknown') : 'established';
  return { kind: 'mqtt', subject, exec, completed, outcome, cause, counts, groups: [], text: `${legs.map((l) => `${l.label.split(' (')[0]}: ${DIAG_WORD[l.state]}`).join('; ')}${running ? ' — the run goes on' : ''}` };
}

/** A state in a word, for one-line summaries (the UI has its own labels). */
const DIAG_WORD: { [k in DiagnosisState]: string } = { established: 'established', blocked: 'blocked', failed: 'not completed (cause not established)', waiting: 'waiting', 'in-progress': 'in progress', recovered: 'recovered', partial: 'partial', cancelled: 'cancelled', indeterminate: 'not established', unsupported: 'not supported' };

/**
 * Diagnose a communication (see the module comment): the static answer,
 * then — when a recorded run of the same communication is given — what
 * happened to it and why, as far as the records go.
 */
export function diagnose(input: DiagnosisInput): Diagnosis {
  const c = input.check;
  const svc = c.service ? (c.service.proto === 'icmp' ? 'ICMP' : `${c.service.proto.toUpperCase()} ${c.service.port}`) : 'none given';
  const exact: string[] = [];
  const unresolved: string[] = [];
  if (c.from && c.from.address) exact.push(`Source ${c.from.text}`);
  else unresolved.push('Source address: none resolved');
  if (c.to && c.to.address) exact.push(`Destination ${c.to.text}`);
  else unresolved.push('Destination address: none resolved');
  // (no service in the question: a prepared send proposes an ICMP echo — a test choice, not what was asked)
  if (!c.service && input.canPrepare) unresolved.push('Service: none given — a send prepared from this question proposes an ICMP echo (a test choice, not part of the question)');
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
    static: { state: 'indeterminate', text: '' },
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
    d.static.text = c.error;
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
  // ---- legs answered on their own statically (MQTT subscribers, a DNS query)
  for (const leg of c.legs) {
    d.legs.push({ label: leg.label, verdict: leg.check.verdict, state: leg.check.verdict === 'satisfied' ? 'established' : leg.check.verdict === 'violated' ? 'blocked' : leg.check.verdict === 'partial' ? 'partial' : 'indeterminate', text: leg.check.headline, refs: [], source: 'static' });
  }
  // ---- the static state and its line
  const blockedStatic = d.blockers.some((b) => b.rel === 'cause');
  d.static.state = c.verdict === 'satisfied' ? 'established' : c.verdict === 'violated' ? 'blocked' : c.verdict === 'partial' ? 'partial' : c.verdict === 'unsupported' ? 'unsupported' : 'indeterminate';
  const causes = d.blockers.filter((b) => b.rel === 'cause');
  d.static.text = c.verdict === 'satisfied' ? `${c.headline}. Static analysis establishes the path and policy, not the exchange itself.` : causes.length > 1 ? `${causes.length} independent blockers: ${causes.map((b) => b.text.split(' — ')[0]).join(', ')} (no single cause)` : c.headline;
  d.state = d.static.state;
  d.summary = d.static.text;
  // ---- runtime: a recorded send or application run of the same communication
  const rt = input.runtime;
  if (rt) {
    const r = runtimeOf(rt, c);
    d.runtime = r.part;
    d.question.run = `${rt.subject.label}, ${plural(rt.tests.length, 'message')} sent so far${rt.tests.some((t) => t.retry) ? ' (retries included)' : ''}${rt.subject.stopped ? ', stopped' : ''}`;
    const k = r.part.counts;
    const anything = rt.tests.length > 0 || rt.subject.skipped.length > 0;
    d.state = runtimeState({ completed: r.part.completed, outcome: r.part.outcome, cause: r.part.cause, counts: k, any: anything, stopped: rt.subject.stopped });
    d.provisional = !r.part.completed;
    d.chain = r.chain;
    if (r.evicted) d.evidenceLimited = true;
    // the groups: each distinct established cause (and the failures without one) once, with its messages
    for (const g of r.part.groups.slice().reverse()) d.blockers.unshift(g);
    const runText = `In the simulation (${rt.subject.kind === 'send' ? 'send #' + rt.subject.id : 'application run #' + rt.subject.id}): ${r.part.text}`;
    if (d.state === 'waiting') {
      d.summary = `Waiting, not failed${r.heads.waiting ? ': ' + r.heads.waiting : ''}. ${runText}.`;
    } else if (k.failed) {
      const estHeads = r.part.groups.map((g, i) => ({ g, h: r.heads.groups[i] })).filter((x) => x.g.rel !== 'hypothesis');
      const why = estHeads.length > 1 ? `${estHeads.length} distinct causes, no single one: ${estHeads.map((x) => `${x.h}${x.g.count && x.g.count > 1 ? ` (${x.g.count} messages)` : ''}`).join('; ')}` : estHeads.length === 1 ? estHeads[0].h : '';
      const unknown = r.part.cause === 'unknown' || r.part.cause === 'partly' ? (estHeads.length ? ' The cause of the other failures is not established.' : ' The recorded evidence does not establish why the exchange failed.') : '';
      d.summary = `${runText}.${why ? ' ' + why + (why.charAt(why.length - 1) === '.' ? '' : '.') : ''}${unknown}`;
    } else if (d.state === 'recovered') {
      d.summary = `${runText}.${r.heads.recovered ? ' ' + cap(r.heads.recovered) + '.' : ''}`;
    } else d.summary = `${runText}.${d.state === 'established' ? ' The modeled exchange completed; it establishes only what this run observed.' : ''}`;
    // the comparison's explanations of a difference with the static result (recorded state at the snapshot: related, with its time)
    if (rt.comparison) for (const line of rt.comparison.lines) d.chain.push({ rel: 'related', source: 'runtime', text: line, refs: [] });
    if (rt.comparison && rt.comparison.unexplained) d.chain.push({ rel: 'hypothesis', source: 'runtime', text: rt.comparison.unexplained, refs: [] });
  }
  // ---- MQTT: each leg its own, from the run's own publications (a publication at the broker is no subscriber's receipt)
  const mq = input.mqtt;
  if (mq) {
    const part = mqttOf(mq, d);
    d.runtime = part;
    d.question.run = part.subject;
    const ls = d.legs.filter((l) => l.source === 'runtime').map((l) => l.state);
    const has = (x: DiagnosisState): boolean => ls.indexOf(x) >= 0;
    d.state = ls.every((x) => x === 'established') ? 'established' : has('blocked') && ls.some((x) => x === 'established' || x === 'partial') ? 'partial' : has('blocked') ? 'blocked' : has('waiting') ? 'waiting' : has('in-progress') ? 'in-progress' : has('partial') ? 'partial' : has('failed') ? 'failed' : 'indeterminate';
    d.provisional = !part.completed;
    d.summary = `In the simulation (${part.subject.split(' (')[0]}): ${part.text}.`;
  }
  // ---- next actions (existing ones; preparing never submits)
  if (d.outdated) d.next.push({ id: 'refresh', label: 'Refresh', why: 'The model changed after this result: it belongs to the earlier model' });
  // (the most specific object a blocker names: a policy rule, then an interface, a relation, a cable, a device)
  const rank = ['policy:', 'iface:', 'relation:', 'link:', 'device:'];
  for (const b of d.blockers) {
    const r = b.refs.filter((x) => rank.some((p) => x.ref.indexOf(p) === 0)).sort((x, y) => rank.findIndex((p) => x.ref.indexOf(p) === 0) - rank.findIndex((p) => y.ref.indexOf(p) === 0))[0];
    if (r && !d.next.some((x) => x.ref === r.ref)) d.next.push({ id: 'goto', label: `Inspect ${r.label}`, why: b.text, ref: r.ref });
  }
  if (input.canPrepare && !rt && !mq) d.next.push({ id: 'handoff', label: 'Prepare in simulation', why: 'A static result does not establish the exchange: the same send, prefilled, not sent' });
  if (input.canPrepare) d.next.push({ id: 'compare', label: 'Compare with simulation', why: 'The newest recorded run of this communication, compared with this result' });
  if (input.mtu && input.mtu.mtu !== null && input.canPrepare) d.next.push({ id: 'mtu-test', label: 'Test the limit in simulation', why: `The static path MTU is ${input.mtu.mtu} bytes: a send one byte over it, with Don’t fragment, prefilled` });
  d.next.push({ id: 'save-exp', label: 'Save as expectation…', why: 'Keep the question and its expected answer with the model' });
  if (!blockedStatic && c.verdict !== 'satisfied' && !rt && !mq) d.limits.push('The recorded evidence does not establish why: a simulation can exchange it (Prepare in simulation)');
  return d;
}

const REL_TEXT: { [k in LinkKind]: string } = { cause: 'cause', contributing: 'contributing, not established as decisive', prerequisite: 'prerequisite', related: 'related', coincidence: 'coincidence (not linked)', hypothesis: 'not established' };

/** The diagnosis as plain text (Copy, Save as text): the question, the answer, the evidence and its limits. */
export function diagnosisText(d: Diagnosis): string[] {
  const out: string[] = [];
  const refs = (l: ChainLink): string => {
    const all = l.refs.concat(l.messages || []);
    return all.length ? ' {' + all.map((r) => r.ref).join(', ') + '}' : '';
  };
  out.push(`Question: ${d.question.from} → ${d.question.to}, service ${d.question.service}, ${d.question.family}, ${d.question.vrf}`);
  out.push(`Context: ${d.question.context}${d.question.run ? ' · runtime: ' + d.question.run : ''}`);
  for (const x of d.question.exact) out.push(`  exact: ${x}`);
  for (const x of d.question.unresolved) out.push(`  open: ${x}`);
  out.push(`Diagnosis: ${d.state}${d.outdated ? ' (outdated: the model changed after it)' : ''}${d.provisional ? ' (provisional: the run is not finished)' : ''}${d.evidenceLimited ? ' (evidence-limited: some records are no longer kept)' : ''}`);
  out.push(`  ${d.summary}`);
  out.push(`Static analysis: ${d.static.state} — ${d.static.text}`);
  if (d.runtime) out.push(`Simulation: ${d.runtime.completed ? 'finished' : 'not finished'}; observed ${d.runtime.outcome}; cause ${d.runtime.cause === 'n/a' ? 'not applicable' : d.runtime.cause} — ${d.runtime.text} (execution ${d.runtime.exec})`);
  if (d.established.length) {
    out.push('Established:');
    for (const x of d.established) out.push('  ' + x);
  }
  if (d.blockers.length) {
    out.push('Prevents or limits it:');
    for (const b of d.blockers) out.push(`  [${REL_TEXT[b.rel]}, ${b.source}${b.count && b.count > 1 ? `, ${b.count} messages` : ''}] ${b.text}${refs(b)}`);
  }
  if (d.chain.length) {
    out.push('Evidence chain:');
    for (const l of d.chain) out.push(`  [${REL_TEXT[l.rel]}, ${l.source}] ${l.text}${refs(l)}`);
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
