/**
 * What if a failure condition happens: a failure domain or a small explicit
 * set of components fails together, and the same baseline is compared with
 * the state after it. Structural consequences (what goes down or degrades,
 * devices cut off, relations without an underlay), the configured service
 * dependencies (unavailable, through an alternative, degraded, not
 * determinable), the saved expectations before and after (availability
 * lost, isolation violated, kept through an alternative, violated before
 * already, not determinable; isolation is evaluated as modeled, not
 * assumed: a failure can change the selected path around a control), and,
 * when asked for, device pairs in a scope that lose reachability, with the
 * coverage of what was checked. A static what-if: no probability, no
 * convergence or recovery time. Bounded and deterministic; pure.
 */
import { Model } from '../model/types';
import { DepChange, ServiceDependency, compareDependencies, dependencyBaseline, serviceDependencies, DepState } from './dependencies';
import { ExpectationResult, evaluateExpectation } from './expectations';
import { FailureResult, FailureSummary, LostPair, ReachScope, SpofCandidate, failureCondition, failureRefs, lostPairs, scopePairs, simulate, structuralImpact, summarize, Spof } from './failure';
import { Coverage, ResultInfo, configuredContext, resultInfo } from './result';

/** At most this many components (after expanding the domains) fail in one what-if. */
export const WHATIF_MAX = 64;

export interface WhatIf {
  /** what fails, as given, and expanded */
  entries: string[];
  refs: string[];
  unknown: string[];
  domains: string[];
  /** the condition is larger than WHATIF_MAX: nothing was evaluated */
  tooLarge: boolean;
  result: FailureResult | null;
  summary: FailureSummary | null;
  structural: Spof | null;
  deps: DepChange[];
  /** the saved expectations, before and after (`alternative`: satisfied both times, over another path or source) */
  expectations: ExpChange[];
  reach?: { pairs: LostPair[]; coverage: Coverage };
  info: ResultInfo;
}

/** How a saved expectation fares under a failure, against its state without it. */
export type ExpChangeKind = 'isolation-violated' | 'availability-lost' | 'indeterminate' | 'unsupported' | 'alternative' | 'already-violated' | 'unchanged';

export const EXP_CHANGE_TEXT: { [k in ExpChangeKind]: string } = {
  'isolation-violated': 'Isolation violated',
  'availability-lost': 'Availability lost',
  indeterminate: 'Cannot be determined',
  unsupported: 'Not supported',
  alternative: 'Kept through an alternative',
  'already-violated': 'Violated before the failure',
  unchanged: 'Unaffected',
};

/** The order a what-if lists them in: what the failure breaks first. */
export const EXP_CHANGE_ORDER: ExpChangeKind[] = ['isolation-violated', 'availability-lost', 'indeterminate', 'unsupported', 'alternative', 'already-violated', 'unchanged'];

export interface ExpChange {
  before: ExpectationResult;
  after: ExpectationResult;
  /** satisfied both times, over another path or source */
  alternative: boolean;
  change: ExpChangeKind;
}

/** Classify an expectation's change (see ExpChangeKind). */
export function expChange(before: ExpectationResult, after: ExpectationResult): ExpChange {
  const alternative = before.verdict === 'satisfied' && after.verdict === 'satisfied' && wayOf(before) !== wayOf(after);
  const blocked = after.expect === 'blocked';
  let change: ExpChangeKind;
  if (before.verdict === 'violated') change = 'already-violated';
  else if (after.verdict === 'violated') change = blocked ? 'isolation-violated' : 'availability-lost';
  else if (after.verdict === 'indeterminate') change = 'indeterminate';
  else if (after.verdict === 'unsupported') change = 'unsupported';
  else if (before.verdict !== 'satisfied') change = 'indeterminate';
  else change = alternative && !blocked ? 'alternative' : 'unchanged';
  return { before, after, alternative: alternative && !blocked, change };
}

/** The devices that the expectations and dependencies name (relevant endpoints first in a bounded scope). */
export function relevantDevices(model: Model, deps: ServiceDependency[]): string[] {
  const s = new Set<string>();
  for (const d of deps) {
    s.add(d.consumer);
    for (const o of d.options) if (o.provider) s.add(o.provider);
  }
  for (const e of model.expectations) {
    for (const t of [e.from, e.to || '']) {
      const dev = t.split(/[:/]/)[0];
      if (model.index.devices.has(dev)) s.add(dev);
    }
  }
  return Array.from(s).sort();
}

/**
 * Evaluate a what-if. `baseline` is the dependencies' state without the
 * failure (computed when not given); `reach` adds pairwise reachability in
 * a scope.
 */
export function whatIf(model: Model, entries: string[], opts: { deps?: ServiceDependency[]; baseline?: Map<string, DepState>; reach?: ReachScope } = {}): WhatIf {
  const fc = failureCondition(model, entries);
  const scope = fc.domains.length === 1 && entries.length === 1 ? `Failure domain ${fc.domains[0]}` : `Failure of ${entries.join(', ')}`;
  const out: WhatIf = { entries: entries.slice(), refs: fc.refs, unknown: fc.unknown, domains: fc.domains, tooLarge: fc.refs.length > WHATIF_MAX, result: null, summary: null, structural: null, deps: [], expectations: [], info: resultInfo(configuredContext(scope)) };
  if (out.tooLarge || !fc.refs.length) {
    out.info.limits.push(out.tooLarge ? `The condition fails ${fc.refs.length} components; at most ${WHATIF_MAX} are evaluated together.` : 'Nothing of the model fails.');
    return out;
  }
  const res = simulate(model, fc.refs);
  out.result = res;
  out.summary = summarize(model, res);
  const cand: SpofCandidate = { kind: 'device', ref: fc.refs[0], fail: fc.refs };
  out.structural = structuralImpact(model, cand, res);
  const deps = opts.deps || serviceDependencies(model);
  const baseline = opts.baseline || dependencyBaseline(model, deps);
  const hit = new Set(Array.from(failureRefs(res).keys()));
  const devDown = (d: string): boolean => res.devices.get(d) === 'down';
  out.deps = compareDependencies(model, deps, baseline, res.ctx, hit, devDown);
  // every saved expectation: before (as it is) and after (under this condition as well); isolation as modeled, not assumed
  for (const e of model.expectations) {
    const before = evaluateExpectation(model, { ...e, failure: e.failure.slice() });
    const after = evaluateExpectation(model, { ...e, failure: e.failure.concat(entries.filter((x) => e.failure.indexOf(x) < 0)) });
    out.expectations.push(expChange(before, after));
  }
  out.expectations.sort((a, b) => EXP_CHANGE_ORDER.indexOf(a.change) - EXP_CHANGE_ORDER.indexOf(b.change) || (a.after.id < b.after.id ? -1 : a.after.id > b.after.id ? 1 : 0));
  if (opts.reach) {
    const sp = scopePairs(model, opts.reach, relevantDevices(model, deps));
    const pairs = lostPairs(model, res, sp.pairs);
    out.reach = { pairs, coverage: { checked: sp.pairs.length, eligible: sp.eligible, unit: 'device pairs', truncated: sp.omitted.length > 0, omitted: sp.omitted.length ? `${sp.omitted.length} device${sp.omitted.length === 1 ? '' : 's'} beyond the limit (${sp.omitted.slice(0, 6).join(', ')}${sp.omitted.length > 6 ? ' …' : ''})` : undefined } };
  }
  out.info = resultInfo(
    configuredContext(scope),
    ['The failure propagates as the failure analysis models it: devices take their interfaces and cables down, aggregates and redundancy groups degrade or fail over, relations fail with their underlay, static routes with their next hop.', 'The baseline is the configured model with nothing failed.'],
    ['Convergence and recovery times, timers and transient loss.', 'Probabilities: a what-if is a condition, not a reliability estimate.', 'Runtime behaviour of the services (sessions, retries, caches, lease renewals in progress).'],
    out.reach ? out.reach.coverage : undefined,
  );
  return out;
}

/** The way an expectation is met: its main path's devices, or its timing chain. */
function wayOf(r: ExpectationResult): string {
  if (r.timing) return r.timing.chain.join('<');
  const t = r.check && r.check.trace;
  return t && t.paths[0] ? t.paths[0].hops.map((h) => h.device + (h.l2.length ? '(' + h.l2.join(',') + ')' : '')).join('>') : '';
}

/** The counts of a what-if's service comparison, by change. */
export function depCounts(w: WhatIf): { [k: string]: number } {
  const c: { [k: string]: number } = {};
  for (const d of w.deps) c[d.change] = (c[d.change] || 0) + 1;
  return c;
}
