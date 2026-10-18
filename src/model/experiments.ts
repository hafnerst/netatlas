/**
 * Saved experiments (the \`experiments:\` section): a small declarative
 * sequence the simulation can run again and again from a clean start — not
 * a scripting language. An experiment names its start (the simulation-wide
 * parameters it sets; the rest are the defaults), its actions at times
 * relative to that start, what it observes and expects, and how long it
 * runs (bounded). It runs on scenario time only: the simulated clock, never
 * real (browser) time, so a run is repeatable; a stream of Network events,
 * which runs on real time, is no experiment action. Analysis data: a file
 * means the same network with or without it, and saving or editing one
 * never starts it. Pure types.
 */

/** What an action does, with the simulation's own operations (analysis/sim). */
export type ExpActionKind = 'send' | 'fail' | 'restore' | 'shut' | 'no_shut' | 'power_off' | 'power_on' | 'flap' | 'stop_flap' | 'join' | 'leave' | 'start_app' | 'stop_app';

export const EXP_ACTIONS: ReadonlyArray<{ id: ExpActionKind; label: string; target: string }> = [
  { id: 'send', label: 'Send network packets', target: 'the source (device, device:interface)' },
  { id: 'fail', label: 'Fail', target: 'a device, cable, relation or failure domain' },
  { id: 'restore', label: 'Restore', target: 'what failed' },
  { id: 'shut', label: 'Shut interface', target: 'device:interface' },
  { id: 'no_shut', label: 'Bring interface up', target: 'device:interface' },
  { id: 'power_off', label: 'Power off', target: 'a device' },
  { id: 'power_on', label: 'Power on', target: 'a device' },
  { id: 'flap', label: 'Start flapping', target: 'device:interface (a cabled port)' },
  { id: 'stop_flap', label: 'Stop flapping', target: 'device:interface' },
  { id: 'join', label: 'Join multicast group', target: 'device:interface (with group)' },
  { id: 'leave', label: 'Leave multicast group', target: 'device:interface (with group)' },
  { id: 'start_app', label: 'Start application', target: 'device/application (a client)' },
  { id: 'stop_app', label: 'Stop application', target: 'device/application' },
];

export interface ExpAction {
  /** a name for observations to refer to (a send, a start) */
  id?: string;
  /** ms after the start */
  at: number;
  do: ExpActionKind;
  target: string;
  /** send: the destination (device, device:interface, address, application, service) and what is sent ("tcp/443", "udp/53", "icmp") */
  to?: string;
  service?: string;
  /** send: messages and their interval (ms) */
  count?: number;
  interval?: number;
  /** join, leave: the group */
  group?: string;
  line: number;
}

/** What an observation reads, and what it may expect. */
export type ExpObserveKind = 'send' | 'device' | 'interface' | 'link' | 'member' | 'app' | 'reach';

export const EXP_OBSERVE: ReadonlyArray<{ id: ExpObserveKind; label: string; expect: string[]; target: string }> = [
  { id: 'send', label: 'A send’s delivery', expect: ['delivered', 'failed'], target: 'the send action’s id' },
  { id: 'app', label: 'An application’s messages', expect: ['delivered', 'failed'], target: 'the start action’s id, or device/application' },
  { id: 'device', label: 'A device’s state', expect: ['on', 'off'], target: 'a device' },
  { id: 'interface', label: 'An interface’s state', expect: ['up', 'down'], target: 'device:interface' },
  { id: 'link', label: 'A cable’s state', expect: ['up', 'down'], target: 'a cable' },
  { id: 'member', label: 'A multicast membership', expect: ['present', 'absent'], target: 'a multicast router (with group)' },
  { id: 'reach', label: 'A communication', expect: ['available', 'unavailable'], target: 'the source (with to, service)' },
];

export interface ExpObservation {
  /** ms after the start; none: at the end */
  at?: number;
  of: ExpObserveKind;
  target: string;
  to?: string;
  service?: string;
  group?: string;
  expect: string;
  line: number;
}

export interface Experiment {
  id: string;
  name: string;
  description?: string;
  /** how long it runs (ms): bounded */
  duration: number;
  /** the simulation-wide parameters it sets (YAML keys as in Start simulation; the rest are the defaults) */
  params: Array<{ key: string; value: number | string }>;
  actions: ExpAction[];
  observations: ExpObservation[];
  line: number;
}

/** The keys of an experiment, of an action and of an observation, in the order they are written. */
export const EXPERIMENT_KEYS: readonly string[] = ['id', 'name', 'duration', 'params', 'actions', 'observe', 'description'];
export const EXP_ACTION_KEYS: readonly string[] = ['id', 'at', 'do', 'target', 'to', 'service', 'group', 'count', 'interval'];
export const EXP_OBSERVE_KEYS: readonly string[] = ['at', 'of', 'target', 'to', 'service', 'group', 'expect'];

/** The longest an experiment may run, and the most actions and observations it may have. */
export const EXP_MAX_DURATION = 3600000;
export const EXP_MAX_STEPS = 200;
