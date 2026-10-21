/**
 * Timing dependencies, statically: does a clock have a compatible source
 * path within the analysis NetAtlas supports? Configuration and structure
 * only; whether a clock synchronizes, and how accurately, is runtime
 * behaviour (the protocol simulation models it; nothing here claims it).
 *
 *   PTP   IEEE 1588-2008, its Default delay request-response profile over
 *         UDP/IPv4 multicast with a TTL of 1 (model/ptp.ts): PTP messages
 *         stay on a switched segment, a boundary clock carries time from
 *         one of its PTP ports to the others, transparent clocks and plain
 *         switches pass it within the segment. A clock has a source path
 *         when a source-capable ordinary clock of its domain and profile is
 *         on one of its segments, or on a segment a boundary clock of the
 *         domain joins to it (followed over boundary clocks).
 *   NTP   a device with the NTP service and upstreams: its configured
 *         source chain, upstream by upstream to a modeled reference (a
 *         device with a stratum of its own), each hop reachable on UDP 123
 *         (a communication check: path, policy, listener). The analysis
 *         says apart: an upstream reachable; a structurally valid chain to
 *         a root (cycles, a chain without a modeled root, an upstream
 *         outside the model or without NTP are not); a feasible one — each
 *         hop adds one to the stratum, and a client of a server at 15 would
 *         be at 16, unsynchronized (RFC 5905: a reference's stratum plus
 *         the hops down to the client is at most 15; the best feasible
 *         alternative is taken, an infeasible one never hides it); the
 *         synchronization a simulation snapshot observed; and that
 *         accuracy is never evaluated. A reachable NTP server is not taken
 *         to be synchronized.
 *
 * The method is explicit (TimingMethod): PTP, NTP, or either when either is
 * accepted (both are evaluated and both reported). No clock-discipline
 * precedence and no NTP/PTP bridging is inferred.
 *
 * Pure and deterministic.
 */
import { PTP_DEFAULTS } from '../model/ptp';
import { Model, TIMING_METHODS, TimingMethod } from '../model/types';
import { checkCommunication } from './communication';
import { addressOwner } from './names';
import { Verdict } from './result';
import { RoutingCtx } from './routing';
import { segmentOf } from './scope';
import type { AnalysisSnapshot } from './snapshot';

export type { TimingMethod };
export { TIMING_METHODS };

/** One way an NTP client's configured chain goes: an upstream and where following it ends. */
export interface NtpAlternative {
  /** the upstream address as configured */
  upstream: string;
  /** root: a modeled reference within reach of the stratum ceiling; stratum: a reference too far down for it; the others say why the chain is not valid */
  state: 'root' | 'stratum' | 'cycle' | 'no-root' | 'external' | 'no-ntp' | 'unreachable' | 'unknown';
  /** the devices from the client to where it ends */
  chain: string[];
  /** the reference's stratum (root, stratum) */
  stratum?: number;
  /** the stratum the client would have through it: the reference's plus the hops (root, stratum) */
  client?: number;
  text: string;
}

export interface TimingCheck {
  verdict: Verdict;
  /** "PTP", "NTP", "PTP or NTP" */
  protocol: string;
  text: string;
  /** the source path, clock by clock ("pc1", "bc1", "gm") */
  chain: string[];
  detail: string[];
  refs: string[];
  /** NTP: each upstream's chain */
  ntp?: NtpAlternative[];
  /** NTP: the first hop (an upstream answering on UDP 123) apart from the chain to a root */
  levels?: { upstream: Verdict; chain: Verdict };
  /** what a simulation snapshot observed (never an accuracy) */
  observed?: string;
  /** either: each method's own check */
  parts?: TimingCheck[];
}

interface Clock {
  dev: string;
  kind: 'ordinary' | 'boundary' | 'transparent';
  domain: number;
  profile: string;
  ports: string[];
  source: boolean;
}

function clocksOf(model: Model): Clock[] {
  const out: Clock[] = [];
  for (const d of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const s = d.appServices ? d.appServices.get('ptp') : undefined;
    if (!s) continue;
    const v = s.values;
    const kind = v.clock as Clock['kind'] | undefined;
    if (!kind) continue;
    out.push({
      dev: d.id,
      kind,
      domain: typeof v.domain === 'number' ? (v.domain as number) : PTP_DEFAULTS.domain,
      profile: typeof v.profile === 'string' ? (v.profile as string) : 'default_e2e_udp4',
      ports: Array.isArray(v.interfaces) ? (v.interfaces as string[]).slice() : [],
      source: kind === 'ordinary' ? v.role === 'source_capable' : kind === 'boundary',
    });
  }
  return out;
}

/** The PTP source path of a clock (see the module comment). */
export function ptpSource(model: Model, dev: string, ctx: RoutingCtx = {}): TimingCheck | null {
  const clocks = clocksOf(model);
  const me = clocks.find((c) => c.dev === dev);
  if (!me) return null;
  if (me.kind === 'transparent') return { verdict: 'unsupported', protocol: 'PTP', text: `${dev} is a transparent clock: it corrects what passes and has no source of its own to check`, chain: [], detail: [], refs: ['device:' + dev] };
  const peers = clocks.filter((c) => c.dev !== dev && c.kind !== 'transparent' && c.domain === me.domain && c.profile === me.profile);
  const other = clocks.filter((c) => c.dev !== dev && c.kind !== 'transparent' && (c.domain !== me.domain || c.profile !== me.profile));
  const up = (d: string, i: string): boolean => !ctx.up || ctx.up(d, i);
  // breadth-first over clocks: a clock's PTP ports' segments reach the clocks on them; a boundary clock goes on from its other ports
  const seen = new Set<string>([dev]);
  const prev = new Map<string, string>();
  let queue: string[] = [dev];
  const detail: string[] = [];
  while (queue.length) {
    const next: string[] = [];
    for (const cur of queue) {
      const c = cur === dev ? me : (peers.find((p) => p.dev === cur) as Clock);
      for (const port of c.ports) {
        if (!up(c.dev, port)) continue;
        const seg = segmentOf(model, c.dev, port, undefined, ctx);
        if (!seg) {
          if (cur === dev) detail.push(`${dev}:${port} has no cable in the model: its segment is not known`);
          continue;
        }
        for (const p of peers) {
          if (seen.has(p.dev) || !p.ports.some((x) => seg.has(p.dev + ':' + x) && up(p.dev, x))) continue;
          seen.add(p.dev);
          prev.set(p.dev, cur);
          // a source-capable ordinary clock ends the search; a boundary clock is a source too, and carries time on
          if (p.kind === 'ordinary' && p.source) {
            const chain: string[] = [p.dev];
            let x = cur;
            while (x !== dev) {
              chain.unshift(x);
              x = prev.get(x) as string;
            }
            chain.unshift(dev);
            return {
              verdict: 'satisfied',
              protocol: 'PTP',
              text: `A compatible PTP source path exists within the supported analysis: ${chain.join(' ← ')} (domain ${me.domain}); synchronization and its accuracy are not established`,
              chain,
              detail: ['The path is configuration and structure: the clocks share the domain and profile and the segments join them. Whether the best master clock algorithm elects this source, and how accurately the clocks synchronize, is runtime behaviour.'],
              refs: chain.map((d) => 'device:' + d),
            };
          }
          if (p.kind === 'boundary') next.push(p.dev);
        }
      }
    }
    queue = next;
  }
  // a boundary clock reached without a grandmaster beyond it: it may become the grandmaster itself
  const bcs = Array.from(seen).filter((d) => d !== dev);
  if (bcs.length) {
    return { verdict: 'indeterminate', protocol: 'PTP', text: `Only boundary clocks of domain ${me.domain} are on its segments (${bcs.join(', ')}): no source-capable ordinary clock is reached behind them, so the source depends on which clock the election makes grandmaster`, chain: [dev].concat(bcs), detail, refs: bcs.map((d) => 'device:' + d) };
  }
  if (other.length) detail.push(`Clocks of other domains or profiles: ${other.map((c) => `${c.dev} (domain ${c.domain})`).join(', ')}: they never synchronize ${dev}`);
  return { verdict: 'violated', protocol: 'PTP', text: `No PTP clock of domain ${me.domain} with a compatible profile is on ${dev}’s segments or behind a boundary clock there`, chain: [dev], detail, refs: ['device:' + dev] };
}

/** The NTP configuration of a device: its own stratum (a reference) and its upstreams. */
function ntpOf(model: Model, dev: string): { stratum?: number; upstreams: string[] } | null {
  const d = model.index.devices.get(dev);
  const svc = d && d.appServices ? d.appServices.get('ntp') : undefined;
  if (!svc) return null;
  return { stratum: typeof svc.values.stratum === 'number' ? (svc.values.stratum as number) : undefined, upstreams: Array.isArray(svc.values.upstreams) ? (svc.values.upstreams as string[]).slice() : [] };
}

/** At most this many hops are followed up an NTP chain (NTP's stratum ceiling). */
const NTP_MAX_DEPTH = 15;
/** The highest stratum a synchronized client can have (RFC 5905: 16 is unsynchronized). */
const NTP_MAX_STRATUM = 15;

/**
 * Follow a device's configured NTP upstreams (see the module comment): each
 * upstream's chain to a modeled reference, or why it is none. `path` holds
 * the devices on the way (a cycle comes back to one of them).
 */
function ntpChains(model: Model, dev: string, ctx: RoutingCtx | undefined, path: string[], memo: Map<string, NtpAlternative[]>): NtpAlternative[] {
  const cfg = ntpOf(model, dev);
  const out: NtpAlternative[] = [];
  for (const up of cfg ? cfg.upstreams : []) {
    const owner = addressOwner(model, up);
    if (!owner) {
      out.push({ upstream: up, state: 'external', chain: path.concat([up]), text: `${up}: outside the model (an external or unknown upstream: what it is synchronized to is not modeled)` });
      continue;
    }
    const oc = ntpOf(model, owner);
    if (!oc) {
      out.push({ upstream: up, state: 'no-ntp', chain: path.concat([owner]), text: `${up} (${owner}) runs no NTP service` });
      continue;
    }
    // an upstream whose interface is down (a failure condition: its device failed) is unavailable, never beyond the model
    const od = model.index.devices.get(owner);
    const oif = od ? od.interfaces.concat(od.logical).find((i) => i.addresses.some((a) => a.split('/')[0] === up)) : undefined;
    if (ctx && ctx.up && oif && !ctx.up(owner, oif.id)) {
      out.push({ upstream: up, state: 'unreachable', chain: path.concat([owner]), text: `${up} (${owner}:${oif.id}) is down under this failure condition` });
      continue;
    }
    const c = checkCommunication(model, { from: dev, to: up, service: 'udp/123' }, null, 'Selected endpoints', 1, ctx);
    if (c.verdict !== 'satisfied') {
      out.push({ upstream: up, state: c.verdict === 'indeterminate' || c.verdict === 'beyond' ? 'unknown' : 'unreachable', chain: path.concat([owner]), text: `${dev} → ${owner} (${up}, UDP 123): ${c.headline}` });
      continue;
    }
    if (path.indexOf(owner) >= 0) {
      out.push({ upstream: up, state: 'cycle', chain: path.concat([owner]), text: `a cycle: ${path.concat([owner]).join(' → ')} (no reference on the way)` });
      continue;
    }
    if (oc.stratum !== undefined) {
      // (each hop down adds one: the client of the chain's first device is at the reference's stratum plus the hops)
      const chain = path.concat([owner]);
      const client = oc.stratum + chain.length - 1;
      if (client > NTP_MAX_STRATUM) out.push({ upstream: up, state: 'stratum', chain, stratum: oc.stratum, client, text: `${chain.join(' → ')}: ${owner} is a reference of stratum ${oc.stratum}, ${chain.length - 1} hop${chain.length === 2 ? '' : 's'} up: ${chain[0]} would be at stratum ${client}, above ${NTP_MAX_STRATUM} — unsynchronized, the chain is not usable` });
      else out.push({ upstream: up, state: 'root', chain, stratum: oc.stratum, client, text: `${chain.join(' → ')}: ${owner} is a configured reference (stratum ${oc.stratum}, its reference clock taken as given; ${chain[0]} at stratum ${client})` });
      continue;
    }
    if (!oc.upstreams.length || path.length >= NTP_MAX_DEPTH) {
      out.push({ upstream: up, state: 'no-root', chain: path.concat([owner]), text: `${owner} has ${oc.upstreams.length ? 'more than ' + NTP_MAX_DEPTH + ' hops above it' : 'no upstreams and no stratum of its own'}: the chain has no modeled reference` });
      continue;
    }
    // further up: the best way from the upstream (a root first)
    const key = owner + '|' + path.join('>');
    const sub = memo.get(key) || ntpChains(model, owner, ctx, path.concat([owner]), memo);
    memo.set(key, sub);
    // (the feasible root with the lowest stratum for the client first; an infeasible one never hides a usable alternative)
    const roots = sub.filter((x) => x.state === 'root').sort((a, b) => (a.client as number) - (b.client as number));
    const best = roots[0] || sub.find((x) => x.state === 'unknown') || sub.find((x) => x.state === 'external') || sub.find((x) => x.state === 'stratum') || sub[0];
    if (!best) {
      out.push({ upstream: up, state: 'no-root', chain: path.concat([owner]), text: `${owner}'s upstreams lead nowhere` });
      continue;
    }
    out.push({ upstream: up, state: best.state, chain: best.chain, stratum: best.stratum, client: best.client, text: best.text });
  }
  return out;
}

/** The NTP source chain of a device (see the module comment), or null when it has no NTP service. */
export function ntpSource(model: Model, dev: string, ctx?: RoutingCtx, snap?: AnalysisSnapshot | null): TimingCheck | null {
  const cfg = ntpOf(model, dev);
  if (!cfg) return null;
  const observed = observedOf(snap, dev, 'ntp');
  if (!cfg.upstreams.length) {
    if (cfg.stratum === undefined) return null;
    return { verdict: 'satisfied', protocol: 'NTP', text: `${dev} is a configured reference (stratum ${cfg.stratum}): it takes no time from upstreams; its reference clock is taken as given`, chain: [dev], detail: ['A reference of its own is configuration: the reference clock itself is not modeled.'], refs: ['device:' + dev], ntp: [], levels: { upstream: 'satisfied', chain: 'satisfied' }, observed };
  }
  const alts = ntpChains(model, dev, ctx, [dev], new Map());
  const roots = alts.filter((x) => x.state === 'root').sort((a, b) => (a.client as number) - (b.client as number));
  const first = alts.filter((x) => x.state !== 'external' && x.state !== 'no-ntp' && x.state !== 'unreachable' && x.state !== 'unknown');
  const upstream: Verdict = first.length ? 'satisfied' : alts.some((x) => x.state === 'unknown') ? 'indeterminate' : alts.every((x) => x.state === 'external') ? 'beyond' : 'violated';
  const detail = alts.map((x) => `${x.upstream}: ${x.text}`);
  detail.push('Accuracy is not evaluated: offsets, jitter and the clock filter are not modeled.');
  const refs = Array.from(new Set(alts.flatMap((x) => x.chain).filter((d) => model.index.devices.has(d)))).map((d) => 'device:' + d);
  const base = { protocol: 'NTP', detail, refs, ntp: alts, observed };
  if (roots.length) {
    const r = roots[0];
    const more = roots.length > 1 ? `; ${roots.length - 1} alternative root${roots.length === 2 ? '' : 's'} (${roots.slice(1).map((x) => x.chain[x.chain.length - 1]).join(', ')})` : '';
    return { ...base, verdict: 'satisfied', text: `A structurally valid NTP source chain exists: ${r.chain.join(' → ')} (a configured reference, stratum ${r.stratum}; ${dev} at stratum ${r.client})${more}; ${observed ? 'the snapshot: ' + observed : 'runtime synchronization is not established'}; accuracy is not evaluated`, chain: r.chain, levels: { upstream, chain: 'satisfied' } };
  }
  const why = alts.find((x) => x.state === 'stratum') || alts.find((x) => x.state === 'cycle') || alts.find((x) => x.state === 'no-root') || alts.find((x) => x.state === 'unreachable') || alts.find((x) => x.state === 'no-ntp');
  if (alts.some((x) => x.state === 'unknown')) {
    const u = alts.find((x) => x.state === 'unknown') as NtpAlternative;
    return { ...base, verdict: 'indeterminate', text: `The NTP source chain can't be established: ${u.text}`, chain: u.chain, levels: { upstream, chain: 'indeterminate' } };
  }
  if (!why && alts.some((x) => x.state === 'external')) {
    return { ...base, verdict: 'beyond', text: `${dev}'s NTP chain leaves the model (${alts.filter((x) => x.state === 'external').map((x) => x.upstream).join(', ')}): what those upstreams are synchronized to is not modeled`, chain: [dev], levels: { upstream, chain: 'beyond' } };
  }
  return { ...base, verdict: 'violated', text: `No structurally valid NTP source chain: ${(why as NtpAlternative).text}${upstream === 'satisfied' ? ' (an upstream is reachable, but that is not a source chain)' : ''}`, chain: (why as NtpAlternative).chain, levels: { upstream, chain: 'violated' } };
}

/** What a snapshot observed of a device's clock, in words (none without a snapshot or its state). */
function observedOf(snap: AnalysisSnapshot | null | undefined, dev: string, protocol: 'ntp' | 'ptp'): string | undefined {
  const t = snap && snap.timing ? snap.timing.find((x) => x.dev === dev && x.protocol === protocol) : undefined;
  if (!t) return undefined;
  return `at t = ${((snap as AnalysisSnapshot).at / 1000).toFixed(1)} s ${dev} is ${t.synchronized ? 'synchronized' : 'not synchronized'} (${t.text})`;
}

/**
 * The timing source of a device by a method (see the module comment): PTP,
 * NTP, or either — then both are evaluated and both reported, and the
 * result is satisfied when one of them is. Null when the device has
 * neither (or not the one asked for).
 */
export function timingSource(model: Model, dev: string, ctx: RoutingCtx = {}, method: TimingMethod = 'either', snap?: AnalysisSnapshot | null): TimingCheck | null {
  const withObs = (t: TimingCheck | null): TimingCheck | null => {
    if (t && t.protocol === 'PTP' && !t.observed) {
      const o = observedOf(snap, dev, 'ptp');
      if (o) {
        t.observed = o;
        if (t.verdict === 'satisfied') t.text = t.text.replace('; synchronization and its accuracy are not established', `; the snapshot: ${o}; accuracy is not evaluated`);
      }
    }
    return t;
  };
  if (method === 'ptp') return withObs(ptpSource(model, dev, ctx));
  if (method === 'ntp') return ntpSource(model, dev, ctx, snap);
  const p = withObs(ptpSource(model, dev, ctx));
  const n = ntpSource(model, dev, ctx, snap);
  if (!p || !n) return p || n;
  // both configured and either is accepted: both reported, satisfied when one is (no precedence between them is inferred)
  const rank: Verdict[] = ['satisfied', 'partial', 'indeterminate', 'beyond', 'unsupported', 'violated'];
  const best = rank.indexOf(p.verdict) <= rank.indexOf(n.verdict) ? p : n;
  return { ...best, protocol: 'PTP or NTP', text: `${best.protocol}: ${best.text}. ${best === p ? 'NTP' : 'PTP'}: ${(best === p ? n : p).text}`, parts: [p, n], refs: Array.from(new Set(p.refs.concat(n.refs))) };
}
