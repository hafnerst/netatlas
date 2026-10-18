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
import { parsePorts, portsMatch } from './sim/params';

/** One direction of a flow as a policy sees it. */
export interface PolicyFlow {
  /** none: not known (rules by source can't decide) */
  src?: IpAddr;
  dst: IpAddr;
  proto: 'tcp' | 'udp' | 'icmp' | 'other';
  sport?: number;
  dport?: number;
  /** the devices that own the addresses (the implicit policy's relations are between devices) */
  srcDev?: string | null;
  dstDev?: string | null;
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
}

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

/** Does an address spec (a prefix, an address, any, a device, a network, device:interface) hold an address? */
export function specMatches(model: Model, spec: string, a: IpAddr): boolean {
  if (spec === 'any') return true;
  const p = parsePrefix(spec, false);
  if (p) return spec.indexOf('/') >= 0 ? inPrefix(networkOf(p), a) : compareAddr(p, a) === 0;
  const owns = (dev: string, iface?: string): boolean => {
    const d = model.index.devices.get(dev);
    for (const i of d ? deviceInterfaces(d) : []) {
      if (iface !== undefined && i.id !== iface) continue;
      for (const t of i.addresses) {
        const x = parseAddress(t.split('/')[0]);
        if (x && compareAddr(x, a) === 0) return true;
      }
    }
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

/** Does a rule match a flow: true, false, or 'service' when it depends on a protocol or port that is not known. */
function ruleMatches(model: Model, pol: NetPolicy, r: PolicyRule, f: PolicyFlow, svcKnown: boolean): boolean | 'service' | 'source' {
  if (r.in.length && (f.inIface === undefined || r.in.indexOf(f.inIface) < 0)) return false;
  if (r.out.length && (f.outIface === undefined || r.out.indexOf(f.outIface) < 0)) return false;
  const inZone = (z: string, i: string | undefined): boolean => i !== undefined && pol.zones.some((x) => x.name === z && x.interfaces.indexOf(i) >= 0);
  if (r.fromZone !== undefined && !inZone(r.fromZone, f.inIface)) return false;
  if (r.toZone !== undefined && !inZone(r.toZone, f.outIface)) return false;
  if (r.destination.length && !r.destination.some((s) => specMatches(model, s, f.dst))) return false;
  if (r.source.length) {
    if (!f.src) return 'source';
    if (!r.source.some((s) => specMatches(model, s, f.src as IpAddr))) return false;
  }
  if (r.proto === 'any' && r.sport === undefined && r.dport === undefined) return true;
  if (!svcKnown) return 'service';
  if (r.proto !== 'any' && r.proto !== f.proto) return false;
  if (r.dport !== undefined && (f.dport === undefined || !portInSpec(r.dport, f.dport))) return false;
  if (r.sport !== undefined && (f.sport === undefined || !portInSpec(r.sport, f.sport))) return false;
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
      if (m === 'service' || m === 'source') return { permit: true, text: `${dev.id}’s policy decides by ${m === 'service' ? 'the service' : 'the source address'} at rule ${k + 1} (${policyRuleText(r)}): give ${m === 'service' ? 'a service' : 'a source'} to evaluate it`, kind, byDefault: false, rule: -(k + 1) };
      return { permit: r.action === 'permit', text: `${dev.id} ${r.action === 'permit' ? 'permits' : 'denies'} ${what}${between}: rule ${k + 1} (${policyRuleText(r)})`, rule: k + 1, ruleText: policyRuleText(r), kind, byDefault: false };
    }
    return { permit: pol.default === 'permit', text: `${dev.id} ${pol.default === 'permit' ? 'permits' : 'denies'} ${what}${between}: no rule matches (its default action, ${pol.default})`, kind, byDefault: true };
  }
  // the implicit policy of a firewall: its relations, its allow list, default deny
  if (!svcKnown) return { permit: true, text: `${dev.id} filters what it forwards (the relations through it, its allow list): give a service to trace its decision`, kind, byDefault: false, rule: -1 };
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

/** Is a decision one that waits for a service or a source (not a decision)? */
export function undecided(d: PolicyDecision | null): boolean {
  return !!d && d.rule !== undefined && d.rule < 0;
}
