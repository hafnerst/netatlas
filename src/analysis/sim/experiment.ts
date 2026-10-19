/**
 * Running a saved experiment (model/experiments.ts) on the shared
 * simulation engine: always from a clean start (a new simulation of the
 * model, or of its execution scope's sub-model, with the experiment's
 * parameters), on scenario time (the simulated clock: a run is
 * repeatable), with the simulation's own operations — Send network packets,
 * fail and restore, shut, power, flapping, joins and leaves, multicast
 * streams, applications — nothing of its own.
 *
 * The starting state: a freshly booted network (the default), one that
 * settles for `settle` first (its events are not the experiment's), or a
 * cold start: every device with a power lifecycle (not a cable, a patch
 * panel, an external network or a TAP, which have none) is off when the run
 * starts and is powered on at t = 0, then boots as the simulation boots it —
 * its boot time, its ports negotiating, a guest only once its host is up (a
 * container by its restart policy). Experiment time starts with the cold
 * start: boot time is the experiment's.
 *
 * Every step is an event of the engine at its scenario time, scheduled when
 * the run is prepared: an action at its time (`at` after the start, or after
 * an earlier action was submitted), an observation's window opening, its
 * readings, its end, and the end of the run. So whatever moves the clock —
 * the runner itself, in slices, or the diagram's pacing while the run plays
 * (sim-controller.ts) — the same events happen in the same order, and a run
 * gives the same result shown or not.
 *
 * Actions at one time are all applied before the clock moves on, in the
 * order written. An action is *submitted* or *refused* (with the
 * simulation's reason); whether it had its effect is what observations find.
 * An action whose device is still coming up (booting, or waiting for its
 * host) *waits* for it, said as such, and is submitted when the device is
 * operational (its log says how long it waited), or *timed out* when the run
 * ends first; a time after the start never waits for the whole network. An
 * action with `for` is undone after that long (restored, brought up,
 * powered on, stopped).
 *
 * An observation is read in its window: a state (a device, an interface, a
 * cable, an address, a neighbor, a route, a session, a membership, a timing
 * state, a communication, the saved expectations) is satisfied as soon as it
 * holds within its window (`within`; none: read at once) — "already held"
 * when it did when the window opened, else "reached" at the moment it was
 * found (the evidence's own time when it has one: a boot's end, a lease's
 * binding, a first datagram); traffic (a send's or an application's
 * deliveries, a receiver's datagrams, an MQTT subscriber's publications) is
 * counted until the window ends: what was sent is not what arrived. Verdicts:
 * satisfied, violated, indeterminate (not decidable: nothing sent yet, still
 * on its way, not reached), unsupported. Finishing the sequence proves
 * nothing: only observations do.
 *
 * The runner can advance itself in slices (step) so a page stays
 * responsive; Stop ends it, keeping what it observed and saying what was not
 * reached. Each runner is used once: running again makes a new one (a clean
 * start), and a stale runner's events never touch another (each checks its
 * own state). It also says which traffic is the experiment's (relevance.ts)
 * and what the run waits for now (status). None measures convergence time,
 * throughput or synchronization accuracy.
 */
import { ExpAction, ExpObservation, Experiment, durText, observeDef, scopeText, stepTimes } from '../../model/experiments';
import { Model, ifaceKey } from '../../model/types';
import { isGuest } from '../../model/virtual';
import { commIdentity, handoffOf } from '../comm-identity';
import { checkCommunication } from '../communication';
import { ExecScope, dependencyScope, domainScope, entireScope, groupScope, scopedModel, unionScope, vlanScope } from '../exec-scope';
import { evaluateExpectations } from '../expectations';
import { failureCondition } from '../failure';
import { ActionRecord } from './actions';
import { Relevance, relevanceSpec } from './relevance';
import { Simulation, TestRun } from './simulation';

export type ObsOutcome = 'satisfied' | 'violated' | 'indeterminate' | 'unsupported';

export const OUTCOME_TEXT: { [k in ObsOutcome]: string } = { satisfied: 'Satisfied', violated: 'Violated', indeterminate: 'Indeterminate', unsupported: 'Unsupported' };

export interface ObsResult {
  obs: ExpObservation;
  /** its index in the experiment */
  index: number;
  /** when it was decided (ms after the start): the evidence's own time where it has one */
  at: number;
  /** its window (ms after the start) */
  from: number;
  to: number;
  outcome: ObsOutcome;
  /** a state: it already held when the window opened, or was reached in it */
  held?: 'already' | 'reached';
  /** what was found: "delivered (3 of 3 messages)", "off", "unavailable: no route at r1" */
  actual: string;
}

export interface StepLog {
  action: ExpAction;
  index: number;
  /** when it was submitted (or refused, or began to wait), ms after the start */
  at: number;
  /** when it was due (ms after the start) */
  due: number;
  /**
   * submitted: the simulation took it (its effect is what observations find); refused: it could not;
   * waiting: its device is still coming up; timed out: the run ended while it waited; undone: its For ran out
   */
  state: 'submitted' | 'refused' | 'waiting' | 'timed out' | 'undone';
  /** what it did, or why it could not */
  text: string;
}

export interface ExpRunResult {
  experiment: string;
  name: string;
  /** the model it ran on (model/fingerprint.ts) */
  fingerprint: string;
  /** a run's timing is scenario time: the simulated clock */
  timing: 'scenario';
  duration: number;
  settle: number;
  /** the starting state, and for a cold start how many devices booted from off */
  start: 'booted' | 'cold';
  cold?: { devices: number; guests: number };
  /** "Entire model (12 devices)", "Group cell-b: 7 of 12 devices run" */
  scope: string;
  /** how far the scenario time got after the start (negative while settling) */
  reached: number;
  state: 'running' | 'done' | 'stopped' | 'refused';
  params: Array<{ key: string; value: number | string }>;
  actions: StepLog[];
  observations: ObsResult[];
  /** the notable events in order (state changes and drops), times after the start: "t, device: text" */
  events: Array<{ t: number; device: string; text: string }>;
  /** "4 observations: 3 satisfied, 1 violated" */
  summary: string;
}

let generation = 0;

/** How often a state is read within its window (scenario ms): cheap states often, the communication check and the expectations every second. */
const POLL = 100;
const POLL_SLOW = 1000;
/** How often an action waiting for its device looks again. */
const WAIT_POLL = 100;

/** The refs a fail or restore target stands for: a device, a cable, a relation, a failure domain's members. */
function failRefs(model: Model, target: string): string[] {
  if (model.index.devices.has(target)) return ['device:' + target];
  if (model.index.links.has(target)) return ['link:' + target];
  if (model.index.relations.has(target)) return ['relation:' + target];
  if (model.failureDomains.some((d) => d.id === target)) return failureCondition(model, [target]).refs;
  return [];
}

/** The devices an experiment's steps name (targets, destinations, peers): its "targets" scope starts from them. */
export function experimentDevices(model: Model, e: Experiment): string[] {
  const out = new Set<string>();
  const dev = (t: string | undefined): void => {
    if (!t) return;
    const d = t.split(/[:/]/)[0];
    if (model.index.devices.has(d)) out.add(d);
  };
  for (const a of e.actions) {
    if (a.do === 'fail' || a.do === 'restore') {
      for (const r of failRefs(model, a.target)) if (r.indexOf('device:') === 0) out.add(r.slice(7));
    } else dev(a.target);
    dev(a.to);
  }
  for (const o of e.observations) {
    if (o.of !== 'expectations' && o.of !== 'send' && o.of !== 'app') dev(o.target);
    if (o.of === 'app' || o.of === 'send') {
      const a = e.actions.find((x) => x.id === o.target);
      dev(a ? a.target : o.target);
    }
    if (o.of === 'link') {
      const l = model.index.links.get(o.target);
      if (l) {
        out.add(l.a.device);
        out.add(l.b.device);
      }
    }
    dev(o.to);
  }
  return Array.from(out).sort();
}

/** The execution scope of an experiment in a model. */
export function experimentScope(model: Model, e: Experiment): ExecScope {
  const s = e.scope;
  if (s.kind === 'group') return groupScope(model, s.value);
  if (s.kind === 'vlan') return vlanScope(model, Number(s.value));
  if (s.kind === 'domain') return domainScope(model, s.value);
  if (s.kind === 'device') return dependencyScope(model, s.value);
  if (s.kind === 'targets') {
    const devs = experimentDevices(model, e);
    if (!devs.length) return { ...entireScope(model), kind: 'dependencies', label: 'Targets and their dependencies', devices: new Set(), cannot: ['no step names a device yet'] };
    return unionScope(model, 'Targets and their dependencies', devs.map((d) => dependencyScope(model, d)));
  }
  return entireScope(model);
}

const split = (t: string): [string, string] => (t.indexOf(':') > 0 ? [t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1)] : [t, '']);
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

interface Pending {
  o: ExpObservation;
  index: number;
  from: number;
  to: number;
  /** a reception's count when its window opened */
  base?: number;
  /** read for the first time (its window just opened) */
  first: boolean;
  /** the last reading of a state (said when the window ends without it holding) */
  last?: { outcome: ObsOutcome; actual: string; at?: number };
  /** a device's boot was seen to end at this time (scenario ms after the start) */
  bootEnd?: number;
}

/** The actions that need their device up to be submitted (the others act on its power or state themselves). */
const NEEDS_DEVICE = new Set(['send', 'shut', 'no_shut', 'flap', 'stop_flap', 'join', 'leave', 'start_stream', 'stop_stream', 'start_app', 'stop_app']);

export class ExperimentRunner {
  readonly gen = ++generation;
  private sim: Simulation;
  private model: Model;
  private sends = new Map<string, TestRun>();
  private apps = new Map<string, ActionRecord>();
  /** the operation ids of the experiment's own traffic (joins, streams; sends' and applications' tests are found on demand) */
  private ops = new Set<number>();
  private res: ExpRunResult;
  private prepared = false;
  /** the open observation windows, and the actions waiting for their device */
  private open: Pending[] = [];
  private waits: Array<{ a: ExpAction; index: number; due: number; dev: string }> = [];
  /** the execution scope it runs (null: the entire model) */
  readonly execScope: ExecScope | null;
  /** which traffic is the experiment's */
  readonly relevance: Relevance;

  constructor(
    model: Model,
    private exp: Experiment,
    fingerprint: string,
    opts: { realClock?: () => number } = {},
  ) {
    const scope = exp.scope.kind === 'entire' ? null : experimentScope(model, exp);
    this.execScope = scope;
    this.model = scope && !scope.cannot.length ? scopedModel(model, scope) : model;
    const params: { [k: string]: number | string } = {};
    for (const p of exp.params) params[p.key] = p.value;
    this.sim = new Simulation(this.model, { params, realClock: opts.realClock });
    const n = model.devices.length;
    // (what the scope leaves out that can change the outcome is said with it: its results are the scope's, not the entire model's)
    const scopeLine = !scope ? `Entire model (${n} device${n === 1 ? '' : 's'})` : `${scopeText(exp.scope)}: ${scope.devices.size} of ${n} devices run${scope.caveats.length ? ` — may differ from the entire model: ${scope.caveats.join('; ')}` : ''}`;
    this.res = { experiment: exp.id, name: exp.name, fingerprint, timing: 'scenario', duration: exp.duration, settle: exp.settle, start: exp.start, scope: scopeLine, reached: -exp.settle, state: 'running', params: exp.params.slice(), actions: [], observations: [], events: [], summary: '' };
    this.relevance = new Relevance(
      relevanceSpec(this.model, exp, (dev, iface) => {
        try {
          return this.sim.broadcastDomain({ dev, iface }).devices;
        } catch (e) {
          return [];
        }
      }),
      (op) => this.owns(op),
    );
    // an experiment that isn't fully configured, or whose scope can't run, is not run
    const why = exp.problems.slice();
    if (scope && scope.cannot.length) why.push(...scope.cannot);
    if (why.length) {
      this.res.state = 'refused';
      this.res.summary = `Not run: ${why.join('; ')}`;
    }
  }

  /** The simulation it runs (its tables and log; the diagram plays it). */
  get simulation(): Simulation {
    return this.sim;
  }

  /** The engine time at which the run ends (the settling time and the duration). */
  get endTime(): number {
    return this.exp.settle + this.exp.duration;
  }

  /** Scenario time after the start (negative while settling). */
  private now(): number {
    return this.sim.now - this.exp.settle;
  }

  /** Run fn at a time after the start, if the run is still going then. */
  private at(t: number, fn: () => void): void {
    this.sim.engine.at(this.exp.settle + t, () => {
      if (this.res.state !== 'running') return;
      fn();
      this.res.reached = this.now();
    });
  }

  /**
   * Set the run up (once, before its clock moves): the starting state — a
   * cold start's devices off and powered on, or the settling time run at once
   * (not the experiment's) — then every step as an event of the engine.
   */
  prepare(): void {
    if (this.prepared || this.res.state !== 'running') return;
    this.prepared = true;
    const e = this.sim.engine;
    if (this.exp.start === 'cold') {
      // every device with a power lifecycle off now, then on: they boot as the simulation boots them (guests with their host)
      const off: string[] = [];
      let guests = 0;
      for (const d of this.model.devices) {
        if (isGuest(d)) continue;
        const p = e.powerState(d.id);
        if (p && p.state === 'on' && e.powerOff(d.id, ' (a cold start: every device starts off)')) off.push(d.id);
      }
      for (const d of this.model.devices) if (isGuest(d) && e.off.has(d.id)) guests++;
      for (const d of off) e.powerOn(d);
      this.res.cold = { devices: off.length, guests };
    } else if (this.exp.settle) this.sim.runTo(this.exp.settle);
    this.res.reached = this.now();
    const times = stepTimes(this.exp);
    // (at one moment: the actions first, in the order written, then the observations; the engine keeps that order)
    this.exp.actions.forEach((a, index) => {
      const t = times.actions[index] as number;
      this.at(t, () => this.apply(a, index, t));
    });
    this.exp.observations.forEach((o, index) => {
      const from = times.observations[index] as number;
      const p: Pending = { o, index, from, to: from + (o.within || 0), first: true };
      this.at(from, () => this.openWindow(p));
    });
    this.at(this.exp.duration, () => this.finish('done'));
  }

  /** Stop: the run ends where it is; what was not reached is said. */
  cancel(): void {
    if (this.res.state !== 'running') return;
    this.finish('stopped');
  }

  /** Is the run over (done, stopped or refused)? */
  get over(): boolean {
    return this.res.state !== 'running';
  }

  /**
   * Advance for at most `budget` ms of the page's time (`clock`); true when
   * the run is over (done, stopped or refused).
   */
  step(budget = 40, clock: () => number = () => Date.now()): boolean {
    if (this.res.state !== 'running') return true;
    this.prepare();
    const t0 = clock();
    const s = this.sim;
    while (this.res.state === 'running') {
      // (in slices of a second, so that it can be stopped)
      s.runTo(Math.min(this.endTime, s.now + 1000));
      if (this.res.state === 'running') this.res.reached = this.now();
      if (clock() - t0 > budget) break;
    }
    return this.res.state !== 'running';
  }

  /** Run to the end at once (tests, small models, Skip to the result). */
  runAll(): ExpRunResult {
    while (!this.step(1e9)) {
      /* (step runs until done with an unlimited budget) */
    }
    return this.result();
  }

  /** The result so far (while it runs: how far the clock got, what was submitted and decided). */
  result(): ExpRunResult {
    if (this.res.state === 'running' && this.prepared) this.res.reached = this.now();
    return this.res;
  }

  /**
   * The next notable moment of the run after an engine time (engine ms): a
   * step due (an action, a window opening or closing), a device of the
   * experiment done booting, the end. The diagram's idle skipping stops
   * there, so a change without traffic is seen.
   */
  notable(t: number): number | null {
    if (!this.prepared || this.res.state !== 'running') return null;
    const settle = this.exp.settle;
    let best = this.endTime;
    const times = stepTimes(this.exp);
    for (const x of times.actions) if (typeof x === 'number' && settle + x > t + 1e-6) best = Math.min(best, settle + x);
    this.exp.observations.forEach((o, k) => {
      const x = times.observations[k];
      if (typeof x !== 'number') return;
      for (const y of [settle + x, settle + x + (o.within || 0)]) if (y > t + 1e-6) best = Math.min(best, y);
    });
    this.sim.engine.booting.forEach((until, dev) => {
      if (until > t + 1e-6 && this.relevance.spec.devices.has(dev)) best = Math.min(best, until);
    });
    return best;
  }

  /** Is an operation id (a flight's `test`) the experiment's own traffic? */
  owns(op: number): boolean {
    if (this.ops.has(op)) return true;
    let found = false;
    this.sends.forEach((r) => {
      if (!found && r.tests.some((x) => x.id === op)) found = true;
    });
    this.apps.forEach((r) => {
      // (an application's messages carry their test's id; an MQTT client's session one id of its own)
      const mq = r.app ? (r.app as { mqtt?: { traffic?: number } }).mqtt : undefined;
      if (!found && r.app && (r.app.tests.some((x) => x.id === op) || (!!mq && mq.traffic === op))) found = true;
    });
    if (found) this.ops.add(op);
    return found;
  }

  /** What the run waits for now, in a few short lines ("Waiting for device boot: h1", "Waiting for DHCP: h1:eth0"). */
  status(): string[] {
    if (this.res.state !== 'running' || !this.prepared) return [];
    const e = this.sim.engine;
    const out: string[] = [];
    const devs = Array.from(this.relevance.spec.devices.keys());
    const booting = devs.filter((d) => {
      const p = e.powerState(d);
      return !!p && p.state === 'booting';
    });
    if (booting.length) out.push(`Booting: ${booting.slice(0, 3).map((d) => `${d} (up at t = ${secs((e.booting.get(d) as number) - this.exp.settle)})`).join(', ')}${booting.length > 3 ? ` +${booting.length - 3}` : ''}`);
    for (const w of this.waits) out.push(`Waiting for device boot: ${w.dev} (action ${w.index + 1})`);
    const dhcp = new Set<string>();
    this.sends.forEach((r) => r.tests.forEach((x) => !x.done && x.result.indexOf('waiting for a DHCP lease') === 0 && dhcp.add(r.plan.from || '?')));
    if (dhcp.size) out.push(`Waiting for DHCP: ${Array.from(dhcp).join(', ')}`);
    for (const w of e.waiting()) if (w.origin && this.relevance.spec.devices.has(w.origin)) out.push(`${w.origin}: ${w.label} waits for ${w.why}`);
    for (const p of this.open) {
      const o = p.o;
      if (o.of === 'address') out.push(`Waiting for an address: ${o.target}`);
      else if (o.of === 'neighbor') out.push(`Resolving neighbor: ${o.target} → ${o.to}`);
      else if (o.of === 'session') out.push(`Establishing ${(o.protocol || '').toUpperCase()} session: ${o.target}${o.to ? ' ↔ ' + o.to : ''}`);
      else if (o.of === 'receive' || o.of === 'mqtt') out.push(`Waiting for receiver delivery: ${o.target}`);
      else if (o.of === 'send' || o.of === 'app') out.push(`Waiting for delivery: “${o.target}”`);
      else if (o.of === 'timing') out.push(`Waiting for timing: ${o.target}`);
      else if (o.of === 'device' && (o.expect === 'operational' || o.expect === 'on')) out.push(`Waiting for ${o.target} to be ${o.expect}`);
    }
    return Array.from(new Set(out)).slice(0, 6);
  }

  // ------------------------------------------------------------ observations

  private openWindow(p: Pending): void {
    const s = this.sim;
    if (p.o.of === 'receive') {
      const r = s.multicastReceived(split(p.o.target)[0], p.o.group || '');
      p.base = p.o.within ? (r ? r.count : 0) : 0;
    }
    if (p.o.of === 'mqtt') {
      const sl = p.o.target.indexOf('/');
      const r = sl > 0 ? s.mqttReceived(p.o.target.slice(0, sl), p.o.target.slice(sl + 1), p.o.topic) : null;
      p.base = p.o.within ? (r ? r.count : 0) : 0;
    }
    this.open.push(p);
    const def = observeDef(p.o.of);
    if (!def || def.window === 'state') this.readState(p);
    else if (p.to <= p.from) this.decide(p, this.observe(p));
    else this.at(p.to, () => this.decide(p, this.observe(p)));
  }

  /** A state now: decided when it holds (or at its window's end), else read again shortly. */
  private readState(p: Pending): void {
    if (this.open.indexOf(p) < 0) return;
    const t = this.now();
    const r = this.observe(p);
    const first = p.first;
    p.first = false;
    p.last = r;
    if (r.outcome === 'satisfied' || r.outcome === 'unsupported' || t >= p.to) {
      if (r.outcome === 'satisfied') {
        const held = first ? 'already' : 'reached';
        this.decide(p, { ...r, actual: `${r.actual} — ${held === 'already' ? `already so when the window opened (t = ${secs(p.from)})` : `reached at t = ${secs(r.at !== undefined ? r.at : t)}`}` }, held, r.at);
      } else this.decide(p, { ...r, actual: r.actual + (p.o.within ? ` (throughout ${durText(p.o.within)})` : '') });
      return;
    }
    const slow = p.o.of === 'reach' || p.o.of === 'expectations';
    this.at(Math.min(p.to, t + (slow ? POLL_SLOW : POLL)), () => this.readState(p));
  }

  private decide(p: Pending, r: { outcome: ObsOutcome; actual: string }, held?: 'already' | 'reached', at?: number): void {
    const k = this.open.indexOf(p);
    if (k < 0) return;
    this.open.splice(k, 1);
    const t = this.now();
    this.res.observations.push({ obs: p.o, index: p.index, at: at !== undefined && at <= t ? at : t, from: p.from, to: p.to, outcome: r.outcome, held, actual: r.actual });
  }

  private finish(state: 'done' | 'stopped'): void {
    if (this.res.state !== 'running') return;
    const at = this.now();
    // what was still open: a run that ended reads it now (its window ends with the run); a stopped one did not get there
    for (const p of this.open.slice()) {
      if (state === 'done') {
        const def = observeDef(p.o.of);
        const r = this.observe(p);
        if (!def || def.window === 'state') this.decide(p, r.outcome === 'satisfied' ? { ...r, actual: `${r.actual} — reached at t = ${secs(r.at !== undefined ? r.at : at)}` } : r, r.outcome === 'satisfied' ? 'reached' : undefined, r.at);
        else this.decide(p, r);
      } else this.decide(p, { outcome: 'indeterminate', actual: `not decided: the run was stopped at t = ${secs(at)}` });
    }
    // what the run never got to (stopped before its window opened): said, never left out
    const times = stepTimes(this.exp);
    this.exp.observations.forEach((o, index) => {
      if (this.res.observations.some((x) => x.index === index)) return;
      const from = times.observations[index] as number;
      this.res.observations.push({ obs: o, index, at, from, to: from + (o.within || 0), outcome: 'indeterminate', actual: `not decided: the run was stopped at t = ${secs(at)}, before its window opened` });
    });
    for (const w of this.waits) {
      const s = this.res.actions.find((x) => x.index === w.index && x.state === 'waiting');
      if (s) {
        s.state = state === 'done' ? 'timed out' : 'refused';
        s.text = state === 'done' ? `${w.dev} did not come up before the end (waited ${durText(Math.max(0, at - w.due))}): not submitted` : `not submitted: the run was stopped while it waited for ${w.dev}`;
      }
    }
    this.waits = [];
    this.res.state = state;
    this.res.reached = at;
    this.res.observations.sort((a, b) => a.index - b.index);
    this.res.events = this.sim
      .events()
      .filter((e) => (e.kind === 'state' || e.kind === 'drop' || (e.kind === 'link' && this.exp.start === 'cold')) && e.t >= this.exp.settle)
      .slice(-400)
      .map((e) => ({ t: e.t - this.exp.settle, device: e.device, text: e.detail }));
    const c: { [k: string]: number } = {};
    for (const r of this.res.observations) c[r.outcome] = (c[r.outcome] || 0) + 1;
    const n = this.res.observations.length;
    const refused = this.res.actions.filter((a) => a.state === 'refused' || a.state === 'timed out').length;
    this.res.summary = `${n} observation${n === 1 ? '' : 's'}: ${(['satisfied', 'violated', 'indeterminate', 'unsupported'] as ObsOutcome[]).filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(', ') || 'none'}${refused ? `; ${refused} action${refused === 1 ? '' : 's'} not submitted` : ''}${state === 'stopped' ? ' (stopped)' : ''}`;
  }

  // ------------------------------------------------------------ actions

  /** Is a device still coming up (booting, or off waiting for its host)? */
  private comingUp(dev: string): boolean {
    const p = this.sim.engine.powerState(dev);
    if (!p) return false;
    if (p.state === 'booting') return true;
    return p.state === 'off' && !!p.why && /waits for its host|down with its host|container engine/.test(p.why) && this.sim.engine.off.has(dev) && this.hostComing(dev);
  }

  private hostComing(dev: string): boolean {
    const h = this.sim.engine.hostNow(dev);
    if (h === undefined) return false;
    const p = this.sim.engine.powerState(h);
    return !!p && (p.state === 'booting' || p.state === 'on');
  }

  /** Submit one action (see the module comment), or let it wait for its device; and log what became of it. */
  private apply(a: ExpAction, index: number, due: number): void {
    const dev = a.target.split(/[:/]/)[0];
    if (NEEDS_DEVICE.has(a.do) && this.model.index.devices.has(dev) && this.comingUp(dev)) {
      // its device is still coming up: it waits (said), and goes when the device is operational
      this.res.actions.push({ action: a, index, at: this.now(), due, state: 'waiting', text: `waiting for ${dev} to come up` });
      const w = { a, index, due, dev };
      this.waits.push(w);
      const retry = (): void => {
        if (this.waits.indexOf(w) < 0) return;
        if (this.comingUp(dev)) {
          this.at(this.now() + WAIT_POLL, retry);
          return;
        }
        this.waits.splice(this.waits.indexOf(w), 1);
        const entry = this.res.actions.find((x) => x.index === index && x.state === 'waiting');
        if (entry) this.res.actions.splice(this.res.actions.indexOf(entry), 1);
        this.submit(a, index, due);
      };
      this.at(this.now() + WAIT_POLL, retry);
      return;
    }
    this.submit(a, index, due);
  }

  private submit(a: ExpAction, index: number, due: number): void {
    const s = this.sim;
    const waited = this.now() - due;
    const log = (ok: boolean, text: string): void => {
      this.res.actions.push({ action: a, index, at: this.now(), due, state: ok ? 'submitted' : 'refused', text: text + (waited > 0 ? ` (after waiting ${durText(waited)} for ${a.target.split(/[:/]/)[0]} to come up)` : '') });
      if (ok && a.for) {
        const until = this.now() + a.for;
        this.at(until, () => this.undo(a, index, due));
      }
    };
    const [dev, iface] = split(a.target);
    // the device the target is on (device, device:interface, device/application), for the scope's check
    const on = a.target.split(/[:/]/)[0];
    if (!this.model.index.devices.has(on) && a.do !== 'fail' && a.do !== 'restore' && !/^[0-9a-f:.]+$/i.test(a.target)) {
      log(false, `${on} is outside the experiment's scope (not run)`);
      return;
    }
    switch (a.do) {
      case 'send': {
        const c = checkCommunication(this.model, { from: a.target, to: a.to, service: a.service });
        const id = c.error ? null : commIdentity(this.model, c);
        const h = id ? handoffOf(this.model, id) : null;
        if (!h || !h.prefill) {
          log(false, `can't prepare the send: ${c.error || 'the ends resolve to nothing the simulation can send'}`);
          return;
        }
        const plan = { delivery: 'unicast' as const, ...h.prefill, count: a.count, interval: a.interval !== undefined ? a.interval / 1000 : undefined };
        if ((plan.count || 1) > 1 && plan.interval === undefined) plan.interval = 1;
        const r = s.sendPlan(plan);
        if (typeof r === 'string') log(false, r);
        else {
          if (a.id) this.sends.set(a.id, r);
          this.sends.set('#' + index, r);
          log(true, h.text.replace(/ in the simulation .*$/, ''));
        }
        return;
      }
      case 'fail':
      case 'restore': {
        const refs = failRefs(this.model, a.target);
        if (!refs.length) {
          log(false, `${a.target} is no device, cable, relation or failure domain of the experiment's scope`);
          return;
        }
        const done: string[] = [];
        for (const r of refs) {
          const id = r.slice(r.indexOf(':') + 1);
          const ok = r.indexOf('device:') === 0 ? (a.do === 'fail' ? s.powerOff(id) : s.powerOn(id)) : a.do === 'fail' ? s.fail(r) : s.restore(r);
          if (ok) done.push(id);
        }
        log(done.length > 0, done.length ? `${a.do === 'fail' ? 'failed' : 'restored'}: ${done.join(', ')}` : `nothing to ${a.do === 'fail' ? 'fail' : 'restore'} (already so)`);
        return;
      }
      case 'shut':
        log(s.shut(dev, iface), s.engine.isShut(dev, iface) ? `shut ${a.target}` : `${a.target} can't be shut`);
        return;
      case 'no_shut':
        log(s.noShut(dev, iface), `brought ${a.target} up`);
        return;
      case 'power_off':
        log(s.powerOff(a.target), `powered off ${a.target}`);
        return;
      case 'power_on':
        log(s.powerOn(a.target), `powered on ${a.target}`);
        return;
      case 'flap':
        log(s.startFlap(`iface:${dev}:${iface}`), `started flapping ${a.target}`);
        return;
      case 'stop_flap':
        log(s.stopFlap(`iface:${dev}:${iface}`), `stopped flapping ${a.target}`);
        return;
      case 'join': {
        const r = s.joinTagged(dev, iface, a.group || '');
        if ('traffic' in r) this.ops.add(r.traffic);
        log(!('error' in r), 'error' in r ? r.error : `${a.target} joins ${a.group}`);
        return;
      }
      case 'leave': {
        // (its leave carries an id of its own: the experiment's traffic)
        const rec = s.actLeave(dev, iface, a.group || '');
        if (rec.traffic !== undefined) this.ops.add(rec.traffic);
        log(!rec.error, rec.error || `${a.target} leaves ${a.group}`);
        return;
      }
      case 'start_stream': {
        const r = s.startExperimentStream(dev, iface, a.group || '', a.port || 5000, a.interval || 1000, a.size || 1000);
        if ('traffic' in r) this.ops.add(r.traffic);
        log(!('error' in r), 'error' in r ? r.error : `${a.target} streams to ${a.group}:${a.port || 5000}, every ${durText(a.interval || 1000)}`);
        return;
      }
      case 'stop_stream':
        log(s.stopStream(dev, iface, a.group || ''), `${a.target} stops its stream to ${a.group}`);
        return;
      case 'start_app': {
        const sl = a.target.indexOf('/');
        const why = sl > 0 ? s.appProblem(a.target.slice(0, sl), a.target.slice(sl + 1)) : `${a.target} names no application (device/application)`;
        if (why) {
          log(false, why);
          return;
        }
        // on scenario time (a Network event's application repeats on real time, which a run never waits for)
        const rec = s.actApp(a.target.slice(0, sl), a.target.slice(sl + 1), 'experiment');
        this.apps.set(a.id || a.target, rec);
        this.apps.set('#' + index, rec);
        log(!rec.error, rec.error || `started ${a.target}`);
        return;
      }
      case 'stop_app': {
        const rec = this.apps.get(a.target) || Array.from(this.apps.values()).find((x) => x.target.indexOf(a.target) === 0);
        log(!!rec && s.actionControl(rec.id, 'stop'), rec ? `stopped ${a.target}` : `${a.target} was not started by this experiment`);
        return;
      }
    }
  }

  /** An action's For ran out: undone (restored, brought up, powered on, stopped). */
  private undo(a: ExpAction, index: number, due: number): void {
    const s = this.sim;
    const [dev, iface] = split(a.target);
    let ok = false;
    let text = '';
    switch (a.do) {
      case 'fail': {
        const done: string[] = [];
        for (const r of failRefs(this.model, a.target)) {
          const id = r.slice(r.indexOf(':') + 1);
          if (r.indexOf('device:') === 0 ? s.powerOn(id) : s.restore(r)) done.push(id);
        }
        ok = done.length > 0;
        text = ok ? `restored after ${durText(a.for as number)}: ${done.join(', ')}` : 'nothing to restore (already up)';
        break;
      }
      case 'shut':
        ok = s.noShut(dev, iface);
        text = `brought ${a.target} up after ${durText(a.for as number)}`;
        break;
      case 'power_off':
        ok = s.powerOn(a.target);
        text = `powered ${a.target} on again after ${durText(a.for as number)}`;
        break;
      case 'flap':
        ok = s.stopFlap(`iface:${dev}:${iface}`);
        text = `stopped flapping ${a.target} after ${durText(a.for as number)}`;
        break;
      case 'start_stream':
        ok = s.stopStream(dev, iface, a.group || '');
        text = `stopped the stream after ${durText(a.for as number)}`;
        break;
      case 'start_app': {
        const rec = this.apps.get('#' + index);
        ok = !!rec && s.actionControl(rec.id, 'stop');
        text = `stopped ${a.target} after ${durText(a.for as number)}`;
        break;
      }
      default:
        return;
    }
    this.res.actions.push({ action: a, index, at: this.now(), due, state: ok ? 'undone' : 'refused', text: ok ? text : `${text}: it could not (${a.target} is no longer so)` });
  }

  /** Read one observation now (see the module comment): its outcome, what was found, and the evidence's own time when it has one. */
  private observe(p: Pending): { outcome: ObsOutcome; actual: string; at?: number } {
    const o = p.o;
    const s = this.sim;
    const t = this.now();
    const out = (outcome: ObsOutcome, actual: string, at?: number): { outcome: ObsOutcome; actual: string; at?: number } => ({ outcome, actual, at });
    const verdict = (actual: string, detail: string, at?: number): { outcome: ObsOutcome; actual: string; at?: number } => out(actual === o.expect ? 'satisfied' : 'violated', detail, at);
    const [dev, iface] = split(o.target);
    const outside = (d: string): boolean => !this.model.index.devices.has(d);
    const settle = this.exp.settle;
    switch (o.of) {
      case 'send':
      case 'app': {
        // an MQTT client keeps its own counts: its publication rounds against those due, and what a closed connection lost
        const run = o.of === 'app' ? (this.apps.get(o.target) || { app: undefined }).app : undefined;
        const mq = run ? (run as { mqtt?: { published: number; rounds: number; lost: number; inflight: Map<number, unknown>; state: string } }).mqtt : undefined;
        if (run && mq && run.app.publish.length) {
          const due = run.interval ? Math.floor((s.now - run.t0) / run.interval) + 1 : 1;
          const want = run.count !== null ? Math.min(run.count, due) : due;
          if (!mq.rounds) return out('indeterminate', `nothing published yet (its connection: ${mq.state})`);
          const missed = Math.max(0, want - mq.rounds);
          const ok = !missed && !mq.lost;
          const qos = run.app.qos ? `, ${mq.inflight.size} not acknowledged yet` : ' (QoS 0: the broker acknowledges nothing)';
          return verdict(ok ? 'delivered' : 'failed', `${ok ? 'delivered' : 'failed'}: ${mq.rounds} of ${want} publication rounds sent${missed ? ` (${missed} not: no connection to the broker then)` : ''}, ${mq.lost} lost with a closed connection${qos}`);
        }
        const tests = o.of === 'send' ? (this.sends.get(o.target) || { tests: [] }).tests : (run || { tests: [] }).tests;
        if (!tests.length) return out('indeterminate', `nothing was sent by “${o.target}”${o.of === 'send' && !this.sends.has(o.target) ? ' (its action was not submitted)' : ''}`);
        const done = tests.filter((x) => x.done);
        if (!done.length) return out('indeterminate', 'still on its way');
        const ok = done.filter((x) => x.ok).length;
        const delivered = ok === done.length;
        const actual = delivered ? 'delivered' : 'failed';
        return verdict(actual, `${actual}: ${ok} of ${done.length} message${done.length === 1 ? '' : 's'}${tests.length > done.length ? ` (${tests.length - done.length} still on their way)` : ''}${delivered ? '' : ' — ' + (done.find((x) => !x.ok) as { result: string }).result}`);
      }
      case 'receive': {
        if (outside(dev)) return out('indeterminate', `${dev} is outside the experiment's scope`);
        const r = s.multicastReceived(dev, o.group || '');
        const n = (r ? r.count : 0) - (p.base || 0);
        const need = o.min || 1;
        const win = o.within ? ` within ${durText(o.within)}` : ' since the start';
        const first = r && !p.base && n > 0 ? ` (the first at t = ${secs(r.first - settle)})` : '';
        return verdict(n >= need ? 'received' : 'not received', n > 0 ? `${n >= need ? 'received' : 'not received'}: ${n} datagram${n === 1 ? '' : 's'} of ${o.group} at ${o.target}${win}${first}${need > 1 ? ` (at least ${need} expected)` : ''}` : `not received: no datagram of ${o.group} arrived at ${o.target}${win}`);
      }
      case 'mqtt': {
        const sl = o.target.indexOf('/');
        if (sl < 0 || outside(o.target.slice(0, sl))) return out('indeterminate', `${o.target} is outside the experiment's scope`);
        const r = s.mqttReceived(o.target.slice(0, sl), o.target.slice(sl + 1), o.topic);
        if (!r) return out('indeterminate', `${o.target} runs no MQTT client in this run (start it, or it starts with the simulation)`);
        const n = r.count - (p.base || 0);
        const need = o.min || 1;
        return verdict(n >= need ? 'delivered' : 'not delivered', `${n >= need ? 'delivered' : 'not delivered'}: ${n} publication${n === 1 ? '' : 's'}${o.topic ? ` on ${o.topic}` : ''} received by ${o.target}${o.within ? ` within ${durText(o.within)}` : ' since the start'} (its connection: ${r.state})`);
      }
      case 'device': {
        if (outside(o.target)) return out('indeterminate', `${o.target} is outside the experiment's scope`);
        const ps = s.engine.powerState(o.target);
        if (!ps) return out('unsupported', `${o.target} has no power lifecycle of its own (a passive or external object)`);
        if (ps.state === 'booting') p.bootEnd = (ps.until as number) - settle;
        const actual = ps.state === 'off' ? 'off' : ps.state === 'booting' ? 'booting' : 'operational';
        const match = o.expect === 'on' ? (actual !== 'off' ? 'on' : 'off') : actual;
        const at = actual === 'operational' && p.bootEnd !== undefined && p.bootEnd <= t ? p.bootEnd : undefined;
        return verdict(match, `${o.target} ${actual === 'operational' ? 'is operational' : actual === 'booting' ? `is booting (up at t = ${secs((ps.until as number) - settle)})` : `is off${ps.why ? ` (${ps.why})` : ''}`}`, at);
      }
      case 'interface': {
        if (!this.model.index.interfaces.has(ifaceKey(dev, iface))) return out('indeterminate', `${o.target} is not in the experiment's scope`);
        const up = s.engine.portUp(dev, iface) && !s.downRefs().some((r) => r === `iface:${dev}:${iface}`);
        return verdict(up ? 'up' : 'down', `${o.target} is ${up ? 'up' : 'down'}`);
      }
      case 'link': {
        if (!this.model.index.links.has(o.target)) return out('indeterminate', `${o.target} is not in the experiment's scope`);
        const up = s.engine.cableUp(o.target) && s.engine.linkUp(o.target);
        return verdict(up ? 'up' : 'down', `${o.target} is ${up ? 'up' : 'down'}`);
      }
      case 'address': {
        if (!this.model.index.interfaces.has(ifaceKey(dev, iface))) return out('indeterminate', `${o.target} is not in the experiment's scope`);
        const a = s.acquiredAddress(dev, iface, o.family);
        const at = a && a.since !== undefined ? a.since - settle : undefined;
        return verdict(a ? 'acquired' : 'none', a ? `${a.how} address acquired · ${o.target} · ${a.text}` : `no ${o.family === 'ipv4' ? 'DHCPv4 ' : o.family === 'ipv6' ? 'SLAAC or DHCPv6 ' : ''}address acquired at ${o.target}`, at !== undefined && at >= p.from ? at : undefined);
      }
      case 'neighbor': {
        if (outside(o.target)) return out('indeterminate', `${o.target} is outside the experiment's scope`);
        const ips = this.addressesOf(o.to || '');
        if (!ips.length) return out('indeterminate', `“${o.to}” has no address to resolve (in the model or the simulation)`);
        for (const ip of ips) {
          const r = s.neighborEntry(o.target, ip);
          if (r) return verdict('resolved', `neighbor resolved · ${o.target} · ${ip} is at ${r.mac} (${r.iface}${r.state ? ', ' + r.state : ''})`);
        }
        return verdict('unresolved', `${o.target} has no complete entry for ${ips.join(' or ')}`);
      }
      case 'route': {
        if (outside(o.target)) return out('indeterminate', `${o.target} is outside the experiment's scope`);
        const ips = this.addressesOf(o.to || '');
        if (!ips.length) return out('indeterminate', `“${o.to}” has no address to look up`);
        const r = s.routeLookup(o.target, ips[0]);
        if (!r) return out('indeterminate', `“${ips[0]}” is no address`);
        const ok = r.kind === 'forward' || r.kind === 'local';
        return verdict(ok ? 'present' : 'absent', `${ok ? 'route available' : 'no usable route'} · ${o.target} → ${ips[0]}: ${r.text}`);
      }
      case 'session': {
        if (outside(o.target)) return out('indeterminate', `${o.target} is outside the experiment's scope`);
        const list = s.sessions(o.target, o.protocol || '', o.to);
        if (!list.length) return out('indeterminate', `${o.target} has no ${(o.protocol || '').toUpperCase()} session${o.to ? ` with ${o.to}` : ''} the simulation runs`);
        const up = list.find((x) => x.up);
        const x = up || list[0];
        return verdict(up ? 'established' : 'down', `${(o.protocol || '').toUpperCase()} ${up ? 'session established' : 'session not established'} · ${x.device}${x.peer ? ' ↔ ' + x.peer : ''} · ${x.state}`);
      }
      case 'timing': {
        if (outside(o.target)) return out('indeterminate', `${o.target} is outside the experiment's scope`);
        const st = s.timingState(o.target, o.protocol);
        if (!st) return out('indeterminate', `${o.target} runs no ${o.protocol ? o.protocol.toUpperCase() : 'PTP or NTP'} clock in the simulation`);
        return verdict(st.synchronized ? 'synchronized' : 'unsynchronized', `${o.target}: ${st.text} (a protocol state: no accuracy is computed or promised)`);
      }
      case 'member': {
        if (outside(o.target)) return out('indeterminate', `${o.target} is outside the experiment's scope`);
        const tab = s.memberTable(o.target);
        const present = tab.rows.some((r) => r.some((x) => x === o.group || x.indexOf(o.group as string) === 0));
        return verdict(present ? 'present' : 'absent', `${o.group} ${present ? 'recorded' : 'not recorded'} at ${o.target}`);
      }
      case 'reach': {
        const c = checkCommunication(this.model, { from: o.target, to: o.to, service: o.service }, s.snapshot());
        if (c.error) return out('indeterminate', c.error);
        const evaluated = c.layers.filter((l) => l.id !== 'runtime' && l.id !== 'listener');
        const v = evaluated.some((l) => l.verdict === 'violated') ? 'unavailable' : evaluated.every((l) => l.verdict === 'satisfied') ? 'available' : null;
        if (v === null) return out('indeterminate', `not determinable: ${c.headline} (the state at t = ${secs(t)})`);
        return verdict(v, `${v}: ${c.headline} (the state at t = ${secs(t)})`);
      }
      case 'expectations': {
        // the saved expectations named, on the run's state now: what each finds, and what could not be evaluated
        const ids = o.target === '*' ? null : new Set(o.target.split(/[\s,]+/).filter((x) => x));
        const run = evaluateExpectations({ ...this.model, expectations: this.model.expectations.filter((x) => !ids || ids.has(x.id)) }, s.snapshot());
        const res = run.results;
        if (!res.length) return out('indeterminate', 'no saved expectation to evaluate');
        const by = (v: string): string[] => res.filter((x) => x.verdict === v).map((x) => x.id);
        const bad = by('violated');
        const open = res.filter((x) => x.verdict !== 'satisfied' && x.verdict !== 'violated').map((x) => `${x.id} (${x.verdict})`);
        const cover = `${res.length - open.length} of ${res.length} evaluated${open.length ? `; not decided: ${open.join(', ')}` : ''}`;
        if (bad.length) return verdict('violated', `violated: ${bad.join(', ')} — ${cover}`);
        if (open.length) return out('indeterminate', `none violated, but ${cover}`);
        return verdict('satisfied', `satisfied: all ${res.length} (${res.map((x) => x.id).join(', ')})`);
      }
    }
    return out('unsupported', `${(observeDef(o.of) || { label: o.of }).label} is not observed`);
  }

  /** The addresses a destination stands for: an address, a device's or interface's (configured, or acquired in the run). */
  private addressesOf(to: string): string[] {
    if (/^[0-9a-f:.]+$/i.test(to) && /[.:]/.test(to)) return [to];
    const [dev, iface] = split(to.split('/')[0]);
    const d = this.model.index.devices.get(dev);
    if (!d) return [];
    const out: string[] = [];
    for (const i of d.interfaces || []) {
      if (iface && i.id !== iface) continue;
      for (const a of i.addresses) out.push(a.split('/')[0]);
      const got = this.sim.acquiredAddress(dev, i.id);
      if (got) out.push(got.text.split('/')[0]);
    }
    return out;
  }
}

/** Two runs of one experiment side by side: what changed in the observations, where the event sequences part, what was incomplete. */
export interface RunCompare {
  observations: Array<{ obs: ExpObservation; before: ObsResult | undefined; after: ObsResult | undefined; changed: boolean }>;
  /** the first event that differs (index in both sequences), none: the same */
  diverge?: { index: number; before?: string; after?: string };
  /** the model changed between them */
  modelChanged: boolean;
  /** observations either run could not decide */
  incomplete: string[];
  lines: string[];
}

export function compareRuns(before: ExpRunResult, after: ExpRunResult): RunCompare {
  const key = (x: ObsResult): string => (x.obs.id ? 'id:' + x.obs.id : `${x.index}|${x.obs.of}|${x.obs.target}`);
  const obs = after.observations.map((a) => {
    const b = before.observations.find((x) => key(x) === key(a));
    return { obs: a.obs, before: b, after: a, changed: !b || b.outcome !== a.outcome };
  });
  const ev = (x: { t: number; device: string; text: string }): string => `t = ${(x.t / 1000).toFixed(1)} s ${x.device}: ${x.text}`;
  let diverge: RunCompare['diverge'];
  const n = Math.max(before.events.length, after.events.length);
  for (let k = 0; k < n; k++) {
    const a = before.events[k];
    const b = after.events[k];
    if (!a || !b || a.t !== b.t || a.text !== b.text) {
      diverge = { index: k, before: a ? ev(a) : undefined, after: b ? ev(b) : undefined };
      break;
    }
  }
  const incomplete = after.observations.concat(before.observations).filter((x) => x.outcome === 'indeterminate' || x.outcome === 'unsupported').map((x) => `${x.obs.of} ${x.obs.target}: ${x.actual}`);
  const lines: string[] = [];
  lines.push(`Both runs on scenario time (the simulated clock), from the experiment's defined start${before.fingerprint === after.fingerprint ? ', on the same model' : ', on different versions of the model'}.`);
  for (const o of obs.filter((x) => x.changed)) lines.push(`${o.obs.id || o.obs.of + ' ' + o.obs.target}: ${o.before ? o.before.outcome : 'not read'} → ${o.after ? o.after.outcome : 'not read'} (${o.after ? o.after.actual : ''})`);
  if (!obs.some((x) => x.changed)) lines.push('Every observation came out as before.');
  lines.push(diverge ? `The event sequences part at event ${diverge.index + 1}: before “${diverge.before || 'nothing'}”, now “${diverge.after || 'nothing'}”.` : 'The event sequences are the same.');
  return { observations: obs, diverge, modelChanged: before.fingerprint !== after.fingerprint, incomplete: Array.from(new Set(incomplete)), lines };
}
