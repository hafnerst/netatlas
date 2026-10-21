/**
 * One engine for network policy (model/net-policy.ts), used by the path
 * tracer, the communication checks and the simulation alike:
 *
 *   explicit  a device's `policy:`: its ordered rules, first match wins,
 *             else its explicit default action; stateful as written (a
 *             firewall: its sessions unless written otherwise; anything
 *             else stateless);
 *   implicit  a firewall without a `policy:`: the model's relations through
 *             it (each permits its protocol's port between its devices,
 *             both ways) and its `allow` list (a service from anywhere to
 *             anywhere), default deny — as before, now evaluated here.
 *
 * Static analysis evaluates the rules for one direction and service; the
 * simulation evaluates them for each packet and keeps a stateful policy's
 * sessions (analysis/sim/transport.ts), so a return decision is the
 * simulation's, never claimed statically. Domain separation (a Security
 * gateway) and an IDS/IPS's inspection stay their own. Pure.
 */
import { capabilities } from '../model/capabilities';
import { IpAddr, parseAddress, parsePrefix } from '../model/ip';
import { NetPolicy, PolicyRule, policyRuleText, portInSpec } from '../model/net-policy';
import { protocolBase } from '../model/protocols';
import { simProfile } from '../model/sim-profiles';
import { Device, Model, deviceInterfaces, ifaceKey, relationDevices } from '../model/types';
import { compareAddr, inPrefix, networkOf } from './ipmath';
import { autoIpv6 } from '../model/ipv6';
import { RoutingCtx, connectedIn } from './routing';
import { parsePorts, portsMatch } from './sim/params';

/** One direction of a flow as a policy sees it. */
export interface PolicyFlow {
  /** none: not known (rules by source can't decide) */
  src?: IpAddr;
  dst: IpAddr;
  proto: 'tcp' | 'udp' | 'icmp' | 'other';
  sport?: number;
  dport?: number;
  /** the devices that own the addresses (the implicit policy's relations are between devices; a device spec names its owner) */
  srcDev?: string | null;
  dstDev?: string | null;
  /** where a device or interface spec finds its addresses (none: the configured model's) */
  ids?: PolicyIds;
  /** the device's interfaces it comes in at and leaves by */
  inIface?: string;
  outIface?: string;
}

export interface PolicyDecision {
  permit: boolean;
  /** "fw permits tcp/443 …: rule 2 (permit tcp any → web dport 443)" */
  text: string;
  /** the rule that decided (1-based); none: the default action */
  rule?: number;
  ruleText?: string;
  kind: 'explicit' | 'implicit';
  /** the default action decided */
  byDefault: boolean;
  /**
   * no decision: what it waits for — the source address (none given), the service (none given), or the
   * runtime identity of a device or interface a rule names (an address it takes at runtime, or one several
   * devices have); `permit` then says nothing (undecided)
   */
  undecidedBy?: PolicyUnknown;
}

/** What an undecided policy decision lacks. */
export type PolicyUnknown = 'source' | 'service' | 'identity';

/** Does a device apply a policy, and which? */
export function policyKind(model: Model, dev: Device): 'explicit' | 'implicit' | null {
  if (dev.policy) return 'explicit';
  return capabilities(dev).firewallPolicy ? 'implicit' : null;
}

/** Is a device's policy stateful (its replies pass by the session): as written, else a firewall's sessions (`fwStateful`), else not. */
export function policyStateful(dev: Device, fwStateful: boolean): boolean {
  if (dev.policy && dev.policy.stateful !== undefined) return dev.policy.stateful;
  return capabilities(dev).firewallPolicy ? fwStateful : false;
}

const svcWhat = (f: PolicyFlow): string => (f.proto === 'icmp' ? 'ICMP' : f.proto === 'other' ? 'the traffic' : `${f.proto}/${f.dport || 0}`);

/**
 * Where a policy's device and interface specs find their addresses — one
 * meaning for the configured model, a frozen snapshot and the live
 * simulation: the addresses a device holds there (configured, and acquired:
 * a DHCP lease, SLAAC, DHCPv6 — usable now, each with its interface), and,
 * in the configured model only, the interfaces that take an address at
 * runtime it does not know. Acquired state is never copied into the model.
 */
export interface PolicyIds {
  addrs(dev: string): Array<{ iface: string; addr: IpAddr }>;
  /** the devices that have an address (several: which one a flow's address is needs its owner) */
  holders?(a: IpAddr): string[];
  /** interfaces whose address of a family is acquired at runtime and unknown here (none: everything is known) */
  pending?(dev: string): Array<{ iface: string; version: 4 | 6 }>;
}

/** The devices of a model that have an address, by the addresses `ids` gives them. */
function holdersBy(model: Model, addrs: PolicyIds['addrs']): (a: IpAddr) => string[] {
  return (a) => model.devices.filter((d) => addrs(d.id).some((x) => compareAddr(x.addr, a) === 0)).map((d) => d.id);
}

/** The configured model's: the written addresses; DHCP and SLAAC / DHCPv6 interfaces are pending. */
export function configuredIds(model: Model, ctx?: RoutingCtx): PolicyIds {
  void ctx;
  const ids: PolicyIds = {
    addrs: (dev) => {
      const d = model.index.devices.get(dev);
      const out: Array<{ iface: string; addr: IpAddr }> = [];
      for (const i of d ? deviceInterfaces(d) : []) for (const t of i.addresses) {
        const x = parseAddress(t.split('/')[0]);
        if (x) out.push({ iface: i.id, addr: x });
      }
      return out;
    },
    pending: (dev) => {
      const d = model.index.devices.get(dev);
      const out: Array<{ iface: string; version: 4 | 6 }> = [];
      for (const i of d ? deviceInterfaces(d) : []) {
        if (i.dhcp) out.push({ iface: i.id, version: 4 });
        if (autoIpv6(i.ipv6)) out.push({ iface: i.id, version: 6 });
      }
      return out;
    },
  };
  ids.holders = holdersBy(model, ids.addrs);
  return ids;
}

/** A routing context's (a snapshot's, the simulation's): the written addresses and what it has acquired (its leases); nothing pending. */
export function ctxIds(model: Model, ctx: RoutingCtx): PolicyIds {
  const addrs = (dev: string): Array<{ iface: string; addr: IpAddr }> => connectedIn(model, dev, ctx).map((c) => ({ iface: c.iface, addr: c.addr }));
  return { addrs, holders: holdersBy(model, addrs) };
}

/**
 * Does an address spec (a prefix, an address, any, a device, a network,
 * device:interface) hold an address: true, false, or 'unknown' when a
 * device or interface spec names one that takes an address at runtime the
 * analysis does not know and nothing says the address is someone else's.
 * A device or interface holds the address among its effective ones
 * (`ids`, the configured model's when none) — never a whole subnet — and,
 * when the flow knows the address's owner (`owner`: two devices of
 * different VRFs may hold the same address), only if it is that owner; an
 * address several devices have, its owner not known, is 'unknown' — never
 * every device that has it. A prefix or an address rule is the address.
 */
export function specMatches(model: Model, spec: string, a: IpAddr, ids?: PolicyIds, owner?: string | null): boolean | 'unknown' {
  if (spec === 'any') return true;
  const p = parsePrefix(spec, false);
  if (p) return spec.indexOf('/') >= 0 ? inPrefix(networkOf(p), a) : compareAddr(p, a) === 0;
  const by = ids || configuredIds(model);
  const owns = (dev: string, iface?: string): boolean | 'unknown' => {
    if (owner && owner !== dev) return false;
    if (by.addrs(dev).some((x) => (iface === undefined || x.iface === iface) && compareAddr(x.addr, a) === 0)) {
      // an address several devices have, its owner not known: it is not every one of them
      if (!owner && by.holders && by.holders(a).length > 1) return 'unknown';
      return true;
    }
    // an address it takes at runtime, unknown here: not a non-match unless the address is known to be another device's
    if (!owner && by.pending && by.pending(dev).some((x) => (iface === undefined || x.iface === iface) && x.version === a.version)) return 'unknown';
    return false;
  };
  if (model.index.devices.has(spec)) return owns(spec);
  const n = model.index.networks.get(spec);
  if (n) {
    const np = n.cidr ? parsePrefix(n.cidr) : null;
    return !!np && inPrefix(networkOf(np), a);
  }
  const c = spec.indexOf(':');
  if (c > 0 && model.index.interfaces.has(ifaceKey(spec.slice(0, c), spec.slice(c + 1)))) return owns(spec.slice(0, c), spec.slice(c + 1));
  return false;
}

/** Does one of a rule's specs hold an address: true, false, or 'unknown' (none true, one unknown). */
function anyMatches(model: Model, specs: string[], a: IpAddr, ids: PolicyIds | undefined, owner: string | null | undefined): boolean | 'unknown' {
  let unknown = false;
  for (const s of specs) {
    const m = specMatches(model, s, a, ids, owner);
    if (m === true) return true;
    if (m === 'unknown') unknown = true;
  }
  return unknown ? 'unknown' : false;
}

/** Does a rule match a flow: true, false, or 'service' when it depends on a protocol or port that is not known. */
/**
 * Does a rule match a flow: true, false, or what it can't be decided without. Every condition that is known
 * not to hold is checked first — a known protocol or port that differs makes the rule not match whatever is
 * unknown —; only then does an unknown one (the source, the service, a runtime identity) leave it undecided.
 */
function ruleMatches(model: Model, pol: NetPolicy, r: PolicyRule, f: PolicyFlow, svcKnown: boolean): boolean | PolicyUnknown {
  if (r.in.length && (f.inIface === undefined || r.in.indexOf(f.inIface) < 0)) return false;
  if (r.out.length && (f.outIface === undefined || r.out.indexOf(f.outIface) < 0)) return false;
  const inZone = (z: string, i: string | undefined): boolean => i !== undefined && pol.zones.some((x) => x.name === z && x.interfaces.indexOf(i) >= 0);
  if (r.fromZone !== undefined && !inZone(r.fromZone, f.inIface)) return false;
  if (r.toZone !== undefined && !inZone(r.toZone, f.outIface)) return false;
  const unknown: PolicyUnknown[] = [];
  // (a device or interface by its effective addresses; one whose runtime identity is not known decides nothing)
  if (r.destination.length) {
    const m = anyMatches(model, r.destination, f.dst, f.ids, f.dstDev);
    if (m === false) return false;
    if (m === 'unknown') unknown.push('identity');
  }
  if (r.source.length) {
    if (!f.src) unknown.push('source');
    else {
      const m = anyMatches(model, r.source, f.src, f.ids, f.srcDev);
      if (m === false) return false;
      if (m === 'unknown') unknown.push('identity');
    }
  }
  const service = !(r.proto === 'any' && r.sport === undefined && r.dport === undefined);
  if (service) {
    if (!svcKnown) unknown.push('service');
    else {
      if (r.proto !== 'any' && r.proto !== f.proto) return false;
      if (r.dport !== undefined && (f.dport === undefined || !portInSpec(r.dport, f.dport))) return false;
      if (r.sport !== undefined && (f.sport === undefined || !portInSpec(r.sport, f.sport))) return false;
    }
  }
  // (what is missing first, in the order a user can supply it: a source, a service; then a runtime identity)
  for (const k of ['source', 'service', 'identity'] as PolicyUnknown[]) if (unknown.indexOf(k) >= 0) return k;
  return true;
}

/** The transport and ports of a relation's protocol ("TCP 443", "UDP 1812/1813"), or none. */
export function relationTransport(model: Model, protocol: string): { proto: string; ports: number[] } | null {
  const p = simProfile(protocolBase(model.protocols, protocol));
  const m = p ? /\b(TCP|UDP)\s+([0-9]{1,5})((?:\s*\/\s*[0-9]{1,5})*)/.exec(p.proto) : null;
  if (!m) return null;
  const ports = [Number(m[2])].concat((m[3] || '').split('/').map((y) => y.trim()).filter((y) => y).map(Number));
  return { proto: m[1].toLowerCase(), ports };
}

/** The relation of the model that permits a service between two devices through a firewall's implicit policy (either way), or null. */
export function relationPermitting(model: Model, a: string | null | undefined, b: string | null | undefined, proto: string, port: number): string | null {
  if (!a || !b || (proto !== 'tcp' && proto !== 'udp')) return null;
  for (const r of model.relations.slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    const devs = relationDevices(r);
    if (devs.indexOf(a) < 0 || devs.indexOf(b) < 0) continue;
    const t = relationTransport(model, r.protocol);
    if (t && t.proto === proto && t.ports.indexOf(port) >= 0) return r.id;
  }
  return null;
}

/** A firewall's allow list (its `allow` simulation attribute), as written and parsed. */
export function allowList(dev: Device): { raw: string; list: ReturnType<typeof parsePorts> } {
  const raw = dev.simulation ? dev.simulation.get('fw-allow') : undefined;
  const text = raw === undefined ? 'none' : String(raw) || 'none';
  return { raw: raw === undefined ? '' : String(raw), list: parsePorts(text) };
}

/**
 * The policy's decision on a flow at a device (see the module comment), or
 * null when the device applies no policy. `svcKnown` false: the protocol
 * and ports are not known (a trace without a service): a decision that
 * depends on them says so instead of guessing.
 */
export function policyDecision(model: Model, dev: Device, f: PolicyFlow, svcKnown = true): PolicyDecision | null {
  const kind = policyKind(model, dev);
  if (!kind) return null;
  const what = svcWhat(f);
  const between = (f.srcDev ? ` from ${f.srcDev}` : '') + (f.dstDev ? ` to ${f.dstDev}` : '');
  if (kind === 'explicit') {
    const pol = dev.policy as NetPolicy;
    for (let k = 0; k < pol.rules.length; k++) {
      const r = pol.rules[k];
      const m = ruleMatches(model, pol, r, f, svcKnown);
      if (m === false) continue;
      if (m === 'service' || m === 'source') return { permit: true, text: `${dev.id}’s policy decides by ${m === 'service' ? 'the service' : 'the source address'} at rule ${k + 1} (${policyRuleText(r)}): give ${m === 'service' ? 'a service' : 'a source'} to evaluate it`, kind, byDefault: false, rule: -(k + 1), undecidedBy: m };
      if (m === 'identity') return { permit: true, text: `${dev.id}’s policy decides at rule ${k + 1} (${policyRuleText(r)}) by which device an address is: one taken at runtime (DHCP, SLAAC) that the configured model does not know, or one several devices have — analyze a simulation snapshot, or name the address`, kind, byDefault: false, rule: -(k + 1), undecidedBy: m };
      return { permit: r.action === 'permit', text: `${dev.id} ${r.action === 'permit' ? 'permits' : 'denies'} ${what}${between}: rule ${k + 1} (${policyRuleText(r)})`, rule: k + 1, ruleText: policyRuleText(r), kind, byDefault: false };
    }
    return { permit: pol.default === 'permit', text: `${dev.id} ${pol.default === 'permit' ? 'permits' : 'denies'} ${what}${between}: no rule matches (its default action, ${pol.default})`, kind, byDefault: true };
  }
  // the implicit policy of a firewall: its relations, its allow list, default deny
  if (!svcKnown) return { permit: true, text: `${dev.id} filters what it forwards (the relations through it, its allow list): give a service to trace its decision`, kind, byDefault: false, rule: -1, undecidedBy: 'service' };
  if (f.proto !== 'icmp' && f.proto !== 'other') {
    const rel = relationPermitting(model, f.srcDev, f.dstDev, f.proto, f.dport || 0);
    if (rel) {
      const r = model.index.relations.get(rel);
      return { permit: true, text: `${dev.id} permits ${what}${between}: the relation ${rel} (${r ? r.protocol : ''})`, kind, byDefault: false, ruleText: `relation ${rel}` };
    }
  }
  const allow = allowList(dev);
  if ('list' in allow.list && portsMatch(allow.list.list, f.proto === 'other' ? 'udp' : f.proto, f.proto === 'icmp' ? 0 : f.dport || 0) && f.proto !== 'other') return { permit: true, text: `${dev.id} permits ${what}: its allow list (${allow.raw})`, kind, byDefault: false, ruleText: `allow ${what}` };
  return { permit: false, text: `${dev.id} denies ${what}${between}: no relation of the model between them and no allow entry permits it (its default action)`, kind, byDefault: true };
}

/** Is a decision one that waits for something (a service, a source, a runtime identity): no decision? */
export function undecided(d: PolicyDecision | null): boolean {
  return !!d && d.undecidedBy !== undefined;
}
