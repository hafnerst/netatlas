/**
 * Derived, read-only facts. Each is configured once in the YAML file and
 * computed here for every other view; none of it is ever written back:
 *
 *   configured (authoritative)            derived
 *   ------------------------------------  ------------------------------------
 *   network `cidr`, interface `ip`        members of a network (IP containment)
 *   network `vlan` (+ the two above)      VLAN of an interface address
 *   link end `mode`/`untagged`/`tagged`   the VLANs a cable carries at each
 *     + network `vlan`                    end, the networks of those VLANs,
 *                                         and how the two ends differ
 *   the VLANs of a virtual interface      the physical ports carrying them
 *     (its `vlan`, or the VLAN of the
 *     network of its address)
 *     + link end tagging
 *   interface `ip`                        which interfaces own an address
 *
 * Membership rule: an address belongs to a network when the network's prefix
 * contains it. The network's prefix is the authority; the prefix length
 * written on the interface is ignored. IPv4 and IPv6 never match each other.
 * An address that is not a valid IPv4/IPv6 address (with an optional, valid
 * prefix length) belongs to no network, and an interface with DHCP on has no
 * configured address, so it makes its device a member of nothing.
 *
 * Overlapping networks: an address inside the prefixes of several networks
 * (e.g. a /24 inside a /16) belongs to every one of them; nothing is chosen.
 * Where the distinction matters, the result is reported instead of guessed:
 * the VLAN of such an address is derived only when all those networks agree
 * on it, otherwise it is "ambiguous" (with a validation warning).
 *
 * Membership (containment) and link-end tagging (layer-2 carriage) are
 * separate facts: neither is derived from the other. The networks a cable
 * carries follow from its tagging and the networks' VLANs.
 */
import { IpPrefix, addrKey, parsePrefix, prefixContains } from './ip';
import { Interface, Link, LinkEnd, Model, Network, VLAN_MAX, VlanRange, deviceInterfaces, ifaceKey, isLoopback } from './types';

/** One assigned address that lies inside a network. */
export interface AddressMatch {
  device: string;
  iface: string;
  loopback: boolean;
  /** as written on the interface */
  address: string;
}

/** A device that is a member of a network, with every address that makes it one. */
export interface NetworkMember {
  device: string;
  matches: AddressMatch[];
}

export type DerivedVlan =
  /** no containing network defines a VLAN */
  | { state: 'none' }
  | { state: 'vlan'; vlan: number }
  /** containing networks define different VLANs: nothing is chosen */
  | { state: 'ambiguous'; vlans: number[] };

/** What one interface address is associated with. */
export interface AddressAssoc {
  /** as written */
  address: string;
  /** false: not a usable IPv4/IPv6 address, so it matches nothing */
  valid: boolean;
  /** ids of all networks containing the address, in model order */
  networks: string[];
  vlan: DerivedVlan;
}

/** An interface that has an address configured. */
export interface AddressOwner {
  device: string;
  iface: string;
}

export interface Derived {
  /** network id -> member devices, in device order (each device once) */
  members: Map<string, NetworkMember[]>;
  /** "device:iface" -> one entry per assigned address, in address order */
  addresses: Map<string, AddressAssoc[]>;
  /** canonical address (ip.addrKey, prefix length ignored) -> the interfaces that have it, in model order */
  owners: Map<string, AddressOwner[]>;
}

/** The valid prefix of a network as a list: empty while it is missing or invalid. */
export function networkPrefixes(n: Network): IpPrefix[] {
  const p = n.cidr !== undefined ? parsePrefix(n.cidr) : null;
  return p ? [p] : [];
}

/** Networks whose prefix contains `address` ("a.b.c.d", "a.b.c.d/len", IPv6 likewise). */
export function containingNetworks(address: string, networks: Network[]): Network[] {
  const a = parsePrefix(address, false);
  if (!a) return [];
  return networks.filter((n) => networkPrefixes(n).some((p) => prefixContains(p, a)));
}

/** The VLAN that follows from a set of containing networks. */
export function derivedVlan(networks: Network[]): DerivedVlan {
  const vlans: number[] = [];
  for (const n of networks) if (n.vlan !== undefined && vlans.indexOf(n.vlan) < 0) vlans.push(n.vlan);
  if (!vlans.length) return { state: 'none' };
  if (vlans.length === 1) return { state: 'vlan', vlan: vlans[0] };
  return { state: 'ambiguous', vlans: vlans.sort((p, q) => p - q) };
}

const cache = new WeakMap<Model, Derived>();

/** All derived facts of a model (computed once per model object). */
export function derive(model: Model): Derived {
  const known = cache.get(model);
  if (known) return known;
  const nets = model.networks.map((n) => ({ n, prefixes: networkPrefixes(n) }));
  const members = new Map<string, NetworkMember[]>();
  for (const { n } of nets) members.set(n.id, []);
  const addresses = new Map<string, AddressAssoc[]>();
  const owners = new Map<string, AddressOwner[]>();
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      const assocs: AddressAssoc[] = [];
      for (const address of i.addresses) {
        const a = parsePrefix(address, false);
        if (a) {
          const k = addrKey(a);
          const list = owners.get(k) || [];
          if (!list.some((o) => o.device === d.id && o.iface === i.id)) list.push({ device: d.id, iface: i.id });
          owners.set(k, list);
        }
        const inside = a ? nets.filter((x) => x.prefixes.some((p) => prefixContains(p, a))).map((x) => x.n) : [];
        assocs.push({ address, valid: !!a, networks: inside.map((n) => n.id), vlan: derivedVlan(inside) });
        for (const n of inside) {
          const list = members.get(n.id) as NetworkMember[];
          let m = list[list.length - 1];
          if (!m || m.device !== d.id) {
            m = { device: d.id, matches: [] };
            list.push(m);
          }
          m.matches.push({ device: d.id, iface: i.id, loopback: isLoopback(i), address });
        }
      }
      addresses.set(ifaceKey(d.id, i.id), assocs);
    }
  }
  const out = { members, addresses, owners };
  cache.set(model, out);
  return out;
}

/** The interfaces that have `address` configured (a prefix length on it is ignored), in model order. */
export function addressOwners(model: Model, address: string): AddressOwner[] {
  const a = parsePrefix(address, false);
  return a ? derive(model).owners.get(addrKey(a)) || [] : [];
}

export function networkMembers(model: Model, networkId: string): NetworkMember[] {
  return derive(model).members.get(networkId) || [];
}

export function interfaceAddresses(model: Model, device: string, iface: string): AddressAssoc[] {
  return derive(model).addresses.get(ifaceKey(device, iface)) || [];
}

/** Ids of the networks a device is a member of, in model order. */
export function deviceNetworks(model: Model, device: string): string[] {
  const d = derive(model);
  return model.networks.filter((n) => (d.members.get(n.id) as NetworkMember[]).some((m) => m.device === device)).map((n) => n.id);
}

/** Ids of the networks containing an address of one interface, in model order. */
export function interfaceNetworks(model: Model, device: string, iface: string): string[] {
  const ids = new Set<string>();
  for (const a of interfaceAddresses(model, device, iface)) for (const n of a.networks) ids.add(n);
  return model.networks.filter((n) => ids.has(n.id)).map((n) => n.id);
}

/** Read-only text of a derived VLAN; an ambiguity is spelled out, never resolved. */
export function derivedVlanText(v: DerivedVlan): string {
  if (v.state === 'vlan') return 'VLAN ' + v.vlan;
  if (v.state === 'ambiguous') return 'ambiguous: VLAN ' + v.vlans.join(' or ');
  return '';
}

/** Short VLAN text of a whole interface: every distinct result of its addresses. */
export function interfaceVlanText(assocs: AddressAssoc[]): string {
  const parts: string[] = [];
  for (const a of assocs) {
    const t = derivedVlanText(a.vlan);
    if (t && parts.indexOf(t) < 0) parts.push(t);
  }
  return parts.join(', ');
}

// ------------------------------------------------------- link-end tagging

/** The VLAN IDs of a list of ranges, each once, ascending. */
export function vlanIds(ranges: VlanRange[]): number[] {
  const seen = new Set<number>();
  for (const r of ranges) for (let v = Math.max(1, r.from); v <= Math.min(VLAN_MAX, r.to); v++) seen.add(v);
  return Array.from(seen).sort((p, q) => p - q);
}

/** IDs as the shortest list of ranges: "20,30,100-199" (ascending; adjacent IDs merged). */
export function vlanRangesText(ids: number[]): string {
  const xs = Array.from(new Set(ids)).sort((p, q) => p - q);
  const out: string[] = [];
  for (let i = 0; i < xs.length; ) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(j > i ? `${xs[i]}-${xs[j]}` : String(xs[i]));
    i = j + 1;
  }
  return out.join(',');
}

/** The VLANs a cable carries at one end: its untagged VLAN and its tagged ones, ascending. */
export function endVlans(e: LinkEnd): number[] {
  const out = vlanIds(e.tagged);
  if (e.untagged !== undefined && out.indexOf(e.untagged) < 0) out.push(e.untagged);
  return out.sort((p, q) => p - q);
}

/**
 * The tagging of a link end as the physical view writes it next to the
 * port: "U 10" (access), "U 1 · T 20,30,100-199" (trunk: native and tagged
 * VLANs), the mode alone when no VLAN is written, '' without a mode.
 */
export function endTagText(e: LinkEnd): string {
  if (!e.mode) return '';
  const parts: string[] = [];
  if (e.untagged !== undefined) parts.push('U ' + e.untagged);
  const t = vlanIds(e.tagged);
  if (t.length) parts.push('T ' + vlanRangesText(t));
  return parts.length ? parts.join(' · ') : e.mode;
}

/** The networks of the VLANs a link end carries (derived: the networks whose `vlan` is one of them), in model order. */
export function endNetworks(model: Model, e: LinkEnd): string[] {
  const vlans = endVlans(e);
  if (!vlans.length) return [];
  return model.networks.filter((n) => n.vlan !== undefined && vlans.indexOf(n.vlan) >= 0).map((n) => n.id);
}

/** The networks a cable carries at either end, in model order. */
export function linkNetworks(model: Model, l: Link): string[] {
  const ids = new Set(endNetworks(model, l.a).concat(endNetworks(model, l.b)));
  return model.networks.filter((n) => ids.has(n.id)).map((n) => n.id);
}

/**
 * How the layer-2 tagging of a link's two ends disagrees (null: it agrees).
 * Only what is written at both ends is compared: an end without a mode says
 * nothing about layer 2, and nothing is assumed for it.
 */
export interface TagMismatch {
  /** both ends have an untagged VLAN, and they differ */
  native: [number, number] | null;
  /** tagged at one end and not at the other (compared when both ends are trunks) */
  onlyA: number[];
  onlyB: number[];
  /** untagged at one end, tagged at the other */
  crossed: number[];
}

export function tagMismatch(a: LinkEnd, b: LinkEnd): TagMismatch | null {
  if (!a.mode || !b.mode) return null;
  const native: [number, number] | null = a.untagged !== undefined && b.untagged !== undefined && a.untagged !== b.untagged ? [a.untagged, b.untagged] : null;
  const ta = vlanIds(a.tagged);
  const tb = vlanIds(b.tagged);
  const trunks = a.mode === 'trunk' && b.mode === 'trunk';
  const onlyA = trunks ? ta.filter((v) => tb.indexOf(v) < 0) : [];
  const onlyB = trunks ? tb.filter((v) => ta.indexOf(v) < 0) : [];
  const crossed: number[] = [];
  if (a.untagged !== undefined && tb.indexOf(a.untagged) >= 0) crossed.push(a.untagged);
  if (b.untagged !== undefined && ta.indexOf(b.untagged) >= 0 && crossed.indexOf(b.untagged) < 0) crossed.push(b.untagged);
  crossed.sort((p, q) => p - q);
  return native || onlyA.length || onlyB.length || crossed.length ? { native, onlyA, onlyB, crossed } : null;
}

/** The differences of a TagMismatch in words, separated by "; ". */
export function tagMismatchText(m: TagMismatch): string {
  const out: string[] = [];
  if (m.native) out.push(`untagged VLAN ${m.native[0]} at end A, ${m.native[1]} at end B`);
  if (m.onlyA.length) out.push(`tagged only at end A: ${vlanRangesText(m.onlyA)}`);
  if (m.onlyB.length) out.push(`tagged only at end B: ${vlanRangesText(m.onlyB)}`);
  if (m.crossed.length) out.push(`untagged at one end and tagged at the other: ${vlanRangesText(m.crossed)}`);
  return out.join('; ');
}

/** Display name of a network id (its label; the id when it is unknown). */
export function networkName(model: Model, id: string): string {
  const n = model.index.networks.get(id);
  return n ? n.label : id;
}

// --------------------------------------------- associations of logical interfaces

/** The VLAN IDs of a virtual interface: the `vlan` written on it, or else those of the networks containing its addresses. */
export function interfaceVlans(model: Model, i: Interface): number[] {
  if (i.type !== 'virtual') return [];
  if (i.vlan !== undefined) return [i.vlan];
  const out: number[] = [];
  for (const a of interfaceAddresses(model, i.device, i.id)) if (a.vlan.state === 'vlan' && out.indexOf(a.vlan.vlan) < 0) out.push(a.vlan.vlan);
  return out.sort((p, q) => p - q);
}

/** A physical port whose link end carries a VLAN (untagged or tagged). */
export interface VlanPort {
  iface: string;
  link: string;
  vlan: number;
  tagged: boolean;
}

/**
 * The physical ports of a device that carry one of `vlans`: the ports whose
 * end of a link has the VLAN untagged or tagged. Derived from the links; in
 * link order, then VLAN order.
 */
export function portsCarryingVlans(model: Model, device: string, vlans: number[]): VlanPort[] {
  const out: VlanPort[] = [];
  if (!vlans.length) return out;
  const want = vlans.slice().sort((p, q) => p - q);
  for (const l of model.links) {
    for (const e of [l.a, l.b]) {
      if (e.device !== device || !e.iface) continue;
      const tagged = vlanIds(e.tagged);
      for (const v of want) {
        if (e.untagged === v) out.push({ iface: e.iface, link: l.id, vlan: v, tagged: false });
        else if (tagged.indexOf(v) >= 0) out.push({ iface: e.iface, link: l.id, vlan: v, tagged: true });
      }
    }
  }
  return out;
}

/** The ports carrying the VLANs of a virtual interface (read-only; nothing is configured for it). */
export function interfaceVlanPorts(model: Model, i: Interface): VlanPort[] {
  return portsCarryingVlans(model, i.device, interfaceVlans(model, i));
}

/**
 * Interfaces of the same device that an interface is associated with, in
 * either direction, as ids:
 *   a virtual interface  -> its member ports and the ports carrying its VLANs;
 *   a tunnel             -> the interface it is sourced from;
 *   any interface        -> the aggregates it is a member of, the virtual
 *                           interfaces whose VLANs it carries, the tunnels
 *                           sourced from it.
 */
export function associatedInterfaces(model: Model, i: Interface): string[] {
  const d = model.index.devices.get(i.device);
  if (!d) return [];
  const out: string[] = [];
  const add = (id: string | undefined): void => {
    if (id !== undefined && id !== i.id && out.indexOf(id) < 0 && model.index.interfaces.has(ifaceKey(i.device, id))) out.push(id);
  };
  for (const m of i.members) add(m);
  for (const p of interfaceVlanPorts(model, i)) add(p.iface);
  if (i.source) add(i.source.iface);
  for (const o of d.logical) {
    if (o.id === i.id) continue;
    if (o.members.indexOf(i.id) >= 0) add(o.id);
    if (o.source && o.source.iface === i.id) add(o.id);
    if (i.type === 'physical' && interfaceVlanPorts(model, o).some((p) => p.iface === i.id)) add(o.id);
  }
  return out;
}
