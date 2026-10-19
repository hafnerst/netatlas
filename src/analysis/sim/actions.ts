/**
 * Network events as operations: what the simulation panel's Network events
 * started (network packets sent, a multicast group joined, a stream started,
 * an interface shut or set flapping), each with a stable id, its state and
 * its result. One lifecycle for all of them:
 *
 * - **Queued:** accepted, nothing sent yet (a send waiting for its source's
 *   DHCP lease before its first packet).
 * - **In progress:** doing its work in the simulation (messages still to
 *   send or on their way; a join until a multicast router records the
 *   membership or its reports are done; a stream; flapping).
 * - **Completed:** finished. That says nothing about success: the outcome
 *   says how it went.
 * - **Failed:** it could not be carried out at all (the simulation refused
 *   it, or no message of a send could be sent).
 * - **Paused:** a stream of real time while the simulation is paused (its
 *   schedule stands, and goes on from there when it plays).
 * - **Stopped:** ended by Stop before its end (a series, a stream, flapping).
 * - **Cancelled:** stopped before anything was sent.
 *
 * The state is read from the simulation each time (its messages, the
 * stream, the flapping, the membership), never kept apart from it: pausing
 * changes nothing, and nothing looks done before it is. A command that
 * changes a state (Shut interface, Join group) completes when it has done
 * its part; the state it leaves (the interface down, the membership) is
 * shown beside it, with the way back.
 *
 * How success is judged, per operation:
 * - **Unicast messages:** answered (an echo reply, a UDP answer, a TCP
 *   connection answered); an error or no answer in time is a failure; a
 *   message still on its way is pending, never a failure.
 * - **Multicast messages:** received by at least one member (the
 *   simulation sees every member); nobody: failed.
 * - **Broadcast messages:** no success rate. An answer proves receipt; no
 *   answer proves nothing (hosts answer broadcast pings only when set to,
 *   closed UDP ports send no error to a broadcast), so it is *unknown*.
 * - **Join, stream, shut, flapping:** no success rate: their outcome is a
 *   state (recorded membership, datagrams received, the interface down,
 *   cycles done).
 */
import { Flap } from './engine';
import { LeaveWatch, Stream } from './multicast';
import { DELIVERY_LABEL, KIND_LABEL, TestPlan } from './test-plan';
import { Test } from './transport';
import { AppRun, appCadence, appOutcome, appSummaryText } from './apps';
import { appProfile } from '../../model/applications';

export type ActionKind = 'send' | 'join' | 'leave' | 'stream' | 'shut' | 'flap' | 'app';
export type ActionStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'cancelled';

export const ACTION_TITLE: Record<ActionKind, string> = { send: 'Send network packets', join: 'Join multicast group', leave: 'Leave multicast group', stream: 'Multicast stream', shut: 'Shut interface', flap: 'Flapping', app: 'Application' };
export const STATUS_LABEL: Record<ActionStatus, string> = { queued: 'Queued', running: 'In progress', paused: 'Paused', completed: 'Completed', failed: 'Failed', stopped: 'Stopped', cancelled: 'Cancelled' };
/** An icon per state (beside its word: never the colour alone). */
export const STATUS_ICON: Record<ActionStatus, string> = { queued: '◷', running: '▶', paused: '❚❚', completed: '✓', failed: '✕', stopped: '■', cancelled: '⊘' };

/** The events kept: the oldest finished ones go beyond this; Clear finished removes them all. */
export const MAX_ACTIONS = 50;

/** The result of a Send network packets as a send's messages show it. */
export interface SendRun {
  id: number;
  series: string;
  plan: TestPlan;
  count: number;
  interval: number;
  t0: number;
  sent: number;
  tests: Test[];
  skipped: Array<{ n: number; t: number; why: string }>;
  stopped: boolean;
  stoppedAt?: number;
}

/** One operation of Network events. */
export interface ActionRecord {
  id: number;
  kind: ActionKind;
  /** submitted at (simulated ms) */
  at: number;
  /** what it was aimed at: "laptop → nas", "h3:eth0 → 239.2.2.2", "core:Vlan30" */
  target: string;
  /** refused by the simulation: why */
  error?: string;
  /** a join's or a stream's traffic: the id its messages carry (as a send's messages carry their test's) */
  traffic?: number;
  run?: SendRun;
  join?: { dev: string; iface: string; group: string; sources: string[]; until: number; by?: string; byAt?: number; leftAt?: number };
  /** a leave: whether it could be sent, what the network had learned and what became of each (removed, or kept by another member) */
  leave?: { dev: string; iface: string; group: string; sent: boolean; watch: LeaveWatch[]; until: number; removed: string[]; kept: string[]; done?: number };
  stream?: Stream;
  shut?: { dev: string; iface: string; upAt?: number };
  flap?: { ref: string; obj: Flap };
  /** Start application: its run (apps.ts), or an MQTT client's session (mqtt.ts) */
  app?: AppRun;
}

/** A control of an event: Stop (a send, a stream, flapping), No shut, Leave group. */
export interface ActionControl {
  op: 'stop' | 'noshut' | 'leave';
  label: string;
}

/** An event as the list shows it: a compact summary, and its details behind a disclosure. */
export interface ActionView {
  id: number;
  kind: ActionKind;
  title: string;
  target: string;
  status: ActionStatus;
  at: number;
  /** when it finished (completed, failed, stopped, cancelled) */
  ended?: number;
  /** measurable progress (total null: open-ended) */
  progress?: { done: number; total: number | null; unit: string };
  /** outcome counts and how success is judged; `rate`: a success rate is meaningful */
  outcome?: { ok: number; failed: number; pending: number; unknown: number; cancelled: number; rate: boolean; basis: string };
  /** one short line: the outcome */
  summary: string;
  /** the state it left, when that is not its own lifecycle ("interface down (shut)", "member of 239.2.2.2") */
  state?: string;
  controls: ActionControl[];
  details: string[];
  /** the Send network packets' messages (their ids), to open in the packet inspector */
  tests: number[];
}

const sec = (ms: number): string => `${Math.round(ms) / 1000} s`;
const at = (ms: number): string => `t = ${sec(ms)}`;

/** A send's messages as outcomes: answered, failed, pending, unknown (a broadcast nobody answered), cancelled. */
export function sendOutcome(r: SendRun): NonNullable<ActionView['outcome']> {
  const d = r.plan.delivery;
  const bcast = d === 'broadcast' || d === 'directed';
  let ok = 0;
  let failed = r.skipped.length;
  let pending = 0;
  let unknown = 0;
  let cancelled = 0;
  for (const t of r.tests) {
    if (!t.done) pending++;
    else if (t.result === CANCELLED) cancelled++;
    else if (/^not sent/.test(t.result)) failed++;
    else if (bcast) {
      if (t.answers.length) ok++;
      else unknown++;
    } else if (t.ok) ok++;
    else failed++;
  }
  const basis = bcast
    ? 'No success rate: an answer proves receipt, no answer proves nothing (broadcast pings are answered only where switched on).'
    : d === 'multicast'
      ? 'Success: received by at least one member of the group.'
      : 'Success: answered (an echo reply, a UDP answer, a TCP connection answered).';
  return { ok, failed, pending, unknown, cancelled, rate: !bcast, basis };
}

/** A send's result text for a cancelled message (Stop before it was sent). */
export const CANCELLED = 'not sent: cancelled (Stop)';

/** The state of a send: from its messages. */
export function sendStatus(r: SendRun): ActionStatus {
  const going = r.tests.filter((t) => !t.done);
  const more = !r.stopped && r.sent < r.count;
  // queued: nothing has left yet, every message waits for the source's DHCP lease
  const waiting = (t: Test): boolean => t.result.indexOf('waiting for a DHCP lease') === 0 && !t.pktIds.length && !t.conn;
  if (!r.stopped && r.tests.length && r.tests.every((t) => !t.done && waiting(t))) return 'queued';
  if (going.length || more) return 'running';
  const o = sendOutcome(r);
  if (r.stopped) return o.ok + o.failed + o.unknown === 0 ? 'cancelled' : 'stopped';
  if (o.ok + o.unknown === 0 && o.failed > 0 && r.tests.every((t) => /^not sent/.test(t.result))) return 'failed';
  return 'completed';
}

/** When a send finished: its last message's end (its timeout or answer), or Stop. */
function sendEnded(r: SendRun, s: ActionStatus): number | undefined {
  if (s === 'queued' || s === 'running') return undefined;
  let t = r.stoppedAt !== undefined ? r.stoppedAt : r.t0;
  for (const x of r.tests) t = Math.max(t, x.ended !== undefined ? x.ended : x.started);
  for (const x of r.skipped) t = Math.max(t, x.t);
  return t;
}

/** The view of a Send network packets. */
export function sendView(a: ActionRecord, now: number): ActionView {
  const r = a.run as SendRun;
  const p = r.plan;
  const status = sendStatus(r);
  const o = sendOutcome(r);
  const parts: string[] = [];
  if (o.ok) parts.push(`${o.ok} ${p.delivery === 'multicast' ? 'received' : 'answered'}`);
  if (o.failed) parts.push(`${o.failed} failed`);
  if (o.unknown) parts.push(`${o.unknown} unanswered (receipt unknown)`);
  if (o.pending) parts.push(`${o.pending} pending`);
  if (o.cancelled) parts.push(`${o.cancelled} cancelled`);
  // receivers: a group's members, a broadcast's answerers (who, over all messages)
  const who = new Set<string>();
  if (p.delivery !== 'unicast') for (const t of r.tests) for (const x of t.answers) who.add(x.replace(/^[^(]*\((.*)\)$/, '$1'));
  const recv = who.size ? `${p.delivery === 'multicast' ? 'received by' : 'answered by'} ${Array.from(who).sort().join(', ')}` : '';
  const details: string[] = [];
  details.push(`${DELIVERY_LABEL[p.delivery]} · ${KIND_LABEL[p.kind]}${p.port !== undefined ? ' ' + p.port : ''} · ${r.count} message${r.count === 1 ? '' : 's'}${r.count > 1 ? ' every ' + sec(r.interval * 1000) : ''} · submitted ${at(a.at)}`);
  details.push(o.basis);
  if (recv) details.push(`Receivers (over all messages): ${recv.replace(/^(received|answered) by /, '')}.`);
  details.push('Counts are of the messages sent from the source: replies, retransmissions and the copies of a broadcast or group are not counted.');
  const shown = r.tests.length <= 12 ? r.tests : r.tests.slice(0, 3).concat(r.tests.slice(-9));
  for (const t of shown) details.push(`#${t.msg || 1} at ${at(t.started)}: ${t.done ? t.result : t.result === 'waiting' ? 'on its way' : t.result}`);
  if (shown.length < r.tests.length) details.splice(details.length - 9, 0, `… ${r.tests.length - shown.length} more …`);
  for (const s of r.skipped.slice(-3)) details.push(`#${s.n} at ${at(s.t)}: ${s.why}`);
  if (r.stopped) details.push(`Stopped at ${at(r.stoppedAt as number)} after ${r.sent} of ${r.count}.`);
  const controls: ActionControl[] = status === 'queued' || status === 'running' ? (!r.stopped && (r.sent < r.count || status === 'queued') ? [{ op: 'stop', label: 'Stop' }] : []) : [];
  void now;
  return {
    id: a.id,
    kind: 'send',
    title: ACTION_TITLE.send,
    target: `${r.series}${r.count > 1 ? ` · ${r.count} × ${sec(r.interval * 1000)}` : ''}`,
    status,
    at: a.at,
    ended: sendEnded(r, status),
    progress: { done: r.sent, total: r.count, unit: 'sent' },
    outcome: o,
    summary: (parts.join(' · ') || 'nothing sent yet') + (recv ? ` · ${recv}` : ''),
    controls,
    details,
    tests: r.tests.map((t) => t.id),
  };
}

/** What the views of the other operations read from the simulation now. */
export interface ActionContext {
  now: number;
  member(dev: string, iface: string, group: string): boolean;
  /** where the traffic of an id was last dropped, and why (the event log), or null */
  lastDrop(id: number): { device: string; why: string } | null;
  shut(dev: string, iface: string): boolean;
  /** the flapping cycles in effect (0: until stopped), its down and up times */
  flapCycles: number;
  flapTimes: string;
  /** is a device on (a stream's source) */
  deviceOn?(dev: string): boolean;
  /** an MQTT client's session has a view of its own (mqtt.ts) */
  appView?(a: ActionRecord): ActionView | null;
}

function failedView(a: ActionRecord, title: string): ActionView {
  return { id: a.id, kind: a.kind, title, target: a.target, status: 'failed', at: a.at, ended: a.at, summary: a.error as string, controls: [], details: [`Refused at ${at(a.at)}: ${a.error}`], tests: [] };
}

/** The view of a started application: its messages as one operation, with what each came to. */
export function appView(a: ActionRecord, c: ActionContext): ActionView {
  const r = a.app as AppRun;
  if (c.appView) {
    const v = c.appView(a);
    if (v) return v;
  }
  const p = appProfile(r.app.profile);
  const o = appOutcome(r);
  const active = (!r.stopped && (r.count === null || r.sent < r.count)) || r.tests.some((t) => !t.done);
  const status: ActionStatus = active ? 'running' : r.stopped ? (o.ok + o.failed === 0 ? 'cancelled' : 'stopped') : o.ok === 0 && o.failed > 0 && r.tests.every((t) => /^not sent/.test(t.result)) ? 'failed' : 'completed';
  let ended: number | undefined;
  if (!active) {
    ended = r.stoppedAt !== undefined ? r.stoppedAt : r.t0;
    for (const t of r.tests) ended = Math.max(ended, t.ended !== undefined ? t.ended : t.started);
    for (const s of r.skipped) ended = Math.max(ended, s.t);
  }
  const details: string[] = [];
  details.push(`${r.dev}/${r.app.id} (${r.app.name}): ${p ? p.label : r.app.profile} to ${r.target}, ${appCadence(r)}; started ${at(a.at)}.`);
  details.push(p && !p.answered ? 'Success: the datagram reached its receiver (the simulation sees it; nothing comes back).' : 'Success: answered (a TCP connection with its answer, a UDP answer); a request that timed out is sent again up to its retries.');
  const shown = r.tests.length <= 12 ? r.tests : r.tests.slice(0, 3).concat(r.tests.slice(-9));
  for (const t of shown) details.push(`#${t.msg || 1}${t.retry ? ` (retry ${t.retry})` : ''} at ${at(t.started)}${t.resolved ? ` · ${t.resolved}` : ''}: ${t.done ? t.result : t.result === 'waiting' ? 'on its way' : t.result}`);
  if (shown.length < r.tests.length) details.splice(details.length - 9, 0, `… ${r.tests.length - shown.length} more …`);
  for (const s of r.skipped.slice(-3)) details.push(`#${s.n} at ${at(s.t)}: ${s.why}`);
  if (r.stopped && r.stoppedAt !== undefined) details.push(`Stopped at ${at(r.stoppedAt)} after ${r.sent} message${r.sent === 1 ? '' : 's'}.`);
  return {
    id: a.id,
    kind: 'app',
    title: ACTION_TITLE.app,
    target: `${r.dev}/${r.app.id} → ${r.target}`,
    status,
    at: a.at,
    ended,
    progress: { done: r.sent, total: r.count, unit: 'sent' },
    outcome: { ok: o.ok, failed: o.failed, pending: o.pending, unknown: 0, cancelled: o.cancelled, rate: true, basis: details[1] },
    summary: appSummaryText(r, o),
    controls: active && !r.stopped && (r.count === null || r.sent < r.count) ? [{ op: 'stop', label: 'Stop' }] : [],
    details,
    tests: r.tests.map((t) => t.id),
  };
}

/** The view of any operation. */
export function actionView(a: ActionRecord, c: ActionContext): ActionView {
  if (a.kind === 'send' && a.run) return sendView(a, c.now);
  if (a.kind === 'app' && a.app) return appView(a, c);
  const title = ACTION_TITLE[a.kind];
  if (a.error) return failedView(a, title);
  const base = { id: a.id, kind: a.kind, title, target: a.target, at: a.at, tests: a.traffic !== undefined ? [a.traffic] : ([] as number[]) };
  if (a.kind === 'join' && a.join) {
    const j = a.join;
    const member = c.member(j.dev, j.iface, j.group);
    // the join is done when a multicast router recorded it, or when its unsolicited reports are sent (nobody recorded it)
    const done = j.byAt !== undefined || c.now >= j.until || j.leftAt !== undefined;
    const ended = j.byAt !== undefined ? j.byAt : j.leftAt !== undefined && j.leftAt < j.until ? j.leftAt : done ? j.until : undefined;
    const summary = j.by ? `membership recorded by ${j.by}` : done ? 'no multicast router recorded it: a member on its own segment only' : 'reports sent, waiting for a multicast router';
    return {
      ...base,
      status: done ? 'completed' : 'running',
      ended,
      summary,
      state: member ? `member of ${j.group}` : `not a member (left${j.leftAt !== undefined ? ' at ' + at(j.leftAt) : ''})`,
      controls: member ? [{ op: 'leave', label: 'Leave group' }] : [],
      details: [`${j.dev}:${j.iface} joins ${j.group}${j.sources.length ? ' (sources ' + j.sources.join(', ') + ')' : ''} at ${at(a.at)}: an unsolicited report at once and one more later.`, j.by ? `Recorded by ${j.by} at ${at(j.byAt as number)}.` : done ? 'No multicast router on its segment recorded the membership by the second report.' : 'Waiting for a multicast router to record it.', 'The membership lasts until Leave group; data reaches it only if multicast routing brings it there.'],
    };
  }
  if (a.kind === 'leave' && a.leave) {
    const l = a.leave;
    const pending = l.watch.length - l.removed.length - l.kept.length;
    const done = l.done !== undefined;
    const what = !l.watch.length ? 'nothing learned on its way to remove' : [l.removed.length ? `removed at ${l.removed.join(', ')}` : '', l.kept.length ? `kept at ${l.kept.join(', ')}: another member there answered` : ''].filter((x) => x).join(' · ');
    if (!l.sent)
      return { ...base, status: 'failed', ended: a.at, summary: `${l.dev}:${l.iface} could not send its leave (its interface or device is down) · its membership ended locally`, state: `not a member of ${l.group}`, controls: [], details: [`${l.dev}:${l.iface} leaves ${l.group} at ${at(a.at)}: it answers no query for it any more, but no leave could be sent now.`, l.watch.length ? `The network forgets it when no report arrives within the membership interval: ${l.watch.map((w) => w.where).join(', ')}.` : 'Nothing was learned of it on its way.'] };
    return {
      ...base,
      status: done ? 'completed' : 'running',
      ended: l.done,
      progress: l.watch.length ? { done: l.removed.length + l.kept.length, total: l.watch.length, unit: 'entries settled' } : undefined,
      summary: `leave sent${done ? ' · ' + what : ` · cleanup pending (${pending} of ${l.watch.length})${l.removed.length ? ' · removed at ' + l.removed.join(', ') : ''}`}`,
      state: `not a member of ${l.group}`,
      controls: [],
      details: [
        `${l.dev}:${l.iface} leaves ${l.group} at ${at(a.at)}: its membership ends now (it answers no query for the group any more) and its leave goes out: an IGMPv2 Leave / MLDv1 Done, or an IGMPv3 / MLDv2 report that blocks its sources.`,
        l.watch.length ? `What the network had learned of it on its way: ${l.watch.map((w) => w.where).join(', ')}. Each goes after the querier's group-specific queries (robustness × last member query interval) unless another member there answers; fast leave removes a switch's port at once.` : 'Nothing was learned of it on its way (no snooping switch, no multicast router recorded it).',
        ...(l.removed.length ? [`Removed: ${l.removed.join(', ')}.`] : []),
        ...(l.kept.length ? [`Kept (another member there still wants the group): ${l.kept.join(', ')}.`] : []),
        'A stream to the group goes on; only the way to this host closes.',
      ],
    };
  }
  if (a.kind === 'stream' && a.stream) {
    const st = a.stream;
    const rx = Array.from(st.rx.entries()).sort((x, y) => (x[0] < y[0] ? -1 : 1));
    const got = rx.reduce((n, x) => n + x[1], 0);
    // where its copies stop (a router without multicast routing, no member behind a snooping switch …): from the log
    const stop = a.traffic !== undefined ? c.lastDrop(a.traffic) : null;
    const off = st.running && c.deviceOn ? !c.deviceOn(st.dev) : false;
    const status: ActionStatus = !st.running ? 'stopped' : 'running';
    const every = `every ${sec(st.interval)} of simulated time`;
    const left = st.offMissed || 0;
    return {
      ...base,
      status,
      ended: st.running ? undefined : st.stoppedAt,
      progress: { done: st.sent, total: null, unit: 'datagrams sent' },
      summary: `${st.sent} datagram${st.sent === 1 ? '' : 's'} sent, ${every}${off ? ` · not sending: ${st.dev} is off` : ''} · ${rx.length ? `received by ${rx.map((x) => `${x[0]} (${x[1]})`).join(', ')}` : `no member received any yet${stop ? ` · stops at ${stop.device}` : ''}`}`,
      controls: st.running ? [{ op: 'stop', label: 'Stop stream' }] : [],
      details: [
        `Stream #${st.id}: UDP to ${st.group}:${st.port} from source port ${st.sport}, ${st.size} bytes ${every} from ${at(st.since)}${st.stoppedAt !== undefined ? ', stopped at ' + at(st.stoppedAt) : ''}.`,
        'The interval is simulated time (the scenario’s): the first datagram at the start, then one every interval — the same datagrams whatever the pacing, the speed or the page’s frame rate; those only change how fast they are shown.',
        `Generated: ${st.sent} datagram${st.sent === 1 ? '' : 's'} at the source (the copies multicast replicates are not counted). Received: ${got} in all, counted at the members (a member's copy is one).`,
        ...(left ? [`Not sent: ${left} while ${st.dev} was off.`] : []),
        'Who receives it: the members of the group (Join multicast group) in its VLAN — a switch with IGMP / MLD snooping enabled sends it only to ports where a member reported it, and to its multicast router ports — and in other subnets those multicast routing (PIM) reaches.',
        ...(stop ? [`Last stopped at ${stop.device}: ${stop.why}`] : []),
      ],
    };
  }
  if (a.kind === 'shut' && a.shut) {
    const sh = a.shut;
    const down = c.shut(sh.dev, sh.iface);
    return {
      ...base,
      status: 'completed',
      ended: a.at,
      summary: `shut at ${at(a.at)}`,
      state: down ? 'interface down (shut)' : `interface up again (no shut${sh.upAt !== undefined ? ' at ' + at(sh.upAt) : ''})`,
      controls: down ? [{ op: 'noshut', label: 'No shut' }] : [],
      details: [`${sh.dev}:${sh.iface} administratively down at ${at(a.at)}: its cable goes down, the far end notices after its loss-of-signal detection.`, down ? 'It stays down until No shut.' : `No shut${sh.upAt !== undefined ? ' at ' + at(sh.upAt) : ''}.`],
    };
  }
  const f = (a.flap as NonNullable<ActionRecord['flap']>).obj;
  const total = c.flapCycles > 0 ? c.flapCycles : null;
  const status: ActionStatus = f.ended === 'stopped' ? 'stopped' : f.ended === 'done' ? 'completed' : 'running';
  return {
    ...base,
    status,
    ended: f.endedAt,
    progress: { done: f.done, total: f.ended ? f.done : total, unit: 'cycles' },
    summary: f.ended ? `${f.done} cycle${f.done === 1 ? '' : 's'} done` : `now ${f.down ? 'down' : 'up'} · cycle ${f.done + (f.down ? 1 : 0)}${total ? ' of ' + total : ''}`,
    state: f.ended ? 'link up' : f.down ? 'link down' : 'link up',
    controls: f.ended ? [] : [{ op: 'stop', label: 'Stop flapping' }],
    details: [`Port ${f.ref.slice(6)} from ${at(f.since)}: ${c.flapTimes}; its cable ${f.link} goes down and up with it (the port stays administratively up).`, f.ended ? `${f.ended === 'done' ? 'Its cycles done' : 'Stopped'} at ${at(f.endedAt as number)}.` : 'Until its cycles are done, or Stop flapping.'],
  };
}
