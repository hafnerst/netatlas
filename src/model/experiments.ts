/**
 * Saved experiments (the `experiments:` section): a repeatable, explicitly
 * configured sequence of actions and observations applied to a defined
 * architecture and simulation state — not an automatic test of everything,
 * and not a scripting language.
 *
 * An experiment names its starting state (a freshly booted network, or one
 * that has run for `settle` first), its execution scope (the entire model, a
 * group, a VLAN, a failure domain or a device's dependency slice:
 * analysis/exec-scope.ts), the simulation parameters it sets, its actions and
 * its observations, and how long it runs (bounded). A step's time is
 * `at` after the start, or `at` after an earlier action was submitted
 * (`after`): a submitted action is no completed one — a time never promises
 * that a protocol's prerequisite has happened; an observation says what
 * happened.
 *
 * It runs on scenario time only (the simulated clock), so a run is
 * repeatable. Analysis data: a file means the same network with or without
 * it, and saving or editing one never starts it. A step that is not fully
 * configured stays in the model (its `missing` fields said), so that it can
 * be finished; an experiment with such a step can't be run. Pure types and
 * the shared definitions of every step kind (the editor, validation and the
 * runner read the same ones).
 */

/** What a step's target is. */
export type TargetKind =
  /** a communication's source: a device, device:interface or device/application */
  | 'source'
  /** what can fail: a device, cable, relation or failure domain */
  | 'failable'
  /** a device:interface */
  | 'iface'
  /** a host's device:interface (joins, leaves, streams, receptions) */
  | 'host-iface'
  /** a device */
  | 'device'
  /** a device/application */
  | 'app'
  /** a cable */
  | 'link'
  /** a multicast router */
  | 'router'
  /** an earlier step of this experiment (a send's or an application's id) */
  | 'step'
  /** saved expectations: their ids, or * for all */
  | 'expectations';

/** The other fields a step may have. */
export type StepField = 'to' | 'service' | 'group' | 'count' | 'interval' | 'port' | 'size';

export const FIELD_LABEL: { [k in StepField]: string } = {
  to: 'Destination',
  service: 'Service',
  group: 'Group',
  count: 'Messages',
  interval: 'Interval',
  port: 'UDP port',
  size: 'Payload (bytes)',
};

/** What an action does, with the simulation's own operations (analysis/sim). */
export type ExpActionKind = 'send' | 'fail' | 'restore' | 'shut' | 'no_shut' | 'power_off' | 'power_on' | 'flap' | 'stop_flap' | 'join' | 'leave' | 'start_stream' | 'stop_stream' | 'start_app' | 'stop_app';

export interface ActionDef {
  id: ExpActionKind;
  label: string;
  /** "Send to {to}" — how an entry reads in the sequence */
  verb: string;
  target: TargetKind;
  required: StepField[];
  optional: StepField[];
  /** what it means, in one line (the editor's help) */
  help: string;
}

export const EXP_ACTIONS: ReadonlyArray<ActionDef> = [
  { id: 'send', label: 'Send network packets', verb: 'Send from', target: 'source', required: ['to'], optional: ['service', 'count', 'interval'], help: 'A ping, TCP or UDP exchange, prepared from the communication’s identity as Trace path’s handoff.' },
  { id: 'fail', label: 'Fail', verb: 'Fail', target: 'failable', required: [], optional: [], help: 'A device is powered off; a cable or relation goes down; a failure domain fails with its members.' },
  { id: 'restore', label: 'Restore', verb: 'Restore', target: 'failable', required: [], optional: [], help: 'What a Fail took down comes back (a device boots).' },
  { id: 'shut', label: 'Shut interface', verb: 'Shut', target: 'iface', required: [], optional: [], help: 'The interface is administratively down until it is brought up.' },
  { id: 'no_shut', label: 'Bring interface up', verb: 'Bring up', target: 'iface', required: [], optional: [], help: 'No shut: the interface comes up again (its link-up delay).' },
  { id: 'power_off', label: 'Power off', verb: 'Power off', target: 'device', required: [], optional: [], help: 'The device stops at once.' },
  { id: 'power_on', label: 'Power on', verb: 'Power on', target: 'device', required: [], optional: [], help: 'The device boots (its boot time).' },
  { id: 'flap', label: 'Start flapping', verb: 'Start flapping', target: 'iface', required: [], optional: [], help: 'The cable at the interface goes down and up by the Layer 1 flapping parameters.' },
  { id: 'stop_flap', label: 'Stop flapping', verb: 'Stop flapping', target: 'iface', required: [], optional: [], help: 'The flapping ends with the cable up.' },
  { id: 'join', label: 'Join multicast group', verb: 'Join', target: 'host-iface', required: ['group'], optional: [], help: 'The host’s interface joins the group (IGMP / MLD report).' },
  { id: 'leave', label: 'Leave multicast group', verb: 'Leave', target: 'host-iface', required: ['group'], optional: [], help: 'The host’s interface leaves the group.' },
  { id: 'start_stream', label: 'Start multicast stream', verb: 'Start stream from', target: 'host-iface', required: ['group'], optional: ['port', 'interval', 'size'], help: 'The host sends UDP datagrams to the group, every interval of scenario time.' },
  { id: 'stop_stream', label: 'Stop multicast stream', verb: 'Stop stream from', target: 'host-iface', required: ['group'], optional: [], help: 'The stream that this host’s interface sends to the group ends.' },
  { id: 'start_app', label: 'Start application', verb: 'Start', target: 'app', required: [], optional: [], help: 'A client application’s messages to its configured peer or broker (its count and interval).' },
  { id: 'stop_app', label: 'Stop application', verb: 'Stop', target: 'app', required: [], optional: [], help: 'The application stops sending.' },
];

export interface ExpAction {
  /** a name for later steps to refer to (after:, an observation's target) */
  id?: string;
  /** ms after the start, or after the action named by `after` was submitted */
  at: number;
  /** the action this one comes after (its id) */
  after?: string;
  do: ExpActionKind;
  /** '' while not configured */
  target: string;
  to?: string;
  service?: string;
  group?: string;
  count?: number;
  /** ms */
  interval?: number;
  port?: number;
  size?: number;
  /** what still has to be configured (field names): the experiment can't run while any step has one */
  missing: string[];
  line: number;
}

/** What an observation reads, and what it may expect. */
export type ExpObserveKind = 'send' | 'app' | 'reach' | 'receive' | 'device' | 'interface' | 'link' | 'member' | 'expectations';

export interface ObserveDef {
  id: ExpObserveKind;
  label: string;
  target: TargetKind;
  /** the outcomes it can expect, the first the usual one */
  expect: string[];
  required: StepField[];
  optional: StepField[];
  /** what it reads, and what makes it satisfied */
  help: string;
  /** a window makes sense: over the window (traffic), or the state at its end (else read at once) */
  window: 'traffic' | 'state';
}

export const EXP_OBSERVE: ReadonlyArray<ObserveDef> = [
  { id: 'send', label: 'Delivery of a send', target: 'step', expect: ['delivered', 'failed'], required: [], optional: [], window: 'traffic', help: 'The messages of a Send action of this experiment: delivered when every message got its answer by the end of the window.' },
  { id: 'app', label: 'An application’s messages', target: 'step', expect: ['delivered', 'failed'], required: [], optional: [], window: 'traffic', help: 'A started application: delivered when every message (an MQTT client: every publication round due) went through by the end of the window.' },
  { id: 'reach', label: 'A communication is available', target: 'source', expect: ['available', 'unavailable'], required: ['to'], optional: ['service'], window: 'state', help: 'The communication check (addresses, path, policy, listener) on the simulation’s state at that time.' },
  { id: 'receive', label: 'A receiver gets multicast traffic', target: 'host-iface', expect: ['received', 'not received'], required: ['group'], optional: [], window: 'traffic', help: 'Datagrams of the group arriving at the host within the window (without one: since the start).' },
  { id: 'device', label: 'A device’s state', target: 'device', expect: ['on', 'off'], required: [], optional: [], window: 'state', help: 'Powered on (booting or operational) or off.' },
  { id: 'interface', label: 'An interface’s state', target: 'iface', expect: ['up', 'down'], required: [], optional: [], window: 'state', help: 'Up when the port is up and nothing has taken it down.' },
  { id: 'link', label: 'A cable’s state', target: 'link', expect: ['up', 'down'], required: [], optional: [], window: 'state', help: 'The cable carries traffic (both ends up).' },
  { id: 'member', label: 'A router’s multicast membership', target: 'router', expect: ['present', 'absent'], required: ['group'], optional: [], window: 'state', help: 'The group in the router’s IGMP / MLD membership table.' },
  { id: 'expectations', label: 'Saved expectations hold', target: 'expectations', expect: ['satisfied', 'violated'], required: [], optional: [], window: 'state', help: 'The model’s saved expectations (these ids, or * for all), evaluated on the simulation’s state at that time; the coverage says what could not be evaluated. No requirement is invented.' },
];

export interface ExpObservation {
  /** a name (results and comparisons refer to it) */
  id?: string;
  /** ms after the start (or after the action `after`); none: at the end */
  at?: number;
  after?: string;
  /** an evaluation window (ms): traffic is counted over it, a state must hold by its end; none: read at once */
  within?: number;
  of: ExpObserveKind;
  target: string;
  to?: string;
  service?: string;
  group?: string;
  expect: string;
  missing: string[];
  line: number;
}

/** Where a run starts and what it runs. */
export interface ExpScope {
  kind: 'entire' | 'group' | 'vlan' | 'domain' | 'device';
  /** the group, failure domain or device id; the VLAN number */
  value: string;
}

export interface Experiment {
  id: string;
  name: string;
  description?: string;
  /** how long it runs after the start (ms): bounded */
  duration: number;
  /** the scenario time run before the start (ms): 0, a freshly booted network */
  settle: number;
  scope: ExpScope;
  /** the simulation-wide parameters it sets (YAML keys as in Start simulation; the rest are the defaults) */
  params: Array<{ key: string; value: number | string }>;
  actions: ExpAction[];
  observations: ExpObservation[];
  /** why it can't run now (incomplete or unresolved steps, an unknown scope): empty when it can */
  problems: string[];
  line: number;
}

/** The keys of an experiment, of an action and of an observation, in the order they are written. */
export const EXPERIMENT_KEYS: readonly string[] = ['id', 'name', 'duration', 'settle', 'scope', 'params', 'actions', 'observe', 'description'];
export const EXP_ACTION_KEYS: readonly string[] = ['id', 'at', 'after', 'do', 'target', 'to', 'service', 'group', 'count', 'interval', 'port', 'size'];
export const EXP_OBSERVE_KEYS: readonly string[] = ['id', 'at', 'after', 'within', 'of', 'target', 'to', 'service', 'group', 'expect'];
export const EXP_SCOPE_KEYS: readonly string[] = ['group', 'vlan', 'domain', 'device'];

/** The longest an experiment may run, and the most actions and observations it may have. */
export const EXP_MAX_DURATION = 3600000;
export const EXP_MAX_STEPS = 200;

/**
 * The time of each step after the start (ms), its `after` chain resolved
 * ("after" an action: that action's time plus `at`), or why there is none (a
 * cycle, an unknown action). Observations without a time: the end.
 */
export function stepTimes(e: Experiment): { actions: Array<number | string>; observations: Array<number | string> } {
  const byId = new Map<string, number>();
  e.actions.forEach((a, k) => {
    if (a.id) byId.set(a.id, k);
  });
  const memo = new Map<number, number | string>();
  const timeOf = (k: number, seen: Set<number>): number | string => {
    if (memo.has(k)) return memo.get(k) as number | string;
    const a = e.actions[k];
    let t: number | string;
    if (!a.after) t = a.at;
    else if (!byId.has(a.after)) t = `no action has the id "${a.after}"`;
    else if (seen.has(k)) t = `a cycle of "after": ${a.after}`;
    else {
      seen.add(k);
      const b = timeOf(byId.get(a.after) as number, seen);
      t = typeof b === 'string' ? b : b + a.at;
    }
    memo.set(k, t);
    return t;
  };
  const actions = e.actions.map((_, k) => timeOf(k, new Set()));
  const observations = e.observations.map((o) => {
    if (!o.after) return o.at === undefined ? e.duration : o.at;
    const k = byId.get(o.after);
    if (k === undefined) return `no action has the id "${o.after}"`;
    const b = actions[k];
    return typeof b === 'string' ? b : b + (o.at || 0);
  });
  return { actions, observations };
}

export function actionDef(kind: string): ActionDef | undefined {
  return EXP_ACTIONS.find((x) => x.id === kind);
}

export function observeDef(kind: string): ObserveDef | undefined {
  return EXP_OBSERVE.find((x) => x.id === kind);
}

/** "1.5 s", "2 min", "100 ms" */
export function durText(ms: number): string {
  if (ms % 60000 === 0 && ms >= 60000) return `${ms / 60000} min`;
  if (ms >= 1000) return `${+(ms / 1000).toFixed(3)} s`;
  return `${ms} ms`;
}

/** When a step happens, in words: "At start", "At 10 s", "5 s after “join”" (after a submission: no promise about its effect). */
export function whenText(s: { at?: number; after?: string }, end?: number): string {
  if (s.after) return s.at ? `${durText(s.at)} after “${s.after}” is submitted` : `When “${s.after}” is submitted`;
  if (s.at === undefined) return end !== undefined ? `At the end (${durText(end)})` : 'At the end';
  return s.at === 0 ? 'At start' : `At ${durText(s.at)}`;
}

/** An action as a sequence entry: "At 10 s: Shut sw:p1", "5 s after “join”: Start stream from h:e0 → 239.1.1.1". */
export function actionText(a: ExpAction): string {
  const d = actionDef(a.do);
  const what = d ? d.verb : a.do;
  const t = a.target || '…';
  const more = a.do === 'send' ? ` → ${a.to || '…'}${a.service ? ` (${a.service})` : ''}${a.count && a.count > 1 ? ` ×${a.count}` : ''}` : a.group !== undefined || (d && d.required.indexOf('group') >= 0) ? ` ${a.do === 'join' || a.do === 'leave' ? '' : '→ '}${a.group || '…'}` : '';
  return `${whenText(a)}: ${what} ${t}${more}`;
}

/** An observation as a sequence entry: "At 30 s, within 5 s: hmi reaches plc/registers — expect available". */
export function observationText(o: ExpObservation, end?: number): string {
  const d = observeDef(o.of);
  const t = o.target || '…';
  const what =
    o.of === 'reach'
      ? `${t} reaches ${o.to || '…'}${o.service ? ` (${o.service})` : ''}`
      : o.of === 'receive'
        ? `${t} receives ${o.group || '…'}`
        : o.of === 'member'
          ? `${t} has member ${o.group || '…'}`
          : o.of === 'expectations'
            ? `expectations ${t === '*' ? '(all)' : t}`
            : o.of === 'send' || o.of === 'app'
              ? `delivery of “${t}”`
              : `${d ? d.label.replace(/^An? /, '').replace(/’s state$/, '') : o.of} ${t}`;
  return `${whenText(o, end)}${o.within ? `, within ${durText(o.within)}` : ''}: ${what} — expect ${o.expect || '…'}`;
}

/** A scope in words: "Entire model", "Group cell-b", "VLAN 20", "Failure domain cab", "Dependency slice of hmi". */
export function scopeText(s: ExpScope): string {
  return s.kind === 'entire' ? 'Entire model' : s.kind === 'group' ? `Group ${s.value}` : s.kind === 'vlan' ? `VLAN ${s.value}` : s.kind === 'domain' ? `Failure domain ${s.value}` : `Dependency slice of ${s.value}`;
}
