/**
 * The consistency checks beyond static routes and VLAN tagging: MTU,
 * speed and duplex, aggregates, addressing, router IDs and MAC addresses,
 * OSPF and BGP parameters, tunnels and VRFs. Each reads only what is
 * written; where a value it compares is missing, it says nothing.
 *
 * Protocol parameters are relation `attrs` (the core model does not change
 * per protocol). A value for one endpoint is written keyed by its device:
 * `area: {r1: 0.0.0.1, r2: 0.0.0.2}` (flattened to "area.r1", "area.r2");
 * a single value is the same at both ends, so it can't disagree.
 */
import { IpAddr, parseAddress, parsePrefix } from '../model/ip';
import { protocolBase } from '../model/protocols';
import { bgpAsn } from '../model/services';
import { Interface, LinkEnd, Model, Relation, deviceInterfaces, ifaceKey, relationDevices } from '../model/types';
import { addrBig, compareAddr, inPrefix, networkOf as networkOfPrefix, prefixRange, prefixText } from './ipmath';
import { vrfKey, vrfName } from './routing';

type Emit = (f: { message: string; refs: string[]; at: { ref: string; field?: string } }) => void;

export interface MoreCheck {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  reads: string;
  run(model: Model, emit: Emit): void;
}

// ------------------------------------------------------------ helpers

const iref = (i: Interface): string => `iface:${i.device}:${i.id}`;

function endIface(model: Model, e: LinkEnd): Interface | undefined {
  return e.iface !== undefined ? model.index.interfaces.get(ifaceKey(e.device, e.iface)) : undefined;
}

function endName(e: LinkEnd): string {
  return e.iface !== undefined ? `${e.device}:${e.iface}` : e.device;
}

/** A speed as bits per second ("10G", "100M", "2.5 Gbit/s"); null when it can't be read. */
export function speedBps(s: string): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmMgGtT])?\s*(?:b|bps|bit\/s|bit)?\s*$/.exec(s);
  if (!m) return null;
  const mult: { [k: string]: number } = { k: 1e3, m: 1e6, g: 1e9, t: 1e12 };
  return Number(m[1]) * (m[2] ? mult[m[2].toLowerCase()] : 1);
}

/** Was the parameter written per device for this one (not as one shared value)? */
function relParamOwn(r: Relation, key: string, device: string): string | undefined {
  const own = r.attrs.find(([k]) => k === key + '.' + device);
  return own ? own[1] : undefined;
}

/** The base protocol of a relation (an alias such as ibgp gives bgp). */
export function baseProtocol(model: Model, r: Relation): string {
  return protocolBase(model.protocols, r.protocol);
}

/** An OSPF area as a number: "0", "0.0.0.0" and "10" / "0.0.0.10" compare equal. */
export function areaKey(s: string): string {
  const a = parsePrefix(s.trim(), false);
  if (a && a.version === 4 && s.indexOf('/') < 0) return String(Number(addrBig(a)));
  return /^[0-9]+$/.test(s.trim()) ? String(Number(s.trim())) : s.trim().toLowerCase();
}

function macKey(s: string): string {
  return s.toLowerCase().replace(/[^0-9a-f]/g, '');
}

/** The addresses of an interface with their prefixes (an address without a length is a host prefix). */
function ifaceNets(i: Interface): Array<{ text: string; addr: IpAddr; len: number; written: boolean }> {
  const out: Array<{ text: string; addr: IpAddr; len: number; written: boolean }> = [];
  for (const t of i.addresses) {
    const p = parsePrefix(t, false);
    if (p) out.push({ text: t, addr: { version: p.version, bytes: p.bytes }, len: p.prefix, written: t.indexOf('/') >= 0 });
  }
  return out;
}

/** Bytes an encapsulation adds to each packet (IPv4 outer header), by base protocol: the assumption the tunnel-MTU check states. */
export const ENCAP_OVERHEAD: { [protocol: string]: { bytes: number; what: string } } = {
  gre: { bytes: 24, what: 'GRE: 20 IP + 4 GRE' },
  ipip: { bytes: 20, what: 'IP-in-IP: 20 IP' },
  ipsec: { bytes: 73, what: 'IPsec ESP tunnel mode, worst case: 20 IP + 8 ESP + 16 IV + 15 padding + 2 trailer + 12 ICV' },
  wireguard: { bytes: 60, what: 'WireGuard: 20 IP + 8 UDP + 32 WireGuard' },
  vxlan: { bytes: 50, what: 'VXLAN: 14 Ethernet + 20 IP + 8 UDP + 8 VXLAN' },
  geneve: { bytes: 50, what: 'Geneve without options: 14 Ethernet + 20 IP + 8 UDP + 8 Geneve' },
  l2tp: { bytes: 40, what: 'L2TPv3 over UDP: 20 IP + 8 UDP + 12 L2TP' },
  gtp: { bytes: 36, what: 'GTP-U: 20 IP + 8 UDP + 8 GTP' },
};

/** Is an attribute key one that holds a virtual (gateway) address: ends in "virtual-ip", "virtual-ipv6" or "vip"? */
export function vipKey(k: string): boolean {
  return /(^|[-.])(virtual-ip|virtual-ipv6|vip)$/.test(k);
}

/** The addresses in an attribute value ("10.0.0.1", "10.0.0.1, 2001:db8::1"; a prefix length is dropped). */
export function addrsOf(v: string): IpAddr[] {
  return v
    .split(/[\s,;]+/)
    .map((t) => parseAddress(t.replace(/\/[0-9]+$/, '')))
    .filter((a): a is IpAddr => !!a);
}

/**
 * What a tunnel interface's packets carry on top of them, and the underlay
 * they leave by: the tunnel relations bound to it and the tunnels that carry
 * those (GRE over IPsec …), their overheads added up (ENCAP_OVERHEAD), and
 * the interface the tunnel is sourced from (else the device's port with the
 * smallest MTU on the links the stack rides on), when it has an MTU. Null
 * when no tunnel relation is bound to it or an encapsulation has no known
 * overhead (nothing is assumed then).
 */
export function tunnelBudget(model: Model, t: Interface): { stack: Relation[]; overhead: number; what: string[]; under?: Interface } | null {
  const stack: Relation[] = [];
  const add = (r: Relation): void => {
    if (stack.indexOf(r) >= 0 || r.category !== 'tunnel') return;
    stack.push(r);
    for (const o of r.over) {
      const c = model.index.relations.get(o);
      if (c) add(c);
    }
  };
  for (const r of model.relations) if (r.endpoints.some((e) => e.device === t.device && e.iface === t.id)) add(r);
  if (!stack.length) return null;
  const parts = stack.map((r) => ENCAP_OVERHEAD[baseProtocol(model, r)]);
  if (parts.some((p) => !p)) return null;
  const overhead = parts.reduce((s, p) => s + p.bytes, 0);
  let under: Interface | undefined = t.source && t.source.iface ? model.index.interfaces.get(ifaceKey(t.device, t.source.iface)) : undefined;
  if (!under || under.mtu === undefined) {
    under = undefined;
    for (const p of stack) {
      for (const o of p.over) {
        const l = model.index.links.get(o);
        if (!l) continue;
        for (const e of [l.a, l.b]) {
          const i = e.device === t.device ? endIface(model, e) : undefined;
          if (i && i.mtu !== undefined && (!under || (i.mtu as number) < (under.mtu as number))) under = i;
        }
      }
    }
  }
  const out: { stack: Relation[]; overhead: number; what: string[]; under?: Interface } = { stack, overhead, what: parts.map((p) => p.what) };
  if (under) out.under = under;
  return out;
}

function push<T>(m: Map<string, T[]>, name: string, v: T): void {
  const k = name.toLowerCase();
  if (!m.has(k)) m.set(k, []);
  (m.get(k) as T[]).push(v);
}

// ------------------------------------------------------------ the checks

export const MORE_CHECKS: MoreCheck[] = [
  {
    id: 'routing-policy',
    severity: 'warning',
    title: 'A routing policy names what the model does not have',
    reads: 'devices: protocols: <routing protocol>: advertise, default_route, redistribute, import, export; their connected networks and static routes; the protocol\u2019s relations',
    run(model, emit) {
      for (const d of model.devices) {
        for (const svc of d.services) {
          const pol = svc.policy;
          if (!pol) continue;
          const at = { ref: 'device:' + d.id, field: `protocols.${svc.id}` };
          const own = d.interfaces.concat(d.logical).flatMap((i) => i.addresses.map((a) => parsePrefix(a, false)).filter((p): p is NonNullable<typeof p> => !!p && p.prefix < (p.version === 4 ? 32 : 128)));
          const has = (t: string): boolean => {
            const p = parsePrefix(t);
            if (!p) return false;
            const net = prefixText(networkOfPrefix(p));
            return own.some((o) => prefixText(networkOfPrefix(o)) === net) || d.routes.some((r) => {
              const rp = parsePrefix(r.prefix);
              return !!rp && prefixText(networkOfPrefix(rp)) === net;
            });
          };
          for (const t of pol.advertise || []) if (!has(t)) emit({ message: `${d.id} advertises ${t} into ${svc.id}, but has no connected network or static route ${t}: it is not advertised`, refs: ['device:' + d.id], at });
          for (const src of pol.redistribute) if (src !== 'connected' && src !== 'static' && !d.services.some((x) => x.id === src)) emit({ message: `${d.id} redistributes ${src} into ${svc.id}, but does not enable ${src}: nothing is redistributed`, refs: ['device:' + d.id], at });
          const neighbours = new Set<string>();
          for (const r of model.relations) if (protocolBase(model.protocols, r.protocol) === svc.id && relationDevices(r).indexOf(d.id) >= 0) for (const x of relationDevices(r)) if (x !== d.id) neighbours.add(x);
          for (const dir of ['import', 'export'] as const) {
            const rules = pol[dir];
            rules.forEach((rule, k) => {
              if (rule.peer !== undefined && !neighbours.has(rule.peer)) emit({ message: `${d.id} ${svc.id} ${dir} rule ${k + 1} names ${rule.peer}, which is no ${svc.id} neighbour of ${d.id}: the rule never matches`, refs: ['device:' + d.id].concat(model.index.devices.has(rule.peer) ? ['device:' + rule.peer] : []), at });
            });
            if (rules.length && !rules.some((x) => x.prefix === undefined && x.peer === undefined)) emit({ message: `${d.id} ${svc.id} ${dir} filter has no catch-all rule: every route its rules don't match is denied (the implicit deny at the end); add {action: permit} or {action: deny} to say so`, refs: ['device:' + d.id], at });
          }
        }
      }
    },
  },
  {
    id: 'link-mtu-mismatch',
    severity: 'warning',
    title: 'MTU differs between the two ends of a cable',
    reads: 'interfaces: mtu; links',
    run(model, emit) {
      for (const l of model.links) {
        const a = endIface(model, l.a);
        const b = endIface(model, l.b);
        if (!a || !b || a.mtu === undefined || b.mtu === undefined || a.mtu === b.mtu) continue;
        emit({ message: `link ${l.id}: MTU ${a.mtu} at ${endName(l.a)}, ${b.mtu} at ${endName(l.b)}`, refs: ['link:' + l.id, iref(a), iref(b)], at: { ref: iref(a.mtu > b.mtu ? a : b), field: 'mtu' } });
      }
    },
  },
  {
    id: 'tunnel-mtu',
    severity: 'warning',
    title: 'Tunnel MTU too large for its underlay once encapsulated',
    reads: 'tunnel interfaces: mtu, source; the MTU of the source interface (or of the ports of the links in `over`); the tunnel relations bound to it and their `over` (protocols with a known overhead)',
    run(model, emit) {
      for (const d of model.devices) {
        for (const t of d.logical) {
          if (t.type !== 'tunnel' || t.mtu === undefined) continue;
          const b = tunnelBudget(model, t);
          if (!b || !b.under || b.under.mtu === undefined || t.mtu + b.overhead <= b.under.mtu) continue;
          emit({
            message: `tunnel ${d.id}:${t.id}: MTU ${t.mtu} plus ${b.overhead} bytes of encapsulation is ${t.mtu + b.overhead}, more than the MTU ${b.under.mtu} of its underlay ${b.under.id} (assumed overhead: ${b.what.join('; ')}); the largest MTU that fits is ${b.under.mtu - b.overhead}`,
            refs: [iref(t), iref(b.under)].concat(b.stack.map((r) => 'relation:' + r.id)),
            at: { ref: iref(t), field: 'mtu' },
          });
        }
      }
    },
  },
  {
    id: 'link-speed-mismatch',
    severity: 'warning',
    title: 'Port speeds that differ across a cable',
    reads: 'links: speed, a/b speed',
    run(model, emit) {
      for (const l of model.links) {
        const sa = l.a.speed;
        const sb = l.b.speed;
        const same = (x: string, y: string): boolean => {
          const p = speedBps(x);
          const q = speedBps(y);
          return p !== null && q !== null ? p === q : x.trim().toLowerCase() === y.trim().toLowerCase();
        };
        if (sa !== undefined && sb !== undefined && !same(sa, sb)) {
          emit({ message: `link ${l.id}: the port at ${endName(l.a)} is set to ${sa}, the one at ${endName(l.b)} to ${sb}`, refs: ['link:' + l.id], at: { ref: 'link:' + l.id, field: 'b.speed' } });
          continue;
        }
        for (const side of ['a', 'b'] as const) {
          const s = l[side].speed;
          if (s === undefined || l.speed === undefined || same(s, l.speed)) continue;
          emit({ message: `link ${l.id}: the port at ${endName(l[side])} is set to ${s}, the cable to ${l.speed}`, refs: ['link:' + l.id], at: { ref: 'link:' + l.id, field: side + '.speed' } });
        }
      }
    },
  },
  {
    id: 'link-duplex-mismatch',
    severity: 'error',
    title: 'Duplex that differs across a cable',
    reads: 'links: a/b duplex',
    run(model, emit) {
      for (const l of model.links) {
        if (!l.a.duplex || !l.b.duplex || l.a.duplex === l.b.duplex) continue;
        const auto = l.a.duplex === 'auto' || l.b.duplex === 'auto';
        emit({
          message: `link ${l.id}: duplex ${l.a.duplex} at ${endName(l.a)}, ${l.b.duplex} at ${endName(l.b)}` + (auto ? ' (a port set to auto facing a fixed setting usually falls back to half duplex)' : ''),
          refs: ['link:' + l.id],
          at: { ref: 'link:' + l.id, field: 'b.duplex' },
        });
      }
    },
  },
  {
    id: 'lag-member-speed',
    severity: 'warning',
    title: 'Member links of an aggregate with different speeds',
    reads: 'virtual interfaces: members; links: speed, a/b speed',
    run(model, emit) {
      for (const d of model.devices) {
        for (const agg of d.logical) {
          if (agg.members.length < 2) continue;
          const speeds: Array<{ port: string; speed: string; bps: number }> = [];
          for (const m of agg.members) {
            const lid = model.index.ifaceLink.get(ifaceKey(d.id, m));
            const l = lid ? model.index.links.get(lid) : undefined;
            if (!l) continue;
            const end = l.a.device === d.id && l.a.iface === m ? l.a : l.b;
            const s = end.speed !== undefined ? end.speed : l.speed;
            const bps = s !== undefined ? speedBps(s) : null;
            if (s !== undefined && bps !== null) speeds.push({ port: m, speed: s, bps });
          }
          if (speeds.length < 2 || speeds.every((x) => x.bps === speeds[0].bps)) continue;
          emit({
            message: `aggregate ${d.id}:${agg.id}: its member links have different speeds (${speeds.map((x) => `${x.port} ${x.speed}`).join(', ')})`,
            refs: [iref(agg)].concat(speeds.map((x) => `iface:${d.id}:${x.port}`)),
            at: { ref: iref(agg), field: 'members' },
          });
        }
      }
    },
  },
  {
    id: 'lag-peer-devices',
    severity: 'error',
    title: 'Aggregate whose member links end on several devices (and no MLAG pairs them)',
    reads: 'virtual interfaces: members; links; relations with protocol mlag (or vpc)',
    run(model, emit) {
      const mlag = model.relations.filter((r) => baseProtocol(model, r) === 'mlag');
      for (const d of model.devices) {
        for (const agg of d.logical) {
          if (agg.members.length < 2) continue;
          const peers: string[] = [];
          for (const m of agg.members) {
            const lid = model.index.ifaceLink.get(ifaceKey(d.id, m));
            const l = lid ? model.index.links.get(lid) : undefined;
            if (!l) continue;
            const far = l.a.device === d.id && l.a.iface === m ? l.b : l.a;
            if (peers.indexOf(far.device) < 0) peers.push(far.device);
          }
          if (peers.length < 2) continue;
          // a multi-chassis aggregate: its peers are together the members of an MLAG / vPC domain
          if (mlag.some((r) => peers.every((p) => relationDevices(r).indexOf(p) >= 0))) continue;
          peers.sort();
          emit({
            message: `aggregate ${d.id}:${agg.id}: its member links end on ${peers.length} devices (${peers.join(', ')}), and no MLAG relation pairs them`,
            refs: [iref(agg)].concat(peers.map((p) => 'device:' + p)),
            at: { ref: iref(agg), field: 'members' },
          });
        }
      }
    },
  },
  {
    id: 'lag-min-links',
    severity: 'warning',
    title: 'Aggregate that needs more links than it has',
    reads: 'virtual interfaces: members, min_links; links (cabling)',
    run(model, emit) {
      for (const d of model.devices) {
        for (const agg of d.logical) {
          if (agg.minLinks === undefined) continue;
          const cabled = agg.members.filter((m) => model.index.ifaceLink.has(ifaceKey(d.id, m))).length;
          if (agg.minLinks <= cabled) continue;
          emit({
            message: `aggregate ${d.id}:${agg.id} needs ${agg.minLinks} links up but has ${cabled} cabled member port${cabled === 1 ? '' : 's'}${cabled < agg.members.length ? ` (of ${agg.members.length})` : ''}: it can never be up`,
            refs: [iref(agg)],
            at: { ref: iref(agg), field: 'min_links' },
          });
        }
      }
    },
  },
  {
    id: 'link-subnet-mismatch',
    severity: 'error',
    title: 'Addresses at the two ends of a cable in different subnets',
    reads: 'interfaces: ip (with prefix length) at both ends of a link',
    run(model, emit) {
      for (const l of model.links) {
        const a = endIface(model, l.a);
        const b = endIface(model, l.b);
        if (!a || !b) continue;
        const na = ifaceNets(a).filter((x) => x.written);
        const nb = ifaceNets(b).filter((x) => x.written);
        for (const v of [4, 6] as const) {
          const xa = na.filter((x) => x.addr.version === v);
          const xb = nb.filter((x) => x.addr.version === v);
          if (!xa.length || !xb.length) continue;
          const shared = xa.some((x) => xb.some((y) => inPrefix({ ...x.addr, prefix: x.len }, y.addr) && inPrefix({ ...y.addr, prefix: y.len }, x.addr)));
          if (shared) continue;
          emit({
            message: `link ${l.id}: the IPv${v} addresses at its ends are in different subnets (${endName(l.a)} ${xa.map((x) => x.text).join(', ')}; ${endName(l.b)} ${xb.map((x) => x.text).join(', ')})`,
            refs: ['link:' + l.id, iref(a), iref(b)],
            at: { ref: iref(b), field: 'ip' },
          });
        }
      }
    },
  },
  {
    id: 'address-reserved',
    severity: 'error',
    title: 'IPv4 network or broadcast address used as an interface address',
    reads: 'interfaces: ip; networks: cidr (for an address written without prefix length)',
    run(model, emit) {
      for (const d of model.devices) {
        for (const i of deviceInterfaces(d)) {
          for (const x of ifaceNets(i)) {
            if (x.addr.version !== 4) continue;
            // the address's own prefix, or (without one) the networks containing it
            const lens = x.written ? [x.len] : model.networks.map((n) => (n.cidr ? parsePrefix(n.cidr) : null)).filter((p): p is NonNullable<typeof p> => !!p && p.version === 4 && inPrefix(p, x.addr)).map((p) => p.prefix);
            for (const len of lens) {
              if (len >= 31) continue;
              const r = prefixRange({ ...x.addr, prefix: len });
              const v = addrBig(x.addr);
              if (v !== r.first && v !== r.last) continue;
              emit({
                message: `${d.id}:${i.id}: ${x.text} is the ${v === r.first ? 'network' : 'broadcast'} address of ${prefixText({ ...x.addr, prefix: len })}, not a host address`,
                refs: [iref(i)],
                at: { ref: iref(i), field: 'ip' },
              });
              break;
            }
          }
        }
      }
    },
  },
  {
    id: 'duplicate-mac',
    severity: 'warning',
    title: 'The same MAC address on two interfaces',
    reads: 'interfaces: mac',
    run(model, emit) {
      const seen = new Map<string, Interface>();
      const all: Interface[] = [];
      for (const d of model.devices) all.push(...deviceInterfaces(d));
      all.sort((a, b) => (ifaceKey(a.device, a.id) < ifaceKey(b.device, b.id) ? -1 : 1));
      for (const i of all) {
        if (!i.mac) continue;
        const k = macKey(i.mac);
        if (k.length !== 12) continue;
        const first = seen.get(k);
        if (!first) seen.set(k, i);
        else emit({ message: `MAC address ${i.mac} is on ${first.device}:${first.id} and ${i.device}:${i.id}`, refs: [iref(i), iref(first)], at: { ref: iref(i), field: 'mac' } });
      }
    },
  },
  {
    id: 'ospf-area-mismatch',
    severity: 'error',
    title: 'OSPF area differs between the two ends',
    reads: 'relations with protocol ospf: attrs area.<device>',
    run(model, emit) {
      ospfCompare(model, emit, 'area', areaKey, (r, a, b, va, vb) => `OSPF ${r.id}: ${a} is in area ${va}, ${b} in area ${vb}`);
    },
  },
  {
    id: 'ospf-network-type-mismatch',
    severity: 'warning',
    title: 'OSPF network type differs between the two ends',
    reads: 'relations with protocol ospf: attrs network-type.<device>',
    run(model, emit) {
      ospfCompare(model, emit, 'network-type', (s) => s.trim().toLowerCase().replace(/[\s_]+/g, '-'), (r, a, b, va, vb) => `OSPF ${r.id}: network type ${va} at ${a}, ${vb} at ${b}`);
    },
  },
  {
    id: 'ospf-timer-mismatch',
    severity: 'error',
    title: 'OSPF hello or dead interval differs between the two ends',
    reads: 'relations with protocol ospf: attrs hello.<device>, dead.<device>',
    run(model, emit) {
      for (const key of ['hello', 'dead']) ospfCompare(model, emit, key, (s) => String(Number(s.replace(/s$/, ''))), (r, a, b, va, vb) => `OSPF ${r.id}: ${key} interval ${va} at ${a}, ${vb} at ${b} (an adjacency needs equal timers)`);
    },
  },
  {
    id: 'bgp-peer-as',
    severity: 'error',
    title: 'BGP peer AS that is not the other device’s AS',
    reads: 'relations with protocol bgp (ebgp, ibgp …): attrs peer-as.<device>; devices: protocols.bgp.asn',
    run(model, emit) {
      for (const r of model.relations) {
        if (baseProtocol(model, r) !== 'bgp') continue;
        const devs = relationDevices(r);
        if (devs.length !== 2) continue;
        for (const [d, other] of [[devs[0], devs[1]], [devs[1], devs[0]]]) {
          const peer = relParamOwn(r, 'peer-as', d);
          const oasn = bgpAsn(model.index.devices.get(other));
          if (peer === undefined || oasn === undefined || Number(peer) === oasn) continue;
          emit({ message: `BGP ${r.id}: ${d} expects ${other} in AS ${peer}, but ${other} is in AS ${oasn}`, refs: ['relation:' + r.id, 'device:' + d, 'device:' + other], at: { ref: 'relation:' + r.id, field: 'attrs' } });
        }
      }
    },
  },
  {
    id: 'bgp-session-type',
    severity: 'error',
    title: 'iBGP between different AS numbers, or eBGP within one',
    reads: 'relations with protocol ibgp or ebgp (or attrs type: ibgp / ebgp); devices: protocols.bgp.asn',
    run(model, emit) {
      for (const r of model.relations) {
        if (baseProtocol(model, r) !== 'bgp') continue;
        const t = r.protocol === 'ibgp' || r.protocol === 'ebgp' ? r.protocol : (r.attrs.find(([k]) => k === 'type') || ['', ''])[1].toLowerCase();
        if (t !== 'ibgp' && t !== 'ebgp') continue;
        const devs = relationDevices(r)
          .map((id) => ({ id, asn: bgpAsn(model.index.devices.get(id)) }))
          .filter((x) => x.asn !== undefined);
        if (devs.length < 2) continue;
        const asns = Array.from(new Set(devs.map((x) => x.asn as number)));
        if (t === 'ibgp' && asns.length > 1) emit({ message: `${r.id} is iBGP, but its devices are in different AS numbers (${devs.map((x) => `${x.id} AS ${x.asn}`).join(', ')})`, refs: ['relation:' + r.id].concat(devs.map((x) => 'device:' + x.id)), at: { ref: 'relation:' + r.id, field: 'protocol' } });
        if (t === 'ebgp' && asns.length === 1) emit({ message: `${r.id} is eBGP, but all its devices are in AS ${asns[0]}`, refs: ['relation:' + r.id].concat(devs.map((x) => 'device:' + x.id)), at: { ref: 'relation:' + r.id, field: 'protocol' } });
      }
    },
  },
  {
    id: 'tunnel-endpoint-mismatch',
    severity: 'error',
    title: 'Tunnel destination that is not the peer’s source',
    reads: 'tunnel relations between two tunnel interfaces; tunnel interfaces: source, destination; interfaces: ip',
    run(model, emit) {
      for (const r of model.relations) {
        if (r.category !== 'tunnel' || r.endpoints.length !== 2) continue;
        const [ta, tb] = r.endpoints.map((e) => (e.iface !== undefined ? model.index.interfaces.get(ifaceKey(e.device, e.iface)) : undefined));
        if (!ta || !tb || ta.type !== 'tunnel' || tb.type !== 'tunnel' || ta.device === tb.device) continue;
        for (const [x, y] of [[ta, tb], [tb, ta]]) {
          const dst = x.destination;
          if (!dst || !y.source) continue;
          // what the peer is sourced from: its source address, or the addresses of its source interface
          const srcIface = y.source.iface ? model.index.interfaces.get(ifaceKey(y.device, y.source.iface)) : undefined;
          const srcAddrs = y.source.address !== undefined ? [y.source.address] : srcIface ? srcIface.addresses : [];
          let why = '';
          if (dst.address !== undefined) {
            const a = parseAddress(dst.address.replace(/\/[0-9]+$/, ''));
            const own = srcAddrs.map((s) => parseAddress(s.replace(/\/[0-9]+$/, ''))).filter((v): v is IpAddr => !!v);
            if (!a || !own.length || own.some((o) => compareAddr(o, a) === 0)) continue;
            why = `${dst.address} is not the address ${y.device}:${y.id} is sourced from (${srcAddrs.join(', ')})`;
          } else if (dst.device !== undefined) {
            if (dst.device !== y.device) why = `it names ${dst.device}, but the tunnel's other end is on ${y.device}`;
            else if (dst.iface !== undefined && y.source.iface !== undefined && dst.iface !== y.source.iface && dst.iface !== y.id) why = `it names ${dst.device}:${dst.iface}, but ${y.device}:${y.id} is sourced from ${y.source.iface}`;
          }
          if (!why) continue;
          emit({ message: `tunnel ${r.id}: the destination of ${x.device}:${x.id} does not match its peer: ${why}`, refs: ['relation:' + r.id, iref(x), iref(y)], at: { ref: iref(x), field: 'destination' } });
        }
      }
    },
  },
  {
    id: 'tunnel-underlay',
    severity: 'warning',
    title: 'Tunnel whose underlay does not connect its endpoints',
    reads: 'tunnel relations: endpoints, over (links, networks and their members, relations and their endpoints)',
    run(model, emit) {
      for (const r of model.relations) {
        if (r.category !== 'tunnel' || !r.over.length) continue;
        const devs = relationDevices(r);
        if (devs.length < 2) continue;
        // the devices the underlay joins, as a graph
        const adj = new Map<string, Set<string>>();
        const join = (xs: string[]): void => {
          for (const x of xs) {
            if (!adj.has(x)) adj.set(x, new Set());
            for (const y of xs) if (x !== y) (adj.get(x) as Set<string>).add(y);
          }
        };
        for (const o of r.over) {
          const l = model.index.links.get(o);
          if (l) join([l.a.device, l.b.device]);
          const n = model.index.networks.get(o);
          if (n) {
            const members: string[] = [];
            for (const d of model.devices) for (const i of deviceInterfaces(d)) for (const a of i.addresses) {
              const p = n.cidr ? parsePrefix(n.cidr) : null;
              const x = parsePrefix(a, false);
              if (p && x && inPrefix(p, x) && members.indexOf(d.id) < 0) members.push(d.id);
            }
            join(members);
          }
          const c = model.index.relations.get(o);
          if (c) join(relationDevices(c));
        }
        const seen = new Set<string>([devs[0]]);
        const queue = [devs[0]];
        while (queue.length) {
          for (const n of Array.from(adj.get(queue.shift() as string) || [])) {
            if (seen.has(n)) continue;
            seen.add(n);
            queue.push(n);
          }
        }
        const cut = devs.filter((d) => !seen.has(d));
        if (!cut.length) continue;
        emit({
          message: `tunnel ${r.id}: what it is carried over (${r.over.join(', ')}) does not connect ${devs[0]} with ${cut.join(', ')}`,
          refs: ['relation:' + r.id].concat(r.over.map((o) => (model.index.links.has(o) ? 'link:' : model.index.networks.has(o) ? 'network:' : 'relation:') + o)),
          at: { ref: 'relation:' + r.id, field: 'over' },
        });
      }
    },
  },
  {
    id: 'vrf-name-case',
    severity: 'warning',
    title: 'VRF names that differ only in case',
    reads: 'interfaces: vrf; routes: vrf',
    run(model, emit) {
      // every place a VRF is named, by its name in lower case
      const by = new Map<string, Array<{ name: string; ref: string; field: string }>>();
      for (const d of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
        for (const i of deviceInterfaces(d)) if (i.vrf) push(by, i.vrf, { name: i.vrf, ref: iref(i), field: 'vrf' });
        for (const r of d.routes) if (r.vrf) push(by, r.vrf, { name: r.vrf, ref: 'route:' + r.device + ':' + r.index, field: 'vrf' });
      }
      by.forEach((uses) => {
        const names = Array.from(new Set(uses.map((u) => u.name))).sort();
        if (names.length < 2) return;
        // the spelling used most is taken as meant; the others are reported where they are written
        const count = (n: string): number => uses.filter((u) => u.name === n).length;
        const main = names.slice().sort((a, b) => count(b) - count(a) || (a < b ? -1 : 1))[0];
        for (const u of uses) {
          if (u.name === main) continue;
          emit({ message: `VRF "${u.name}" differs from "${main}" only in case: probably a typo (VRF names are compared exactly, so these are two VRFs)`, refs: [u.ref], at: { ref: u.ref, field: u.field } });
        }
      });
    },
  },
  {
    id: 'relation-vrf-mismatch',
    severity: 'warning',
    title: 'Relation between interfaces in different VRFs',
    reads: 'relation endpoints bound to interfaces; interfaces: vrf (compared only where both name a VRF: an interface in a VRF facing one without, as a provider edge facing a customer, is normal)',
    run(model, emit) {
      for (const r of model.relations) {
        const bound = r.endpoints.map((e) => (e.iface !== undefined ? model.index.interfaces.get(ifaceKey(e.device, e.iface)) : undefined)).filter((i): i is Interface => !!i && !!i.vrf);
        if (bound.length < 2) continue;
        const vrfs = Array.from(new Set(bound.map((i) => vrfKey(i.vrf))));
        if (vrfs.length < 2) continue;
        emit({
          message: `relation ${r.id} joins interfaces in different VRFs (${bound.map((i) => `${i.device}:${i.id} in ${vrfName(vrfKey(i.vrf))}`).join(', ')})`,
          refs: ['relation:' + r.id].concat(bound.map(iref)),
          at: { ref: 'relation:' + r.id, field: 'endpoints' },
        });
      }
    },
  },
];

/** Compare an OSPF parameter written per device at the two ends of an OSPF relation. */
function ospfCompare(model: Model, emit: Emit, key: string, norm: (s: string) => string, text: (r: Relation, a: string, b: string, va: string, vb: string) => string): void {
  for (const r of model.relations) {
    if (baseProtocol(model, r) !== 'ospf') continue;
    const devs = relationDevices(r);
    if (devs.length !== 2) continue;
    const va = relParamOwn(r, key, devs[0]);
    const vb = relParamOwn(r, key, devs[1]);
    if (va === undefined || vb === undefined || norm(va) === norm(vb)) continue;
    emit({ message: text(r, devs[0], devs[1], va, vb), refs: ['relation:' + r.id, 'device:' + devs[0], 'device:' + devs[1]], at: { ref: 'relation:' + r.id, field: 'attrs' } });
  }
}
