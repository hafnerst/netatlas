/**
 * Evaluating saved architecture expectations (the model's `expectations:`):
 * each one is checked statically against the configured model, or a
 * simulation snapshot, and gets a verdict and the actual reason:
 *
 *   available    the communication check is satisfied (under the failure
 *                condition, when one is given). Only some evaluated paths
 *                reaching is a violation; a path that leaves the model is
 *                indeterminate.
 *   blocked      no evaluated path delivers it. What blocks it is said: a
 *                policy decision, or something else (no route, a missing
 *                adjacency …), which may not be the intended control. A
 *                reachable destination without a listener is not blocked:
 *                the network lets it through. An enforcement requirement
 *                (`enforce`) says what must block it, path by path:
 *                unreachable (any prevention established), policy (an
 *                evaluated policy denies every path: a missing route or
 *                listener is no denial, and a path that stops before any
 *                policy decides leaves it not exercised), or boundary (the
 *                selected device denies every path). Partial equal-cost
 *                outcomes and truncated evaluation never count as complete
 *                isolation.
 *   dependency   a client application's configured peer or broker is
 *                usable (the same check as available, from the client).
 *   timing       by the method it accepts (PTP, NTP, or either): a
 *                compatible PTP source path, or a structurally valid NTP
 *                source chain to a modeled reference; a snapshot adds the
 *                synchronization it observed; accuracy is never evaluated.
 *
 * A failure condition (devices, cables, relations, interfaces, failure
 * domains) is applied to the configured model only: combined with a
 * snapshot it would blend two states, so that is unsupported. An end the
 * failure takes down is known to be unavailable, which is not missing
 * information: an available expectation is violated ("Source unavailable
 * under this failure condition"), a blocked one is indeterminate — no
 * traffic originates, so no control is exercised, and that is never a
 * successful isolation. Nothing is sent: evaluating never starts the
 * simulation. Pure and deterministic.
 */
import { EnforceKind, Expectation, Model } from '../model/types';
import { CommCheck, checkCommunication, parseCommEnd } from './communication';
import { failureCondition, simulate } from './failure';
import { AnalysisContext, ResultInfo, Verdict, configuredContext, resultInfo } from './result';
import { RoutingCtx } from './routing';
import { AnalysisSnapshot } from './snapshot';
import { TimingCheck, timingSource } from './timing';
import { STOP_LABEL, Trace } from './trace';
import { addressOwner } from './names';

export type ExpectVerdict = 'satisfied' | 'violated' | 'indeterminate' | 'unsupported';

export interface ExpectationResult {
  id: string;
  name: string;
  expect: Expectation['expect'];
  verdict: ExpectVerdict;
  /** the actual reason, in a sentence */
  reason: string;
  detail: string[];
  check?: CommCheck;
  timing?: TimingCheck;
  /** the failure condition applied */
  failure?: { entries: string[]; refs: string[]; unknown: string[] };
  /** where the communication stops (for grouping by a shared cause) */
  stop?: { device: string; reason: string; detail: string };
  /** what it concerns (for navigation) */
  refs: string[];
  /** an end the failure condition (or the snapshot) makes unavailable: known, not missing information */
  unavailable?: { end: 'source' | 'destination'; what: string };
  /** a blocked expectation's enforcement, path by path: what denied each, or why none did */
  enforcement?: { kind: EnforceKind; boundary?: string; paths: Array<{ outcome: 'denied' | 'stopped' | 'reached' | 'beyond'; at: string; detail: string; permittedBy: string[] }> };
}

function toExpect(v: Verdict): ExpectVerdict {
  return v === 'satisfied' ? 'satisfied' : v === 'violated' || v === 'partial' ? 'violated' : v === 'unsupported' ? 'unsupported' : 'indeterminate';
}

/** Evaluate one expectation (see the module comment). */
export function evaluateExpectation(model: Model, e: Expectation, snap: AnalysisSnapshot | null = null): ExpectationResult {
  const out: ExpectationResult = { id: e.id, name: e.name, expect: e.expect, verdict: 'indeterminate', reason: '', detail: [], refs: [] };
  if (e.description) out.detail.push(e.description);
  // ---- the failure condition
  let ctx: RoutingCtx | undefined;
  let devDown: (d: string) => boolean = () => false;
  if (e.failure.length) {
    const fc = failureCondition(model, e.failure);
    out.failure = { entries: e.failure.slice(), refs: fc.refs, unknown: fc.unknown };
    if (fc.unknown.length) {
      out.reason = `The failure condition names ${fc.unknown.join(', ')}, which ${fc.unknown.length === 1 ? 'is' : 'are'} not in the model`;
      return out;
    }
    if (snap) {
      out.verdict = 'unsupported';
      out.reason = 'A failure condition is evaluated on the configured model only: applied to a simulation snapshot it would blend two states';
      return out;
    }
    const res = simulate(model, fc.refs);
    ctx = res.ctx;
    devDown = (d) => res.devices.get(d) === 'down';
    out.detail.push(`Under the failure of ${fc.refs.map((r) => r.replace(/^[a-z]+:/, '')).join(', ')}${fc.domains.length ? ` (failure domain${fc.domains.length === 1 ? '' : 's'} ${fc.domains.join(', ')})` : ''}.`);
  }
  // ---- timing
  if (e.expect === 'timing') {
    const f = parseCommEnd(model, e.from);
    const dev = typeof f === 'string' ? null : f.kind === 'end' ? (f.end.kind === 'address' ? null : f.end.device) : f.kind === 'app' || f.kind === 'service' ? f.device : null;
    if (!dev) {
      out.reason = typeof f === 'string' ? f : `${e.from} names no device whose timing could be checked`;
      return out;
    }
    if (devDown(dev)) {
      out.reason = `${dev} itself is part of the failure condition`;
      return out;
    }
    // (the method accepted is the expectation's: none is chosen for it)
    const method = e.method || 'either';
    const t = timingSource(model, dev, ctx || (snap ? snap.ctx : {}), method, snap);
    if (!t) {
      out.verdict = 'unsupported';
      out.reason = method === 'ptp' ? `${dev} has no PTP clock: there is no PTP source to check` : method === 'ntp' ? `${dev} has no NTP service: there is no NTP source chain to check` : `${dev} has no PTP clock and no NTP service: there is no timing dependency to check`;
      return out;
    }
    out.timing = t;
    out.refs = t.refs.slice();
    out.detail.push(...t.detail);
    if (t.verdict === 'satisfied' && e.to && t.chain.indexOf(e.to) < 0) {
      out.verdict = 'violated';
      out.reason = `${t.text}, but not from ${e.to}`;
      return out;
    }
    out.verdict = toExpect(t.verdict);
    out.reason = t.text;
    return out;
  }
  // ---- communication: available, blocked, dependency
  if (e.expect === 'dependency') {
    const f = parseCommEnd(model, e.from);
    if (typeof f === 'string' || f.kind !== 'app' || !f.profile.client) {
      out.verdict = typeof f === 'string' ? 'indeterminate' : 'unsupported';
      out.reason = typeof f === 'string' ? f : 'A dependency expectation needs a client application (device/application) whose peer or broker the model configures';
      return out;
    }
  }
  // an end the failure takes down: known to be unavailable (see the module comment)
  if (e.failure.length && ctx) {
    const down = endUnavailable(model, e, ctx, devDown);
    if (down) {
      out.unavailable = down;
      const who = down.end === 'source' ? 'Source' : 'Destination';
      out.refs = [down.what.indexOf(':') > 0 ? 'iface:' + down.what : 'device:' + down.what];
      if (e.expect === 'blocked') {
        out.verdict = 'indeterminate';
        out.reason = `${who} unavailable under this failure condition (${down.what} is down): no traffic originates${down.end === 'destination' ? ' toward it' : ''}, so the isolation control is not exercised`;
      } else {
        out.verdict = 'violated';
        out.reason = `${who} unavailable under this failure condition (${down.what} is down)`;
      }
      return out;
    }
  }
  const req = { from: e.from, to: e.to, service: e.service, vrf: e.vrf, family: e.family };
  const c = checkCommunication(model, req, snap, 'Saved expectations', 0, ctx);
  out.check = c;
  if (c.error) {
    out.reason = c.error;
    return out;
  }
  for (const l of c.layers) for (const r of l.refs) if (out.refs.indexOf(r) < 0) out.refs.push(r);
  const stop = c.outcome ? c.outcome.groups.find((g) => g.kind === 'stopped') : undefined;
  if (stop) out.stop = { device: stop.device, reason: stop.reason as string, detail: stop.detail || '' };
  if (e.expect === 'blocked') return blockedVerdict(out, c, e);
  out.verdict = toExpect(c.verdict);
  // (the reason without the verdict's own words: the verdict is shown beside it)
  const why = c.headline.replace(/^(Indeterminate|Partially reachable|Beyond modeled scope): /, '');
  out.reason = c.verdict === 'partial' ? `Not all evaluated paths reach: ${why}` : c.verdict === 'beyond' ? `The path leaves the modeled architecture: ${why}` : why.charAt(0).toUpperCase() + why.slice(1);
  return out;
}

/**
 * The end of an expectation a failure takes down: its device, or the
 * interface it names (an application's bind interface). Null when both ends
 * are up, or an end is outside the model.
 */
function endUnavailable(model: Model, e: Expectation, ctx: RoutingCtx, devDown: (d: string) => boolean): { end: 'source' | 'destination'; what: string } | null {
  const at = (text: string | undefined): { device: string; iface?: string } | null => {
    if (!text) return null;
    const x = parseCommEnd(model, text);
    if (typeof x === 'string' || x.kind === 'name') return null;
    if (x.kind === 'app') return { device: x.device, iface: x.app.bind };
    if (x.kind === 'service') return { device: x.device };
    if (x.end.kind === 'address') {
      const o = addressOwner(model, x.end.address);
      return o ? { device: o } : null;
    }
    return x.end.kind === 'iface' ? { device: x.end.device, iface: x.end.iface } : { device: x.end.device };
  };
  const ends: Array<['source' | 'destination', { device: string; iface?: string } | null]> = [['source', at(e.from)], ['destination', at(e.to)]];
  // a client application without a destination: its configured peer or broker
  if (!e.to) {
    const f = parseCommEnd(model, e.from);
    if (typeof f !== 'string' && f.kind === 'app') {
      const peer = f.app.broker || f.app.peer;
      const dev = peer ? (peer.indexOf('/') > 0 ? peer.slice(0, peer.indexOf('/')) : model.index.devices.has(peer) ? peer : addressOwner(model, peer)) : undefined;
      if (dev) ends[1] = ['destination', { device: dev }];
    }
  }
  for (const [end, x] of ends) {
    if (!x) continue;
    if (devDown(x.device)) return { end, what: x.device };
    if (x.iface !== undefined && ctx.up && !ctx.up(x.device, x.iface)) return { end, what: x.device + ':' + x.iface };
  }
  return null;
}

/** A blocked expectation: what blocks the communication, if anything does, and whether it is a policy; then its enforcement requirement. */
function blockedVerdict(out: ExpectationResult, c: CommCheck, e: Expectation): ExpectationResult {
  const base = blockedBase(out, c);
  if (!e.enforce || e.enforce === 'unreachable' || !c.trace || base.verdict === 'violated' || (base.verdict === 'indeterminate' && !c.outcome)) {
    if (e.enforce === 'unreachable' && base.verdict === 'satisfied') base.reason = 'Unreachable (any prevention is enough): ' + base.reason.replace(/ the block may not be the intended control\.$/, '');
    return base;
  }
  return enforced(out, c, e);
}

/** The enforcement of a blocked expectation by a policy or a selected boundary (see the module comment), path by path. */
function enforced(out: ExpectationResult, c: CommCheck, e: Expectation): ExpectationResult {
  const kind = e.enforce as EnforceKind;
  const b = e.boundary;
  const paths = (c.trace as Trace).paths.map((p) => {
    const end = p.end;
    // the filtering devices on the way that permitted it (a hop with a policy decision that is not where it stops)
    const permittedBy = p.hops.filter((h, k) => !!h.why && h.why.policy.length > 0 && !(k === p.hops.length - 1 && end.kind === 'stopped' && end.reason === 'denied')).map((h) => h.device);
    const via = p.hops.map((h) => h.device).concat(...p.hops.map((h) => h.l2));
    if (end.kind === 'reached' || end.kind === 'delivered') return { outcome: 'reached' as const, at: end.device, detail: '', permittedBy, via };
    if (end.kind === 'exits') return { outcome: 'beyond' as const, at: end.device, detail: end.gateway, permittedBy, via };
    return { outcome: end.reason === 'denied' ? ('denied' as const) : ('stopped' as const), at: end.device, detail: end.reason === 'denied' ? end.detail : `${STOP_LABEL[end.reason]}${end.detail ? ': ' + end.detail : ''}`, permittedBy, via };
  });
  out.enforcement = { kind, boundary: b, paths: paths.map((p) => ({ outcome: p.outcome, at: p.at, detail: p.detail, permittedBy: p.permittedBy })) };
  if (kind === 'boundary' && (!b || !c.trace)) {
    out.verdict = 'indeterminate';
    out.reason = 'No boundary is selected';
    return out;
  }
  const label = kind === 'policy' ? 'Denied by policy' : `Denied at ${b}`;
  const verdicts: Array<{ v: 'satisfied' | 'violated' | 'indeterminate'; why: string }> = paths.map((p) => {
    if (p.outcome === 'reached') return { v: 'violated', why: `a path reaches ${p.at}` };
    if (p.outcome === 'beyond') return { v: 'indeterminate', why: `a path leaves the model at ${p.at}: what happens beyond is not modeled` };
    if (p.outcome === 'denied') {
      if (kind === 'policy' || p.at === b) return { v: 'satisfied', why: `denied at ${p.at}: ${p.detail}` };
      return { v: 'violated', why: `denied at ${p.at}, not at the selected boundary ${b}${p.via.indexOf(b as string) >= 0 ? ` (${b} permits it)` : ` (the path does not cross ${b})`}` };
    }
    // stopped for another reason: a policy that permitted it first does not deny it; else the control is not exercised
    const permitted = kind === 'policy' ? p.permittedBy : p.permittedBy.filter((d) => d === b);
    if (permitted.length) return { v: 'violated', why: `${permitted.join(', ')} permit${permitted.length === 1 ? 's' : ''} it; it stops at ${p.at} for another reason (${p.detail}), which is no denial ${kind === 'policy' ? 'by policy' : 'at the boundary'}` };
    if (kind === 'boundary' && p.via.indexOf(b as string) >= 0) return { v: 'violated', why: `it crosses ${b} without a denial there and stops at ${p.at} (${p.detail})` };
    return { v: 'indeterminate', why: `not exercised: it stops at ${p.at} (${p.detail}) before ${kind === 'policy' ? 'any policy decides' : `it reaches ${b}`}; ${/no route|adjacency|resolved/.test(p.detail) ? 'a missing route is no denial' : 'that is no denial'}` };
  });
  const any = (v: string) => verdicts.filter((x) => x.v === v);
  const n = paths.length;
  if (any('violated').length) {
    out.verdict = 'violated';
    out.reason = `${label} is not established: ${any('violated')[0].why}${n > 1 ? ` (${any('violated').length} of ${n} evaluated paths)` : ''}`;
  } else if (any('indeterminate').length || (c.outcome && c.outcome.truncated)) {
    out.verdict = 'indeterminate';
    out.reason = any('indeterminate').length ? `${label} is not established: ${any('indeterminate')[0].why}${n > 1 ? ` (${any('indeterminate').length} of ${n} evaluated paths)` : ''}` : `${label} on the ${n} evaluated paths, but more equal-cost paths exist than were evaluated`;
  } else {
    out.verdict = 'satisfied';
    const at = Array.from(new Set(paths.map((p) => p.at)));
    out.reason = `${label} on ${n === 1 ? 'the evaluated path' : `every evaluated path (${n})`}: ${at.join(', ')} — ${paths[0].detail}`;
  }
  return out;
}

/** A blocked expectation's base verdict: what blocks the communication, if anything does, and whether it is a policy. */
function blockedBase(out: ExpectationResult, c: CommCheck): ExpectationResult {
  const layer = (id: string) => c.layers.find((l) => l.id === id);
  const addr = layer('address');
  if (addr && addr.verdict !== 'satisfied') {
    out.verdict = 'indeterminate';
    out.reason = addr.text;
    return out;
  }
  const o = c.outcome;
  if (!o) {
    out.verdict = 'indeterminate';
    out.reason = c.headline;
    return out;
  }
  const reached = o.groups.filter((g) => g.kind === 'reached').reduce((s, g) => s + g.count, 0);
  const stopped = o.groups.filter((g) => g.kind === 'stopped');
  const nStopped = stopped.reduce((s, g) => s + g.count, 0);
  if (nStopped === o.total && o.total > 0) {
    out.verdict = 'satisfied';
    if (o.policyOnly) out.reason = `Blocked by policy at ${stopped.map((g) => g.device).join(', ')}: ${stopped[0].detail || ''}`;
    else {
      const what = stopped.map((g) => `${STOP_LABEL[g.reason as keyof typeof STOP_LABEL]} at ${g.device}`).join('; ');
      const policy = stopped.filter((g) => g.reason === 'denied');
      out.reason = `Not reachable: ${what}. ${policy.length ? 'Only some paths are stopped by a policy' : 'No policy decision blocks it'}: the block may not be the intended control.`;
    }
    if (o.truncated) {
      out.verdict = 'indeterminate';
      out.reason += ' More equal-cost paths exist than were evaluated.';
    }
    return out;
  }
  if (reached) {
    const lis = layer('listener');
    out.verdict = 'violated';
    out.reason = `Reachable: ${reached} of ${o.total} evaluated path${o.total === 1 ? '' : 's'} reach${reached === 1 ? 'es' : ''} ${c.to ? c.to.text : 'the destination'}${lis && lis.verdict === 'violated' ? `; nothing listens there (${lis.text}), but no policy blocks the traffic` : ''}`;
    return out;
  }
  out.verdict = 'indeterminate';
  out.reason = `The path leaves the modeled architecture: ${c.headline}`;
  return out;
}

/** The evaluation of all expectations, with the context it ran in. */
export interface ExpectationRun {
  results: ExpectationResult[];
  info: ResultInfo;
}

export function evaluateExpectations(model: Model, snap: AnalysisSnapshot | null = null): ExpectationRun {
  const context: AnalysisContext = snap ? { kind: 'snapshot', at: snap.at, scope: 'Saved expectations' } : configuredContext('Saved expectations');
  const results = model.expectations.map((e) => evaluateExpectation(model, e, snap));
  return {
    results,
    info: resultInfo(context, ['Each expectation is checked statically (communication checks, the timing analysis); nothing is sent.'], ['Runtime behaviour: authentication, protocol acceptance, service health, synchronization accuracy.']),
  };
}

/** Results grouped by where they stop, when several stop at the same device for the same reason (a shared cause: the detail of the first is shown), with the others apart. */
export function sharedStops(results: ExpectationResult[]): Array<{ device: string; reason: string; detail: string; ids: string[] }> {
  const m = new Map<string, { device: string; reason: string; detail: string; ids: string[] }>();
  for (const r of results) {
    if (!r.stop || r.verdict === 'satisfied') continue;
    const k = `${r.stop.device}\n${r.stop.reason}`;
    if (!m.has(k)) m.set(k, { device: r.stop.device, reason: r.stop.reason, detail: r.stop.detail, ids: [] });
    (m.get(k) as { ids: string[] }).ids.push(r.id);
  }
  return Array.from(m.values()).filter((g) => g.ids.length > 1).sort((a, b) => b.ids.length - a.ids.length || (a.device < b.device ? -1 : 1));
}
