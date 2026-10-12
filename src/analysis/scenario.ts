/**
 * Scenarios: named, ordered lists of hypothetical steps (fail or restore a
 * device, cable, port, relation or LAG) played as an overlay on the model.
 * The model is never changed: each step only yields the set of failed
 * objects, and analysis/failure.ts propagates it (what goes down or
 * degrades, the routing context the tables and the path tracer see, the
 * device pairs that lose reachability).
 *
 * Step k of a scenario is the state after its first k steps (step 0: the
 * model as written). Each step's result is compared with the previous
 * step's: what went down or degraded, what came back, which device pairs
 * lost or regained reachability.
 *
 * Pure and deterministic: the results depend on the model and the steps
 * only, never on the order objects were selected in or on earlier runs.
 */
import { Interface, Model, Scenario, ScenarioStep, StepTarget, TargetKind, ifaceKey } from '../model/types';
import { FailureResult, FailureSummary, LostPair, failureRefs, lostReachability, refLabel, simulate, summarize } from './failure';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** How a target kind is named in text: "cable", "LAG" … */
export const TARGET_NAME: { [k in TargetKind]: string } = { device: 'device', cable: 'cable', port: 'port', relation: 'relation', lag: 'LAG' };

/** The member cables of an aggregate interface (sorted), or why it is not a LAG. */
function lagCables(model: Model, id: string): string[] | string {
  const i = model.index.interfaces.get(id) as Interface | undefined;
  if (!i) return `there is no interface "${id}"`;
  if (!i.members.length) return `${id} is not a LAG: it has no member ports`;
  const ls = i.members.map((m) => model.index.ifaceLink.get(ifaceKey(i.device, m))).filter((x): x is string => !!x);
  if (!ls.length) return `no member port of ${id} has a cable`;
  return Array.from(new Set(ls)).sort(cmp);
}

/**
 * The objects a target stands for, as refs the failure simulation takes
 * (a LAG: its member cables), or why it can't be resolved.
 */
export function resolveTarget(model: Model, t: StepTarget): { refs: string[] } | { problem: string } {
  const ix = model.index;
  switch (t.kind) {
    case 'device':
      return ix.devices.has(t.id) ? { refs: ['device:' + t.id] } : { problem: `there is no device "${t.id}"` };
    case 'cable':
      return ix.links.has(t.id) ? { refs: ['link:' + t.id] } : { problem: `there is no cable (link) "${t.id}"` };
    case 'relation':
      return ix.relations.has(t.id) ? { refs: ['relation:' + t.id] } : { problem: `there is no relation "${t.id}"` };
    case 'port':
      if (t.id.indexOf(':') < 0) return { problem: `"${t.id}" names no interface: write it as device:interface` };
      return ix.interfaces.has(t.id) ? { refs: ['iface:' + t.id] } : { problem: `there is no interface "${t.id}"` };
    case 'lag': {
      if (t.id.indexOf(':') < 0) return { problem: `"${t.id}" names no interface: write it as device:interface` };
      const c = lagCables(model, t.id);
      return typeof c === 'string' ? { problem: c } : { refs: c.map((l) => 'link:' + l) };
    }
  }
  return { problem: 'unknown target' };
}

/** Why a step can't be played ('' = it can). */
export function stepProblem(model: Model, step: ScenarioStep): string {
  const r = resolveTarget(model, step.target);
  return 'problem' in r ? r.problem : '';
}

/** The ref the diagram selects for a target (a LAG: its interface). */
export function targetRef(t: StepTarget): string {
  switch (t.kind) {
    case 'device':
      return 'device:' + t.id;
    case 'cable':
      return 'link:' + t.id;
    case 'relation':
      return 'relation:' + t.id;
    default:
      return 'iface:' + t.id;
  }
}

/** The target for a selected object (a device, cable, interface or relation), or null for anything else. */
export function targetOfRef(model: Model, ref: string): StepTarget | null {
  const i = ref.indexOf(':');
  const kind = ref.slice(0, i);
  const id = ref.slice(i + 1);
  if (kind === 'device' && model.index.devices.has(id)) return { kind: 'device', id };
  if (kind === 'link' && model.index.links.has(id)) return { kind: 'cable', id };
  if (kind === 'relation' && model.index.relations.has(id)) return { kind: 'relation', id };
  if (kind === 'iface' && model.index.interfaces.has(id)) return { kind: 'port', id };
  return null;
}

/** A target named as the lists name it: "hq-core1", "cable l1", "LAG hq-core1:Port-Channel1". */
export function targetLabel(model: Model, t: StepTarget): string {
  if (t.kind === 'lag') return 'LAG ' + t.id;
  if (t.kind === 'port') return t.id;
  return refLabel(model, targetRef(t));
}

/** A step as one line: "Fail hq-core1", "Restore cable l-peer1". */
export function stepText(model: Model, step: ScenarioStep): string {
  return `${step.action === 'fail' ? 'Fail' : 'Restore'} ${targetLabel(model, step.target)}`;
}

/** The failed objects (refs, sorted) after the first `k` steps; steps that can't be resolved are skipped. */
export function failedAfter(model: Model, steps: ScenarioStep[], k: number): string[] {
  const failed = new Set<string>();
  for (const s of steps.slice(0, Math.max(0, k))) {
    const r = resolveTarget(model, s.target);
    if ('problem' in r) continue;
    for (const ref of r.refs) {
      if (s.action === 'fail') failed.add(ref);
      else failed.delete(ref);
    }
  }
  return Array.from(failed).sort(cmp);
}

/** The result of one step: what failed, what that takes down, and the reachability lost (against the model as written). */
export interface StepView {
  /** 0: the model as written; k: after the first k steps */
  index: number;
  failed: string[];
  res: FailureResult;
  summary: FailureSummary;
  lost: { pairs: LostPair[]; checked: number; total: number };
}

/** per model: the results by set of failed objects (the same set is never computed twice) */
const viewCache = new WeakMap<Model, Map<string, Omit<StepView, 'index'>>>();

/** The state for a set of failed objects. */
export function evaluate(model: Model, failed: string[]): Omit<StepView, 'index'> {
  const key = failed.slice().sort(cmp).join('\n');
  let m = viewCache.get(model);
  if (!m) viewCache.set(model, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const res = simulate(model, failed);
  const v = { failed: res.failed, res, summary: summarize(model, res), lost: lostReachability(model, res) };
  m.set(key, v);
  return v;
}

/** Step k of a list of steps (clamped to 0 … steps.length). */
export function stepView(model: Model, steps: ScenarioStep[], k: number): StepView {
  const i = Math.max(0, Math.min(steps.length, k));
  return { index: i, ...evaluate(model, failedAfter(model, steps, i)) };
}

/** What changed from one step to the next. */
export interface StepDiff {
  /** objects (refs) that are down now and were not */
  down: string[];
  /** objects that are degraded now and were up */
  degraded: string[];
  /** objects that were down or degraded and are up again, or degraded instead of down */
  recovered: string[];
  /** device pairs ("a → b") that lost reachability (in full or in part) */
  lost: LostPair[];
  /** device pairs that reach each other again (or in full again) */
  regained: Array<{ from: string; to: string }>;
}

/** The kinds of objects a diff lists (an interface's state shows in its device's and cable's). */
const DIFF_KINDS = /^(device|link|relation|network|route):/;

/** What changed between two step results (`prev` before `cur`). */
export function stepDiff(prev: Omit<StepView, 'index'>, cur: Omit<StepView, 'index'>): StepDiff {
  const a = failureRefs(prev.res);
  const b = failureRefs(cur.res);
  const down: string[] = [];
  const degraded: string[] = [];
  const recovered: string[] = [];
  b.forEach((st, ref) => {
    if (!DIFF_KINDS.test(ref)) return;
    const was = a.get(ref);
    if (st === 'down' && was !== 'down') down.push(ref);
    else if (st === 'degraded' && !was) degraded.push(ref);
  });
  a.forEach((st, ref) => {
    if (!DIFF_KINDS.test(ref)) return;
    const now = b.get(ref);
    if (!now || (st === 'down' && now === 'degraded')) recovered.push(ref);
  });
  const pk = (p: { from: string; to: string }): string => p.from + '\n' + p.to;
  const before = new Map(prev.lost.pairs.map((p) => [pk(p), p] as [string, LostPair]));
  const after = new Map(cur.lost.pairs.map((p) => [pk(p), p] as [string, LostPair]));
  const lost = cur.lost.pairs.filter((p) => {
    const was = before.get(pk(p));
    return !was || (was.partial && !p.partial);
  });
  const regained = prev.lost.pairs.filter((p) => {
    const now = after.get(pk(p));
    // a pair whose device failed in this step is not "regained"
    if (cur.res.devices.get(p.from) === 'down' || cur.res.devices.get(p.to) === 'down') return false;
    return !now || (!p.partial && now.partial);
  });
  return { down: down.sort(cmp), degraded: degraded.sort(cmp), recovered: recovered.sort(cmp), lost, regained: regained.map((p) => ({ from: p.from, to: p.to })) };
}

/** Does a diff change anything? */
export function diffEmpty(d: StepDiff): boolean {
  return !d.down.length && !d.degraded.length && !d.recovered.length && !d.lost.length && !d.regained.length;
}

/** A scenario's id made from its name: lower case, words joined by "-", unique among `taken`. */
export function scenarioId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'scenario';
  let id = base;
  for (let n = 2; taken.indexOf(id) >= 0; n++) id = `${base}-${n}`;
  return id;
}

/** The steps of a scenario that can't be played, with why (by step index). */
export function scenarioProblems(model: Model, sc: Scenario): Array<{ index: number; problem: string }> {
  const out: Array<{ index: number; problem: string }> = [];
  sc.steps.forEach((s, i) => {
    const p = stepProblem(model, s);
    if (p) out.push({ index: i, problem: p });
  });
  return out;
}
