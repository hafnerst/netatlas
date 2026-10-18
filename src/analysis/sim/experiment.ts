/**
 * Running a saved experiment (model/experiments.ts): always from a clean
 * start (a new simulation of the model with the experiment's parameters),
 * on scenario time (the simulated clock: a run is repeatable), with the
 * simulation's own operations (Send network packets, fail and restore,
 * shut, power, flapping, joins and leaves, applications) — nothing of its
 * own. Actions at the same time are all applied before the clock moves on
 * (they run concurrently), in the order they are written (deterministic);
 * observations at a time are read after that time's actions. A send is
 * prepared from the communication's identity (analysis/comm-identity.ts),
 * as Trace path's handoff does.
 *
 * The runner advances in slices (step) so a page stays responsive and can
 * Stop it; a stopped run keeps what it observed and says what was not
 * reached. Each runner is used once: running again makes a new one (a
 * clean start), and a stale runner's results are never mixed into a new
 * one (its generation). Observations read the simulation's state; none
 * measures convergence time, throughput or synchronization accuracy.
 */
import { EXP_OBSERVE, ExpAction, ExpObservation, Experiment } from '../../model/experiments';
import { Model, ifaceKey } from '../../model/types';
import { commIdentity, handoffOf } from '../comm-identity';
import { checkCommunication } from '../communication';
import { failureCondition } from '../failure';
import { ActionRecord } from './actions';
import { Simulation, TestRun } from './simulation';

export type ObsOutcome = 'met' | 'not-met' | 'indeterminate' | 'unsupported';

export interface ObsResult {
  obs: ExpObservation;
  /** when it was read (ms of scenario time) */
  at: number;
  outcome: ObsOutcome;
  /** what was found: "delivered (3 of 3 messages)", "off", "unavailable: no route at r1" */
  actual: string;
}

export interface StepLog {
  action: ExpAction;
  at: number;
  ok: boolean;
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
  /** how far the scenario time got */
  reached: number;
  state: 'running' | 'done' | 'stopped';
  params: Array<{ key: string; value: number | string }>;
  actions: StepLog[];
  observations: ObsResult[];
  /** the notable events in order (state changes and drops): "t, device: text" */
  events: Array<{ t: number; device: string; text: string }>;
  /** "4 observations: 3 met, 1 not met" */
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

export class ExperimentRunner {
  readonly gen = ++generation;
  private sim: Simulation;
  private points: number[];
  private next = 0;
  private sends = new Map<string, TestRun>();
  private apps = new Map<string, ActionRecord>();
  private res: ExpRunResult;
  private cancelled = false;

  constructor(
    private model: Model,
    private exp: Experiment,
    fingerprint: string,
    opts: { realClock?: () => number } = {},
  ) {
    const params: { [k: string]: number | string } = {};
    for (const p of exp.params) params[p.key] = p.value;
    this.sim = new Simulation(model, { params, realClock: opts.realClock });
    const times = new Set<number>([exp.duration]);
    for (const a of exp.actions) times.add(a.at);
    for (const o of exp.observations) times.add(o.at === undefined ? exp.duration : o.at);
    this.points = Array.from(times).sort((a, b) => a - b);
    this.res = { experiment: exp.id, name: exp.name, fingerprint, timing: 'scenario', duration: exp.duration, reached: 0, state: 'running', params: exp.params.slice(), actions: [], observations: [], events: [], summary: '' };
  }

  /** The simulation it runs (its tables and log, for inspection after the run). */
  get simulation(): Simulation {
    return this.sim;
  }

  /** Stop: the run ends where it is; what was not reached is said. */
  cancel(): void {
    if (this.res.state !== 'running') return;
    this.cancelled = true;
    this.finish('stopped');
  }

  /**
   * Advance for at most `budget` ms of the page's time (`clock`); true when
   * the run is over (done or stopped).
   */
  step(budget = 40, clock: () => number = () => Date.now()): boolean {
    if (this.res.state !== 'running') return true;
    const t0 = clock();
    while (this.next < this.points.length) {
      const t = this.points[this.next];
      // (the clock moves in slices of a second of scenario time, so a long gap can be stopped)
      while (this.sim.now < t) {
        this.sim.runTo(Math.min(t, this.sim.now + 1000));
        this.res.reached = this.sim.now;
        if (this.cancelled) return true;
        if (clock() - t0 > budget) return false;
      }
      for (const a of this.exp.actions.filter((x) => x.at === t)) this.apply(a);
      for (const o of this.exp.observations.filter((x) => (x.at === undefined ? this.exp.duration : x.at) === t)) this.res.observations.push(this.observe(o, t));
      this.next++;
      if (clock() - t0 > budget) return this.next >= this.points.length ? (this.finish('done'), true) : false;
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

  private finish(state: 'done' | 'stopped'): void {
    this.res.state = state;
    this.res.reached = this.sim.now;
    // what was not reached when it stopped
    if (state === 'stopped') {
      const read = new Set(this.res.observations.map((x) => x.obs));
      for (const o of this.exp.observations) if (!read.has(o)) this.res.observations.push({ obs: o, at: this.sim.now, outcome: 'indeterminate', actual: `not reached: the run was stopped at t = ${(this.sim.now / 1000).toFixed(1)} s` });
    }
    this.res.events = this.sim
      .events()
      .filter((e) => e.kind === 'state' || e.kind === 'drop')
      .slice(-400)
      .map((e) => ({ t: e.t, device: e.device, text: e.detail }));
    const c: { [k: string]: number } = {};
    for (const r of this.res.observations) c[r.outcome] = (c[r.outcome] || 0) + 1;
    const n = this.res.observations.length;
    this.res.summary = `${n} observation${n === 1 ? '' : 's'}: ${['met', 'not-met', 'indeterminate', 'unsupported'].filter((k) => c[k]).map((k) => `${c[k]} ${k.replace('-', ' ')}`).join(', ') || 'none'}${state === 'stopped' ? ' (stopped)' : ''}`;
  }

  /** Apply one action (see the module comment), and log what it did. */
  private apply(a: ExpAction): void {
    const s = this.sim;
    const log = (ok: boolean, text: string): void => {
      this.res.actions.push({ action: a, at: s.now, ok, text });
    };
    const [dev, iface] = a.target.indexOf(':') > 0 ? [a.target.slice(0, a.target.indexOf(':')), a.target.slice(a.target.indexOf(':') + 1)] : [a.target, ''];
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
          log(false, `${a.target} is no device, cable, relation or failure domain of the model`);
          return;
        }
        const done: string[] = [];
        for (const r of refs) {
          const id = r.slice(r.indexOf(':') + 1);
          const ok = r.indexOf('device:') === 0 ? (a.do === 'fail' ? s.powerOff(id) : s.powerOn(id)) : a.do === 'fail' ? s.fail(r) : s.restore(r);
          if (ok) done.push(id);
        }
        log(done.length > 0, `${a.do === 'fail' ? 'failed' : 'restored'}: ${done.join(', ') || 'nothing (already so)'}`);
        return;
      }
      case 'shut':
        log(s.shut(dev, iface), `shut ${a.target}`);
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
        const rec = this.apps.get(a.target) || Array.from(this.apps.values()).find((x) => x.target === a.target);
        log(!!rec && s.actionControl(rec.id, 'stop'), rec ? `stopped ${a.target}` : `${a.target} was not started by this experiment`);
        return;
      }
    }
  }

  /** Read one observation now (see the module comment). */
  private observe(o: ExpObservation, t: number): ObsResult {
    const s = this.sim;
    const out = (outcome: ObsOutcome, actual: string): ObsResult => ({ obs: o, at: t, outcome, actual });
    const expect = (actual: string, found: boolean | null, detail: string): ObsResult => (found === null ? out('indeterminate', detail) : out(actual === o.expect ? 'met' : 'not-met', detail));
    switch (o.of) {
      case 'send':
      case 'app': {
        // an MQTT client keeps its own counts: its publication rounds against those due, and what a closed connection lost
        const run = o.of === 'app' ? (this.apps.get(o.target) || { app: undefined }).app : undefined;
        const mq = run ? (run as { mqtt?: { published: number; rounds: number; lost: number; inflight: Map<number, unknown>; state: string } }).mqtt : undefined;
        if (run && mq && run.app.publish.length) {
          const due = run.interval ? Math.floor((t - run.t0) / run.interval) + 1 : 1;
          const want = run.count !== null ? Math.min(run.count, due) : due;
          if (!mq.rounds) return out('indeterminate', `nothing published yet (its connection: ${mq.state})`);
          const missed = Math.max(0, want - mq.rounds);
          const ok = !missed && !mq.lost;
          const qos = run.app.qos ? `, ${mq.inflight.size} not acknowledged yet` : ' (QoS 0: the broker acknowledges nothing)';
          return expect(ok ? 'delivered' : 'failed', true, `${ok ? 'delivered' : 'failed'}: ${mq.rounds} of ${want} publication rounds sent${missed ? ` (${missed} not: no connection to the broker then)` : ''}, ${mq.lost} lost with a closed connection${qos}`);
        }
        const tests = o.of === 'send' ? (this.sends.get(o.target) || { tests: [] }).tests : (run || { tests: [] }).tests;
        if (!tests.length) return out('indeterminate', `nothing was sent by “${o.target}”${o.of === 'send' && !this.sends.has(o.target) ? ' (no send action with that id ran)' : ''}`);
        const done = tests.filter((x) => x.done);
        if (!done.length) return out('indeterminate', 'still on its way');
        const ok = done.filter((x) => x.ok).length;
        const delivered = ok === done.length;
        const actual = delivered ? 'delivered' : 'failed';
        return expect(actual, true, `${actual}: ${ok} of ${done.length} message${done.length === 1 ? '' : 's'}${delivered ? '' : ' — ' + (done.find((x) => !x.ok) as { result: string }).result}`);
      }
      case 'device': {
        const st = s.deviceState(o.target);
        if (st.state === 'unknown') return out('indeterminate', `${o.target}: its state is not known`);
        const actual = st.state === 'off' ? 'off' : 'on';
        return expect(actual, true, `${actual} (${st.label})`);
      }
      case 'interface': {
        const c = o.target.indexOf(':');
        const dev = o.target.slice(0, c);
        const ifc = o.target.slice(c + 1);
        if (c < 0 || !this.model.index.interfaces.has(ifaceKey(dev, ifc))) return out('indeterminate', `${o.target} is no interface of the model`);
        const up = s.engine.portUp(dev, ifc) && !s.downRefs().some((r) => r === `iface:${dev}:${ifc}`);
        return expect(up ? 'up' : 'down', true, up ? 'up' : 'down');
      }
      case 'link': {
        if (!this.model.index.links.has(o.target)) return out('indeterminate', `${o.target} is no cable of the model`);
        const up = s.engine.cableUp(o.target) && s.engine.linkUp(o.target);
        return expect(up ? 'up' : 'down', true, up ? 'up' : 'down');
      }
      case 'member': {
        const tab = s.memberTable(o.target);
        const present = tab.rows.some((r) => r.some((x) => x === o.group || x.indexOf(o.group as string) === 0));
        return expect(present ? 'present' : 'absent', true, `${o.group} ${present ? 'recorded' : 'not recorded'} at ${o.target}`);
      }
      case 'reach': {
        const c = checkCommunication(this.model, { from: o.target, to: o.to, service: o.service }, s.snapshot());
        if (c.error) return out('indeterminate', c.error);
        const evaluated = c.layers.filter((l) => l.id !== 'runtime' && l.id !== 'listener');
        const v = evaluated.some((l) => l.verdict === 'violated') ? 'unavailable' : evaluated.every((l) => l.verdict === 'satisfied') ? 'available' : null;
        return expect(v || '', v === null ? null : true, `${v || 'not determinable'}: ${c.headline} (the state at t = ${(t / 1000).toFixed(1)} s)`);
      }
    }
    return out('unsupported', `${(EXP_OBSERVE.find((x) => x.id === o.of) || { label: o.of }).label} is not observed`);
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
  const obs = after.observations.map((a) => {
    const b = before.observations.find((x) => x.obs.line === a.obs.line && x.obs.of === a.obs.of && x.obs.target === a.obs.target);
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
  lines.push(`Both runs on scenario time (the simulated clock), from a clean start${before.fingerprint === after.fingerprint ? ', on the same model' : ', on different versions of the model'}.`);
  for (const o of obs.filter((x) => x.changed)) lines.push(`${o.obs.of} ${o.obs.target}: ${o.before ? o.before.outcome : 'not read'} → ${o.after ? o.after.outcome : 'not read'} (${o.after ? o.after.actual : ''})`);
  if (!obs.some((x) => x.changed)) lines.push('Every observation came out as before.');
  lines.push(diverge ? `The event sequences part at event ${diverge.index + 1}: before “${diverge.before || 'nothing'}”, now “${diverge.after || 'nothing'}”.` : 'The event sequences are the same.');
  return { observations: obs, diverge, modelChanged: before.fingerprint !== after.fingerprint, incomplete: Array.from(new Set(incomplete)), lines };
}
