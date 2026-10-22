/**
 * The bounded routing-policy subset NetAtlas models, per device and routing
 * protocol (in the protocol's block of the device's `protocols:`), applied
 * alike by the path tracer and the simulation (analysis/routing.ts):
 *
 *   advertise       the prefixes the device originates into the protocol,
 *                   instead of every connected network (each must exist on
 *                   the device as a connected network or a static route:
 *                   a network statement);
 *   default_route   originate a default route: `always`, or `if_installed`
 *                   (only while the device has one of its own);
 *   redistribute    other sources whose routes the device originates into
 *                   the protocol: connected, static (a static route whose
 *                   next hop is on a connected network or an exit
 *                   interface), or another routing protocol's routes. Each
 *                   route keeps its origin history: one is never
 *                   redistributed into a protocol it already came through
 *                   (no redistribution loop);
 *   import, export  ordered prefix filters, first match wins, an implicit
 *                   deny at the end: `{action: permit|deny, prefix:
 *                   10.0.0.0/8, ge: 16, le: 24, peer: r2}`. A rule without
 *                   a prefix matches every route; with one, a route inside
 *                   it of exactly its length, or of a length from `ge` to
 *                   `le`. `peer` limits a rule to one neighbour. BGP adds
 *                   `local_pref` (import: the route's local preference)
 *                   and `prepend` (export: the device's AS added that many
 *                   more times). Export filters apply to what a device
 *                   advertises to a neighbour (BGP, EIGRP, RIP); a link-
 *                   state protocol (OSPF, IS-IS) floods what it learns, so
 *                   it has no export filter, and its `import:` filter only
 *                   decides what the device installs.
 *
 * BGP selection: the highest local preference (100 by default; eBGP
 * resets it), then the shortest AS path, then the lowest cost; a route
 * whose AS path holds the receiver's AS is refused (loop prevention). Not
 * modeled: route maps beyond these matches and sets, communities, MED,
 * route reflection, iBGP split horizon, summarisation, areas. Pure.
 */
import { IpPrefix, parsePrefix } from './ip';

/** The routing protocols that take a policy. */
export const POLICY_PROTOCOLS: readonly string[] = ['bgp', 'eigrp', 'isis', 'ospf', 'rip'];

/** The keys of a routing protocol's policy, in the order they are written. */
export const ROUTE_POLICY_KEYS: readonly string[] = ['advertise', 'default_route', 'redistribute', 'import', 'export'];
/** The keys of one filter rule, in the order they are written. */
export const ROUTE_RULE_KEYS: readonly string[] = ['action', 'prefix', 'ge', 'le', 'peer', 'local_pref', 'prepend'];
/** The protocols that flood what they learn (no export filter; their `import:` filter decides what is installed). */
export const LINK_STATE: readonly string[] = ['ospf', 'isis'];
/** What a protocol may redistribute. */
export const REDISTRIBUTE_SOURCES: readonly string[] = ['connected', 'static', 'bgp', 'eigrp', 'isis', 'ospf', 'rip'];
/** The default local preference of a BGP route. */
export const DEFAULT_LOCAL_PREF = 100;

export interface RouteFilterRule {
  action: 'permit' | 'deny';
  /** "10.0.0.0/8" (none: every route) */
  prefix?: string;
  ge?: number;
  le?: number;
  /** a neighbour (device id): the rule applies to it only */
  peer?: string;
  /** BGP import: the local preference it gives */
  localPref?: number;
  /** BGP export: how many more times the device's AS is prepended */
  prepend?: number;
  line: number;
}

export interface RoutingPolicy {
  advertise?: string[];
  defaultRoute?: 'always' | 'if_installed';
  redistribute: string[];
  import: RouteFilterRule[];
  export: RouteFilterRule[];
}

/** Does a rule match a route (its prefix) from or to a neighbour? */
export function ruleMatches(rule: RouteFilterRule, net: IpPrefix, peer: string): boolean {
  if (rule.peer !== undefined && rule.peer !== peer) return false;
  if (rule.prefix === undefined) return true;
  const p = parsePrefix(rule.prefix);
  if (!p || p.version !== net.version || net.prefix < p.prefix) return false;
  // inside the rule's prefix
  let bits = p.prefix;
  for (let i = 0; i < p.bytes.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((p.bytes[i] & mask) !== (net.bytes[i] & mask)) return false;
  }
  if (rule.ge === undefined && rule.le === undefined) return net.prefix === p.prefix;
  const lo = rule.ge !== undefined ? rule.ge : p.prefix;
  const hi = rule.le !== undefined ? rule.le : p.version === 4 ? 32 : 128;
  return net.prefix >= lo && net.prefix <= hi;
}

/** A rule in words: "permit 10.0.0.0/8 le 24 from r2, local-pref 200". */
export function ruleText(rule: RouteFilterRule, dir: 'import' | 'export'): string {
  const m = rule.prefix === undefined ? 'any route' : `${rule.prefix}${rule.ge !== undefined ? ' ge ' + rule.ge : ''}${rule.le !== undefined ? ' le ' + rule.le : ''}`;
  const sets = [rule.localPref !== undefined ? `local-pref ${rule.localPref}` : '', rule.prepend !== undefined ? `prepend ${rule.prepend}` : ''].filter((x) => x);
  const towards = dir === 'import' ? 'from' : 'to';
  return `${rule.action} ${m}${rule.peer !== undefined ? ` ${towards} ${rule.peer}` : ''}${sets.length ? ', ' + sets.join(', ') : ''}`;
}

/** The decision of an ordered filter for a route: the first matching rule, else the implicit deny. */
export interface FilterDecision {
  permit: boolean;
  /** the rule's number (1-based), none for the implicit deny or no filter */
  rule?: number;
  text: string;
  localPref?: number;
  prepend?: number;
}

/** Filter a route (see the module comment): no rules permit everything. */
export function filterRoute(rules: RouteFilterRule[], net: IpPrefix, peer: string, dir: 'import' | 'export'): FilterDecision {
  if (!rules.length) return { permit: true, text: '' };
  for (let k = 0; k < rules.length; k++) {
    const r = rules[k];
    if (!ruleMatches(r, net, peer)) continue;
    const out: FilterDecision = { permit: r.action === 'permit', rule: k + 1, text: `${dir} rule ${k + 1} (${ruleText(r, dir)})` };
    if (r.localPref !== undefined) out.localPref = r.localPref;
    if (r.prepend !== undefined) out.prepend = r.prepend;
    return out;
  }
  return { permit: false, text: `${dir} filter: no rule matches (the implicit deny at the end)` };
}
