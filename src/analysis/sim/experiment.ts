/**
 * Running a saved experiment (model/experiments.ts) on the shared
 * simulation engine: always from a clean start (a new simulation of the
 * model, or of its execution scope's sub-model, with the experiment's
 * parameters), on scenario time (the simulated clock: a run is
 * repeatable), with the simulation's own operations — Send network packets,
 * fail and restore, shut, power, flapping, joins and leaves, multicast
 * streams, applications — nothing of its own.
 *
 * A run first lets the network settle for `settle` (when set; its events are
 * not the experiment's), then applies each action at its time: `at` after
 * the start, or after an earlier action was submitted (`after`). Actions at
 * one time are all applied before the clock moves on (they run
 * concurrently), in the order written. An action is *submitted* or
 * *refused* (with the simulation's reason); whether it had its effect is
 * what observations find. An observation is read at its time: a state
 * (device, interface, cable, membership, a communication, the saved
 * expectations) is satisfied as soon as it holds within its window
 * (`within`; none: read at once); traffic (a send's or an application's
 * deliveries, a receiver's datagrams) is counted until the window ends.
 * Verdicts: satisfied, violated, indeterminate (not decidable: nothing sent
 * yet, still on its way, not reached), unsupported. Finishing the sequence
 * proves nothing: only observations do.
 *
 * The runner advances in slices (step) so a page stays responsive and can
 * Stop it; a stopped run keeps what it observed and says what was not
 * reached. Each runner is used once: running again makes a new one (a clean
 * start), and a stale runner's results are never mixed into a new one (its
 * generation). None measures convergence time, throughput or
 * synchronization accuracy.
 */
import { ExpAction, ExpObservation, Experiment, durText, observeDef, scopeText, stepTimes } from '../../model/experiments';
import { Model, ifaceKey } from '../../model/types';
import { commIdentity, handoffOf } from '../comm-identity';
import { checkCommunication } from '../communication';
import { ExecScope, dependencyScope, domainScope, entireScope, groupScope, scopedModel, vlanScope } from '../exec-scope';
import { evaluateExpectations } from '../expectations';
import { failureCondition } from '../failure';
import { ActionRecord } from './actions';
import { Simulation, TestRun } from './simulation';

export type ObsOutcome = 'satisfied' | 'violated' | 'indeterminate' | 'unsupported';

export const OUTCOME_TEXT: { [k in ObsOutcome]: string } = { satisfied: 'Satisfied', violated: 'Violated', indeterminate: 'Indeterminate', unsupported: 'Unsupported' };

export interface ObsResult {
  obs: ExpObservation;
  /** its index in the experiment */
  index: number;
  /** when it was decided (ms after the start) */
  at: number;
  /** its window (ms after the start) */
  from: number;
  to: number;
  outcome: ObsOutcome;
  /** what was found: "delivered (3 of 3 messages)", "off", "unavailable: no route at r1" */
  actual: string;
}

export interface StepLog {
  action: ExpAction;
  index: number;
  /** when it was submitted (ms after the start) */
  at: number;
  /** submitted: the simulation took it (its effect is what observations find); refused: it could not */
  state: 'submitted' | 'refused';
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

/** The refs a fail or restore target stands for: a device, a cable, a relation, a failure domain's members. */
function failRefs(model: Model, target: string): string[] {
  if (model.index.devices.has(target)) return ['device:' + target];
  if (model.index.links.has(target)) return ['link:' + target];
  if (model.index.relations.has(target)) return ['relation:' + target];
  if (model.failureDomains.some((d) => d.id === target)) return failureCondition(model, [target]).refs;
  return [];
}

/** The execution scope of an experiment in a model. */
export function experimentScope(model: Model, e: Experiment): ExecScope {
  const s = e.scope;
  if (s.kind === 'group') return groupScope(model, s.value);
  if (s.kind === 'vlan') return vlanScope(model, Number(s.value));
  if (s.kind === 'domain') return domainScope(model, s.value);
  if (s.kind === 'device') return dependencyScope(model, s.value);
  return entireScope(model);
}

const split = (t: string): [string, string] => (t.indexOf(':') > 0 ? [t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1)] : [t, '']);

interface Pending {
  o: ExpObservation;
  index: number;
  from: number;
  to: number;
  /** a reception's count when its window opened */
  base?: number;
  /** the last reading of a state (said when the window ends without it holding) */
  last?: { outcome: ObsOutcome; actual: string };
}

export class ExperimentRunner {
  readonly gen = ++generation;
  private sim: Simulation;
  private model: Model;
  private sends = new Map<string, TestRun>();
  private apps = new Map<string, ActionRecord>();
  private res: ExpRunResult;
  private cancelled = false;
  private settled = false;
  /** the actions by time (after the start), in the order written at one time */
  private queue: Array<{ a: ExpAction; index: number; t: number }> = [];
  private opens: Pending[] = [];
  private open: Pending[] = [];

  constructor(
    model: Model,
    private exp: Experiment,
    fingerprint: string,
    opts: { realClock?: () => number } = {},
  ) {
    const scope = exp.scope.kind === 'entire' ? null : experimentScope(model, exp);
    this.model = scope && !scope.cannot.length ? scopedModel(model, scope) : model;
    const params: { [k: string]: number | string } = {};
    for (const p of exp.params) params[p.key] = p.value;
    this.sim = new Simulation(this.model, { params, realClock: opts.realClock });
    const n = model.devices.length;
    const scopeLine = !scope ? `Entire model (${n} device${n === 1 ? '' : 's'})` : `${scopeText(exp.scope)}: ${scope.devices.size} of ${n} devices run`;
    this.res = { experiment: exp.id, name: exp.name, fingerprint, timing: 'scenario', duration: exp.duration, settle: exp.settle, scope: scopeLine, reached: -exp.settle, state: 'running', params: exp.params.slice(), actions: [], observations: [], events: [], summary: '' };
    // an experiment that isn't fully configured, or whose scope can't run, is not run
    const why = exp.problems.slice();
    if (scope && scope.cannot.length) why.push(...scope.cannot);
    const times = stepTimes(exp);
    if (!why.length) {
      exp.actions.forEach((a, index) => this.queue.push({ a, index, t: times.actions[index] as number }));
      this.queue.sort((x, y) => x.t - y.t || x.index - y.index);
      exp.observations.forEach((o, index) => {
        const from = times.observations[index] as number;
        this.opens.push({ o, index, from, to: from + (o.within || 0) });
      });
      this.opens.sort((x, y) => x.from - y.from || x.index - y.index);
    } else {
      this.res.state = 'refused';
      this.res.summary = `Not run: ${why.join('; ')}`;
    }
  }

  /** The simulation it runs (its tables and log, for inspection after the run). */
  get simulation(): Simulation {
    return this.sim;
  }

  /** Scenario time after the start (negative while settling). */
  private now(): number {
    return this.sim.now - this.exp.settle;
  }

  /** Stop: the run ends where it is; what was not reached is said. */
  cancel(): void {
    if (this.res.state !== 'running') return;
    this.cancelled = true;
    this.finish('stopped');
  }

  /**
   * Advance for at most `budget` ms of the page's time (`clock`); true when
   * the run is over (done, stopped or refused).
   */
  step(budget = 40, clock: () => number = () => Date.now()): boolean {
    if (this.res.state !== 'running') return true;
    const t0 = clock();
    const s = this.sim;
    // the network settles first (its events are not the experiment's)
    while (!this.settled) {
      if (s.now >= this.exp.settle) {
        this.settled = true;
        break;
      }
      s.runTo(Math.min(this.exp.settle, s.now + 1000));
      this.res.reached = this.now();
      if (this.cancelled) return true;
      if (clock() - t0 > budget) return false;
    }
    for (;;) {
      const t = this.now();
      // what is due now: the actions (in order), then the observations whose window opens, then those to read
      while (this.queue.length && this.queue[0].t <= t) {
        const q = this.queue.shift() as { a: ExpAction; index: number; t: number };
        this.apply(q.a, q.index);
      }
      while (this.opens.length && this.opens[0].from <= t) {
        const p = this.opens.shift() as Pending;
        if (p.o.of === 'receive') {
          const r = s.multicastReceived(split(p.o.target)[0], p.o.group || '');
          p.base = p.o.within ? (r ? r.count : 0) : 0;
        }
        this.open.push(p);
      }
      this.poll(t);
      if (t >= this.exp.duration) break;
      // the next moment that matters: an action, a window opening or closing, a second for the windows that poll, the end
      let next = this.exp.duration;
      if (this.queue.length) next = Math.min(next, this.queue[0].t);
      if (this.opens.length) next = Math.min(next, this.opens[0].from);
      for (const p of this.open) {
        const d = observeDef(p.o.of);
        next = Math.min(next, p.to, d && d.window === 'state' ? t + 1000 : p.to);
      }
      // (a long gap moves in slices of a second, so that it can be stopped)
      next = Math.min(this.exp.duration, Math.max(t + 1, Math.min(next, t + 1000)));
      s.runTo(this.exp.settle + next);
      this.res.reached = this.now();
      if (this.cancelled) return true;
      if (clock() - t0 > budget) return false;
    }
    this.finish('done');
    return true;
  }

  /** Run to the end at once (tests, small models). */
  runAll(): ExpRunResult {
    while (!this.step(1e9)) {
      /* (step runs until done with an unlimited budget) */
    }
    return this.result();
  }

  result(): ExpRunResult {
    return this.res;
  }

  /** The open windows now: a state that holds is decided; a window that ends is decided with what it found. */
  private poll(t: number): void {
    const keep: Pending[] = [];
    for (const p of this.open) {
      const def = observeDef(p.o.of);
      const state = !def || def.window === 'state';
      if (state) {
        const r = this.observe(p, t);
        p.last = r;
        if (r.outcome === 'satisfied' || t >= p.to) {
          this.res.observations.push({ obs: p.o, index: p.index, at: t, from: p.from, to: p.to, outcome: r.outcome, actual: r.actual + (p.o.within && r.outcome !== 'satisfied' ? ` (throughout ${durText(p.o.within)})` : '') });
          continue;
        }
      } else if (t >= p.to) {
        const r = this.observe(p, t);
        this.res.observations.push({ obs: p.o, index: p.index, at: t, from: p.from, to: p.to, outcome: r.outcome, actual: r.actual });
        continue;
      }
      keep.push(p);
    }
    this.open = keep;
  }

  private finish(state: 'done' | 'stopped'): void {
    this.res.state = state;
    this.res.reached = this.now();
    // what was not reached when it stopped
    if (state === 'stopped') {
      const at = this.now();
      for (const p of this.open.concat(this.opens)) this.res.observations.push({ obs: p.o, index: p.index, at, from: p.from, to: p.to, outcome: 'indeterminate', actual: `not decided: the run was stopped at t = ${(at / 1000).toFixed(1)} s` });
      this.open = [];
      this.opens = [];
    }
    this.res.observations.sort((a, b) => a.index - b.index);
    this.res.events = this.sim
      .events()
      .filter((e) => (e.kind === 'state' || e.kind === 'drop') && e.t >= this.exp.settle)
      .slice(-400)
      .map((e) => ({ t: e.t - this.exp.settle, device: e.device, text: e.detail }));
    const c: { [k: string]: number } = {};
    for (const r of this.res.observations) c[r.outcome] = (c[r.outcome] || 0) + 1;
    const n = this.res.observations.length;
    const refused = this.res.actions.filter((a) => a.state === 'refused').length;
    this.res.summary = `${n} observation${n === 1 ? '' : 's'}: ${(['satisfied', 'violated', 'indeterminate', 'unsupported'] as ObsOutcome[]).filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(', ') || 'none'}${refused ? `; ${refused} action${refused === 1 ? '' : 's'} refused` : ''}${state === 'stopped' ? ' (stopped)' : ''}`;
  }

  /** Submit one action (see the module comment), and log what became of it. */
  private apply(a: ExpAction, index: number): void {
    const s = this.sim;
    const log = (ok: boolean, text: string): void => {
      this.res.actions.push({ action: a, index, at: this.now(), state: ok ? 'submitted' : 'refused', text });
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
        const why = s.joinGroup(dev, iface, a.group || '', []);
        log(!why, why || `${a.target} joins ${a.group}`);
        return;
      }
      case 'leave':
        log(s.leaveGroup(dev, iface, a.group || ''), `${a.target} leaves ${a.group}`);
        return;
      case 'start_stream': {
        const why = s.startExperimentStream(dev, iface, a.group || '', a.port || 5000, a.interval || 1000, a.size || 1000);
        log(!why, why || `${a.target} streams to ${a.group}:${a.port || 5000}, every ${durText(a.interval || 1000)}`);
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
        const rec = s.actApp(a.target.slice(0, sl), a.target.slice(sl + 1), 'start');
        this.apps.set(a.id || a.target, rec);
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

  /** Read one observation now (see the module comment). */
  private observe(p: Pending, t: number): { outcome: ObsOutcome; actual: string } {
    const o = p.o;
    const s = this.sim;
    const out = (outcome: ObsOutcome, actual: string): { outcome: ObsOutcome; actual: string } => ({ outcome, actual });
    const verdict = (actual: string, detail: string): { outcome: ObsOutcome; actual: string } => out(actual === o.expect ? 'satisfied' : 'violated', detail);
    const [dev, iface] = split(o.target);
    const outside = (d: string): boolean => !this.model.index.devices.has(d);
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
        const win = o.within ? ` within ${durText(o.within)}` : ' since the start';
        return verdict(n > 0 ? 'received' : 'not received', n > 0 ? `received: ${n} datagram${n === 1 ? '' : 's'} of ${o.group}${win}` : `not received: no datagram of ${o.group}${win}`);
      }
      case 'device': {
        if (outside(o.target)) return out('indeterminate', `${o.target} is outside the experiment's scope`);
        const st = s.deviceState(o.target);
        if (st.state === 'unknown') return out('indeterminate', `${o.target}: its state is not known`);
        const actual = st.state === 'off' ? 'off' : 'on';
        return verdict(actual, `${actual} (${st.label})`);
      }
      case 'interface': {
        if (!this.model.index.interfaces.has(ifaceKey(dev, iface))) return out('indeterminate', `${o.target} is not in the experiment's scope`);
        const up = s.engine.portUp(dev, iface) && !s.downRefs().some((r) => r === `iface:${dev}:${iface}`);
        return verdict(up ? 'up' : 'down', up ? 'up' : 'down');
      }
      case 'link': {
        if (!this.model.index.links.has(o.target)) return out('indeterminate', `${o.target} is not in the experiment's scope`);
        const up = s.engine.cableUp(o.target) && s.engine.linkUp(o.target);
        return verdict(up ? 'up' : 'down', up ? 'up' : 'down');
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
        if (v === null) return out('indeterminate', `not determinable: ${c.headline} (the state at t = ${(t / 1000).toFixed(1)} s)`);
        return verdict(v, `${v}: ${c.headline} (the state at t = ${(t / 1000).toFixed(1)} s)`);
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
