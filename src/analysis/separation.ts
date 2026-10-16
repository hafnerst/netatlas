/**
 * Domain separation: what a Separation gateway lets across its boundary.
 *
 * A Separation gateway has exactly two named domains, each with its data
 * interfaces, the permitted directions of transfer (from one domain to the
 * other, one or both) and ordered allow rules. Everything else is denied in
 * both directions: an empty policy permits nothing, and no field is ever
 * taken as "any" unless it says `any`.
 *
 * Semantics, shared by the path tracer, the single-point-of-failure analysis
 * and the simulation:
 *   - a transfer is started in one domain and goes to the other: its
 *     direction must be permitted, then the first rule (in the written order)
 *     whose domains, source, destination, protocol and destination ports
 *     match permits it; no match denies it;
 *   - the replies of a permitted transfer go back (the TCP handshake and
 *     answers, a DNS answer, an ICMP echo reply): a reply is not a transfer
 *     of its own. Starting a transfer the other way needs its own direction
 *     and rule; a bidirectional setting opens nothing by itself;
 *   - management interfaces belong to no domain: nothing is forwarded to or
 *     from them;
 *   - a filtering bridge passes the permitted frames between its domains'
 *     interfaces unchanged (ARP between the domains passes, so permitted
 *     transfers can resolve their neighbours; no other non-IP frame does);
 *     a filtering router routes the permitted packets; a protocol break
 *     forwards nothing: a permitted transfer ends at the gateway (at a
 *     transfer profile's listening port) and the gateway starts a new one
 *     of its own on the other side. Its rules match the new transfer's
 *     destination (the profile's forward address and port) and the
 *     original source.
 *
 * NetAtlas models these semantics; it does not reproduce a particular
 * product or give any assurance of a real device's separation.
 */
import { Device, SeparationDomain, SeparationRule, SeparationService, TRANSFER_PROFILES, TransferProfile } from '../model/types';
import { IpAddr, parseAddress, parsePrefix } from '../model/ip';
import { inPrefix } from './ipmath';

/** What a transfer is, as far as the policy sees it. */
export interface TransferFacts {
  /** the interface it came in on and the one it would leave by (a protocol break: its listening interface, and none) */
  inIface: string;
  outIface?: string;
  /** the destination domain when no out interface is known (a protocol break: the other domain) */
  toDomain?: string;
  src: IpAddr;
  dst: IpAddr;
  /** tcp, udp, icmp; anything else is 'other' */
  proto: 'tcp' | 'udp' | 'icmp' | 'other';
  /** tcp / udp: the destination port */
  dport?: number;
}

export type SepDecision =
  | { ok: true; rule: SeparationRule; from: string; to: string; text: string }
  | { ok: false; from?: string; to?: string; text: string };

/** The domain an interface belongs to (none: a management interface, or one assigned to no domain). */
export function domainOf(sep: SeparationService, iface: string): SeparationDomain | undefined {
  return sep.domains.find((d) => d.interfaces.indexOf(iface) >= 0);
}

/** The other one of the two domains. */
export function otherDomain(sep: SeparationService, name: string): SeparationDomain | undefined {
  return sep.domains.find((d) => d.name !== name);
}

/** Is a transfer from one domain to the other permitted as a direction? */
export function directionPermitted(sep: SeparationService, from: string, to: string): boolean {
  return sep.directions.some((d) => d.from === from && d.to === to);
}

/** Does an address match a rule's `any`, address or prefix? */
export function addressMatches(spec: string, a: IpAddr): boolean {
  if (spec === 'any') return true;
  const p = parsePrefix(spec, false);
  return !!p && p.version === a.version && inPrefix(p, a);
}

/** Does a port match a rule's ports ("any", "443", "80, 443", "8000-8080")? */
export function portMatches(spec: string | undefined, port: number | undefined): boolean {
  if (spec === undefined || port === undefined) return false;
  if (spec.trim() === 'any') return true;
  return spec.split(',').some((part) => {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) return false;
    const lo = Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : lo;
    return port >= lo && port <= hi;
  });
}

/** Does a rule match a transfer between two domains? */
export function ruleMatches(rule: SeparationRule, from: string, to: string, t: TransferFacts): boolean {
  if (rule.from !== from || rule.to !== to) return false;
  if (!addressMatches(rule.source, t.src) || !addressMatches(rule.destination, t.dst)) return false;
  if (rule.protocol === 'any') return true;
  if (rule.protocol !== t.proto) return false;
  if (t.proto === 'tcp' || t.proto === 'udp') return portMatches(rule.ports, t.dport);
  return true;
}

/** "tcp 443", "udp 53", "icmp", "any protocol" */
export function ruleServiceText(rule: SeparationRule): string {
  if (rule.protocol === 'any') return 'any protocol';
  return rule.ports !== undefined ? `${rule.protocol} ${rule.ports}` : rule.protocol;
}

/** A rule in words: "rule nfs: Campus → Storage, 10.0.20.0/24 to 10.0.20.10, tcp 2049". */
export function ruleText(rule: SeparationRule): string {
  return `rule ${rule.id}: ${rule.from} → ${rule.to}, ${rule.source} to ${rule.destination}, ${ruleServiceText(rule)}${rule.profile ? ` (profile ${rule.profile})` : ''}`;
}

/**
 * Is a transfer permitted? Checked in order: both interfaces in domains
 * (and different ones), the direction, then the rules in their written
 * order; nothing matching is the default deny.
 */
export function decide(dev: Device, t: TransferFacts): SepDecision {
  const sep = dev.separation;
  if (!sep || !sep.implementation) return { ok: false, text: `${dev.id} has no complete Domain separation configuration: it transfers nothing` };
  const fromD = domainOf(sep, t.inIface);
  if (!fromD) return { ok: false, text: `${dev.id}:${t.inIface} is in neither domain (${sep.domains.map((d) => d.name).join(', ')}): nothing is transferred from it` };
  let to: string | undefined = t.toDomain;
  if (t.outIface !== undefined) {
    const toD = domainOf(sep, t.outIface);
    if (!toD) return { ok: false, from: fromD.name, text: `${dev.id}:${t.outIface} is in neither domain: nothing is transferred to it` };
    to = toD.name;
  }
  if (to === undefined) {
    const o = otherDomain(sep, fromD.name);
    to = o ? o.name : undefined;
  }
  if (to === undefined) return { ok: false, from: fromD.name, text: `${dev.id} has only one domain` };
  if (to === fromD.name) return { ok: false, from: fromD.name, to, text: `${dev.id} transfers between its two domains only: ${t.inIface} and ${t.outIface} are both in ${fromD.name}` };
  if (!directionPermitted(sep, fromD.name, to)) return { ok: false, from: fromD.name, to, text: `${dev.id}: ${fromD.name} → ${to} is not a permitted direction (permitted: ${sep.directions.map((d) => `${d.from} → ${d.to}`).join(', ') || 'none'})` };
  for (const rule of sep.rules) {
    if (ruleMatches(rule, fromD.name, to, t)) return { ok: true, rule, from: fromD.name, to, text: `${dev.id} permits it: ${ruleText(rule)}` };
  }
  return { ok: false, from: fromD.name, to, text: `${dev.id} denies it: no rule permits it ${fromD.name} → ${to} (${sep.rules.length ? 'the rules are checked in order, then everything else is denied' : 'it has no rules: an empty policy permits nothing'})` };
}

/** The rules that could permit something from a source to a destination one way, in order (a trace without a service shows them). */
export function rulesBetween(dev: Device, inIface: string, outIface: string | undefined, src: IpAddr, dst: IpAddr): SeparationRule[] {
  const sep = dev.separation;
  if (!sep || !sep.implementation) return [];
  const fromD = domainOf(sep, inIface);
  const toD = outIface !== undefined ? domainOf(sep, outIface) : fromD ? otherDomain(sep, fromD.name) : undefined;
  if (!fromD || !toD || fromD.name === toD.name || !directionPermitted(sep, fromD.name, toD.name)) return [];
  return sep.rules.filter((r) => r.from === fromD.name && r.to === toD.name && addressMatches(r.source, src) && addressMatches(r.destination, dst));
}

/** A protocol break's profile that listens at an interface and port, with its kind. */
export function profileAt(dev: Device, iface: string, proto: 'tcp' | 'udp', port: number): { profile: TransferProfile; kind: (typeof TRANSFER_PROFILES)[number] } | undefined {
  const sep = dev.separation;
  if (!sep || sep.implementation !== 'protocol_break') return undefined;
  for (const p of sep.profiles) {
    const kind = TRANSFER_PROFILES.find((k) => k.id === p.type);
    if (!kind || kind.transport !== proto || p.listenInterface !== iface || p.listenPort !== port) continue;
    return { profile: p, kind };
  }
  return undefined;
}

/**
 * A protocol break's decision on a transfer that reached one of its
 * listening ports: permitted when a rule using the profile matches the
 * original source and the new transfer's destination (the profile's
 * forward address and port).
 */
export function decideBreak(dev: Device, inIface: string, src: IpAddr, profile: TransferProfile): SepDecision & { forward?: { address: IpAddr; port: number } } {
  const sep = dev.separation as SeparationService;
  const kind = TRANSFER_PROFILES.find((k) => k.id === profile.type);
  const fwd = profile.forwardAddress !== undefined ? parseAddress(profile.forwardAddress) : null;
  if (!kind || !fwd || profile.forwardPort === undefined) return { ok: false, text: `${dev.id}: transfer profile ${profile.id} is incomplete or of a kind NetAtlas can't model, so nothing is transferred (a limitation, not a success)` };
  const d = decide(dev, { inIface, src, dst: fwd, proto: kind.transport, dport: profile.forwardPort });
  if (!d.ok) return d;
  if (d.rule.profile !== profile.id) {
    // a rule for another profile matched first: look on for one of this profile
    const fromD = domainOf(sep, inIface) as SeparationDomain;
    const rule = sep.rules.find((r) => r.profile === profile.id && ruleMatches(r, fromD.name, d.to, { inIface, src, dst: fwd, proto: kind.transport, dport: profile.forwardPort }));
    if (!rule) return { ok: false, from: d.from, to: d.to, text: `${dev.id} denies it: no rule permits transfer profile ${profile.id} from ${d.from} to ${d.to} for this source` };
    return { ok: true, rule, from: d.from, to: d.to, text: `${dev.id} permits it: ${ruleText(rule)}`, forward: { address: fwd, port: profile.forwardPort } };
  }
  return { ...d, forward: { address: fwd, port: profile.forwardPort } };
}

/** The lines of a Separation gateway's summary (the Details panel and its tooltip): implementation, domains, directions, rules. */
export function separationSummary(dev: Device): string[] {
  const sep = dev.separation;
  if (!sep) return [];
  const impl = sep.implementation ? sep.implementation.replace(/_/g, ' ') : 'implementation not chosen (it transfers nothing)';
  const out = [`Implementation: ${impl}`];
  for (const d of sep.domains) out.push(`Domain ${d.name}: ${d.interfaces.join(', ') || 'no interfaces'}`);
  if (dev.management.length) out.push(`Management (no domain, never forwarded): ${dev.management.join(', ')}`);
  out.push(`Permitted directions: ${sep.directions.map((d) => `${d.from} → ${d.to}`).join(', ') || 'none'}`);
  if (!sep.rules.length) out.push('Rules: none (an empty policy permits nothing)');
  sep.rules.forEach((r, i) => out.push(`${i + 1}. ${ruleText(r).replace(/^rule /, '')}${r.description ? ' — ' + r.description : ''}`));
  out.push('Everything else: denied');
  return out;
}
