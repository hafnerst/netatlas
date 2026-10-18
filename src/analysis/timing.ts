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
 *   NTP   a device with the NTP service and upstreams: one of its upstream
 *         addresses is a device of the model that runs NTP, and the device
 *         reaches it on UDP 123 (a communication check).
 *
 * Pure and deterministic.
 */
import { PTP_DEFAULTS } from '../model/ptp';
import { Model } from '../model/types';
import { checkCommunication } from './communication';
import { addressOwner } from './names';
import { Verdict } from './result';
import { RoutingCtx } from './routing';
import { segmentOf } from './scope';

export interface TimingCheck {
  verdict: Verdict;
  /** "PTP", "NTP" */
  protocol: string;
  text: string;
  /** the source path, clock by clock ("pc1", "bc1", "gm") */
  chain: string[];
  detail: string[];
  refs: string[];
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

/** The NTP upstream path of a device (see the module comment), or null when it has no NTP upstreams. */
export function ntpSource(model: Model, dev: string, ctx?: RoutingCtx): TimingCheck | null {
  const d = model.index.devices.get(dev);
  const s = d && d.appServices ? d.appServices.get('ntp') : undefined;
  const ups = s && Array.isArray(s.values.upstreams) ? (s.values.upstreams as string[]) : [];
  if (!s || !ups.length) return null;
  const detail: string[] = [];
  let partial: TimingCheck | null = null;
  for (const a of ups) {
    const owner = addressOwner(model, a);
    if (!owner) {
      detail.push(`${a}: not an address of the model (outside it: not known)`);
      continue;
    }
    const od = model.index.devices.get(owner);
    if (!od || !od.appServices || !od.appServices.has('ntp')) {
      detail.push(`${a} (${owner}) runs no NTP service`);
      continue;
    }
    const c = checkCommunication(model, { from: dev, to: a, service: 'udp/123' }, null, 'Selected endpoints', 1, ctx);
    detail.push(`${a} (${owner}): ${c.headline}`);
    if (c.verdict === 'satisfied') return { verdict: 'satisfied', protocol: 'NTP', text: `A compatible NTP source path exists: ${dev} → ${owner} (${a}, UDP 123); synchronization is not established`, chain: [dev, owner], detail, refs: ['device:' + owner] };
    if (!partial && (c.verdict === 'partial' || c.verdict === 'indeterminate' || c.verdict === 'beyond')) partial = { verdict: c.verdict, protocol: 'NTP', text: `${dev} → ${owner} (${a}): ${c.headline}`, chain: [dev, owner], detail, refs: ['device:' + owner] };
  }
  if (partial) return { ...partial, detail };
  const outside = ups.every((a) => !addressOwner(model, a));
  return { verdict: outside ? 'beyond' : 'violated', protocol: 'NTP', text: outside ? `${dev}’s NTP upstreams (${ups.join(', ')}) are outside the model` : `No NTP upstream of ${dev} is reachable as an NTP server within the model`, chain: [dev], detail, refs: ['device:' + dev] };
}

/** The timing source of a device: PTP first, then NTP; null when it has neither. */
export function timingSource(model: Model, dev: string, ctx: RoutingCtx = {}): TimingCheck | null {
  return ptpSource(model, dev, ctx) || ntpSource(model, dev, ctx);
}
