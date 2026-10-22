/**
 * A device's network policy (`policy:`): one ordered Layer 3/4 rule base for
 * routers (an ACL), Layer 3 switches and firewalls, evaluated by one engine
 * (analysis/policy.ts) for the path tracer, the communication checks and
 * the simulation:
 *
 *   default   the explicit default action (permit or deny): required;
 *   stateful  replies of a permitted flow pass back without a rule of their
 *             own (a firewall's sessions); stateless, each direction needs
 *             its rule. Without it: a firewall is stateful (its
 *             `fw-stateful` simulation attribute), anything else stateless;
 *   zones     named sets of the device's interfaces, for rules by zone;
 *   rules     first match wins: action, and optionally source and
 *             destination (prefixes, addresses, devices, networks,
 *             device:interface, `any`), proto (tcp, udp, icmp, any), sport
 *             and dport (ports and ranges: "443", "8000-8080", "80,443"),
 *             in and out (interfaces), from_zone and to_zone.
 *
 * A firewall without a `policy:` keeps its implicit policy (the relations
 * through it and its `allow` list, default deny), evaluated by the same
 * engine. A Security gateway's Domain separation stays its own (it has no
 * `policy:`). Not modeled: application identification, TLS inspection,
 * user identities, time ranges, NAT rules (the NAT service's), vendor rule
 * syntax. Pure types.
 */

/** The keys of a policy, of a rule and of a zone, in the order they are written. */
export const POLICY_KEYS: readonly string[] = ['default', 'stateful', 'zones', 'rules'];
export const POLICY_RULE_KEYS: readonly string[] = ['name', 'action', 'source', 'destination', 'proto', 'sport', 'dport', 'in', 'out', 'from_zone', 'to_zone'];
export const POLICY_ZONE_KEYS: readonly string[] = ['name', 'interfaces'];
export const POLICY_PROTOS: readonly string[] = ['any', 'tcp', 'udp', 'icmp'];

export interface PolicyRule {
  name?: string;
  action: 'permit' | 'deny';
  /** prefixes, addresses, device ids, network ids, device:interface, any (none: any) */
  source: string[];
  destination: string[];
  proto: 'any' | 'tcp' | 'udp' | 'icmp';
  /** port specs ("443", "8000-8080", "80,443"); none: any */
  sport?: string;
  dport?: string;
  /** the device's interfaces it comes in at, leaves by (none: any) */
  in: string[];
  out: string[];
  fromZone?: string;
  toZone?: string;
  line: number;
}

export interface NetPolicy {
  default: 'permit' | 'deny';
  /** written: as written; none: a firewall's sessions, else stateless */
  stateful?: boolean;
  zones: Array<{ name: string; interfaces: string[] }>;
  rules: PolicyRule[];
  line: number;
}

/** Does a port spec ("443", "8000-8080", "80,443") hold a port? */
export function portInSpec(spec: string, port: number): boolean {
  for (const part of spec.split(',')) {
    const t = part.trim();
    const m = /^([0-9]{1,5})(?:\s*-\s*([0-9]{1,5}))?$/.exec(t);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : lo;
    if (port >= lo && port <= hi) return true;
  }
  return false;
}

/** What is wrong with a port spec, or null. */
export function portSpecProblem(spec: string): string | null {
  for (const part of spec.split(',')) {
    const m = /^\s*([0-9]{1,5})(?:\s*-\s*([0-9]{1,5}))?\s*$/.exec(part);
    if (!m) return `"${part.trim()}" is no port or range (443, 8000-8080)`;
    const lo = Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : lo;
    if (lo < 1 || hi > 65535 || lo > hi) return `"${part.trim()}" is out of 1–65535 or reversed`;
  }
  return null;
}

/** A rule in words: "permit tcp 10.1.0.0/16 → web dport 443 (in lan)". */
export function policyRuleText(r: PolicyRule): string {
  const ends = `${r.source.length ? r.source.join(', ') : 'any'} → ${r.destination.length ? r.destination.join(', ') : 'any'}`;
  const ports = [r.sport ? 'sport ' + r.sport : '', r.dport ? 'dport ' + r.dport : ''].filter((x) => x).join(' ');
  const where = [r.in.length ? 'in ' + r.in.join(',') : '', r.out.length ? 'out ' + r.out.join(',') : '', r.fromZone ? 'from zone ' + r.fromZone : '', r.toZone ? 'to zone ' + r.toZone : ''].filter((x) => x).join(', ');
  return `${r.name ? r.name + ': ' : ''}${r.action} ${r.proto === 'any' ? '' : r.proto + ' '}${ends}${ports ? ' ' + ports : ''}${where ? ` (${where})` : ''}`;
}
